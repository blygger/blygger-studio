/**
 * Resetting the owner's password must remove the old browser's power to delegate.
 * Rejecting old bearer tokens alone would leave a stale cookie able to mint new ones.
 *
 * Contract: decision #31 requires an old owner session to lose access after a
 * password reset. The user confirmed this rule during review. Delegated token
 * survival is independent: decision #31 and the user ruling keep existing tokens
 * valid and require explicit revoke-all. Signing-secret rotation remains separate.
 * OWASP recommends session invalidation around credential changes:
 * https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#renew-the-session-id-after-any-privilege-level-change
 * Model: an old cookie under a changed password cannot issue a grant; a fresh login
 * with the new password can read protected settings. No cookie decoder predicts it.
 * History grammar: login, change only OWNER_PASSWORD, old-cookie mint and fresh login.
 * Driver: real makeApp routes with replaced environment bindings and unchanged
 * signing configuration. Refinement: mint401/no token and fresh login302/read200.
 * Limits: a fixed configuration cutover witness, not evidence that all deployed
 * isolates receive a secret update simultaneously.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { makeApp } from '../src/index.ts';
import { flow } from './oauth-flow-driver.ts';
it('cannot use an old owner cookie to mint fresh grants after resetting the root password', async () => {
  const app = makeApp('/blyg'), base = 'https://owner-reset.example.test';
  const request = async (path: string, bindings: typeof env, init: RequestInit = {}) => {
    const ctx = createExecutionContext(), headers = new Headers(init.headers); headers.set('CF-Connecting-IP', '198.51.100.234');
    const response = await app.fetch(new Request(base + path, { ...init, headers }), bindings, ctx); await waitOnExecutionContext(ctx); return response;
  };
  const loggedIn = await request('/blyg/studio/login', env, { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
  expect(loggedIn.status).toBe(302); const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0];
  const changed = { ...env, OWNER_PASSWORD: env.OWNER_PASSWORD + '-reset' };
  const mint = await request('/blyg/api/authorizations', changed, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'old browser', scope: ['owner:read'], resource: 'api' }) });
  expect(mint.status).toBe(401); expect(await mint.json()).not.toHaveProperty('accessToken');
  const fresh = await request('/blyg/studio/login', changed, { method: 'POST', body: new URLSearchParams({ password: changed.OWNER_PASSWORD }) });
  expect(fresh.status).toBe(302);
  expect((await request('/blyg/api/settings', changed, { headers: { cookie: fresh.headers.get('set-cookie')!.split(';')[0] } })).status).toBe(200);
});


// A reset changes browser authority, not the permissions or lifetime of approved
// clients. Exercise both API and MCP resources, then the separate revoke-all act.
it('preserves API and MCP grants after password reset and lists them for explicit revoke-all', async () => {
  const app = makeApp('/blyg'), base = 'https://reset-client-grants.example.test';
  const request = async (path: string, bindings: typeof env, init: RequestInit = {}) => {
    const ctx = createExecutionContext(), headers = new Headers(init.headers); headers.set('CF-Connecting-IP', '198.51.100.235');
    const response = await app.fetch(new Request(base + path, { ...init, headers }), bindings, ctx); await waitOnExecutionContext(ctx); return response;
  };
  const login = async (bindings: typeof env) => {
    const response = await request('/blyg/studio/login', bindings, { method: 'POST', body: new URLSearchParams({ password: bindings.OWNER_PASSWORD }) });
    expect(response.status).toBe(302); return response.headers.get('set-cookie')!.split(';')[0];
  };
  const cookie = await login(env), grants: { resource: string; accessToken: string; authorization: { id: string; expiresAt: number; scope: string[] } }[] = [];
  for (const resource of ['api', 'mcp']) {
    const response = await request('/blyg/api/authorizations', env, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'reset-' + resource, scope: ['owner:read'], resource }) });
    expect(response.status).toBe(200); grants.push({ resource, ...await response.json() as Omit<typeof grants[number], 'resource'> });
  }
  const changed = { ...env, OWNER_PASSWORD: env.OWNER_PASSWORD + '-reset' };
  const read = (grant: typeof grants[number]) => request(grant.resource === 'api' ? '/blyg/api/settings' : '/blyg/studio/mcp', changed, grant.resource === 'api'
    ? { headers: { Authorization: 'Bearer ' + grant.accessToken } }
    : { method: 'POST', headers: { Authorization: 'Bearer ' + grant.accessToken, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  for (const grant of grants) expect((await read(grant)).status, 'password reset must preserve delegated access').toBe(200);
  expect((await request('/blyg/api/authorizations', changed, { headers: { cookie } })).status).toBe(401);
  const fresh = await login(changed);
  const listing = await (await request('/blyg/api/authorizations', changed, { headers: { cookie: fresh } })).json() as { items: typeof grants[number]['authorization'][] };
  for (const grant of grants) expect(listing.items.find(item => item.id === grant.authorization.id)).toMatchObject(grant.authorization);
  expect((await request('/blyg/api/authorizations', changed, { method: 'DELETE', headers: { cookie: fresh } })).status).toBe(200);
  for (const grant of grants) expect((await read(grant)).status, 'explicit revoke-all must still deny surviving grants').toBe(401);
});


// Refresh credentials are delegated authority too. A fresh owner login must see
// the same grant and deadline after a client refreshes across the password reset.
it('preserves native OAuth access and refresh credentials across password reset', async () => {
  const f = await flow(), approved = await f.decide('browser-a', true);
  expect(approved.status).toBe(302);
  const issued = await f.token(new URL(approved.headers.get('location')!).searchParams.get('code')!);
  expect(issued.status).toBe(200);
  const original = await issued.json() as { access_token: string; refresh_token: string };
  const before = await (await f.request('/blyg/api/authorizations', { headers: { cookie: f.owner } })).json() as { items: { id: string; clientId: string; expiresAt: number }[] };
  const grant = before.items.find(value => value.clientId === f.client.client_id)!;
  // Advance within the old access token's lifetime. Same-second refresh would
  // not distinguish a mistakenly renewed grant deadline from the original one.
  const resetAt = Date.now() + 60_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => resetAt);
  try {
    const changed = { ...env, OWNER_PASSWORD: env.OWNER_PASSWORD + '-reset' };
    expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + original.access_token } }, changed)).status, 'password reset must preserve OAuth access').toBe(200);
    const refreshed = await f.request(f.issuer + '/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: original.refresh_token, client_id: f.client.client_id, resource: f.base + '/blyg/api' }),
    }, changed);
    expect(refreshed.status, 'password reset must preserve OAuth refresh').toBe(200);
    const successor = await refreshed.json() as { access_token: string };
    expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + successor.access_token } }, changed)).status).toBe(200);
    const loggedIn = await f.request('/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: changed.OWNER_PASSWORD }) }, changed);
    expect(loggedIn.status).toBe(302);
    const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0];
    const after = await (await f.request('/blyg/api/authorizations', { headers: { cookie } }, changed)).json() as typeof before;
    expect(after.items.find(value => value.id === grant.id)).toMatchObject(grant);
    expect((await f.request('/blyg/api/authorizations', { method: 'DELETE', headers: { cookie } }, changed)).status).toBe(200);
    for (const token of [original.access_token, successor.access_token]) expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + token } }, changed)).status).toBe(401);
  } finally { clock.mockRestore(); }
});

// Native OAuth cookies can outlive the separate owner cookie. They must never
// substitute for password-session authority at a noninteractive authorization.
// OIDC Core §3.1.2.1 requires login_required when prompt=none needs owner login.
// https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest
it('does not let stale native browser cookies authorize silently after password reset', async () => {
  const f = await flow(), approved = await f.decide('browser-a', true);
  expect(approved.status).toBe(302);
  const url = new URL(f.authorize); url.searchParams.set('prompt', 'none');
  const cookie = f.owner + '; ' + f.binding;
  const before = await f.request(url.href, { headers: { cookie } });
  expect(new URL(before.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  const changed = { ...env, OWNER_PASSWORD: env.OWNER_PASSWORD + '-reset' };
  const response = await f.request(url.href, { headers: { cookie } }, changed);
  expect(response.status).toBe(302);
  const result = new URL(response.headers.get('location')!).searchParams;
  expect(result.get('code'), 'stale browser sessions cannot silently authorize after reset').toBeNull();
  expect(result.get('error'), 'stale owner sessions must require password login').toBe('login_required');
});
