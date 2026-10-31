/**
 * Token lifetimes and owner authority are separate clocks and trust boundaries.
 * A recreated owner bridge must not extend a grant or preserve a reset owner's power.
 *
 * Contract: local OAuth access lasts one hour; offline grants have an absolute
 * thirty-day deadline. Root reset invalidates delegated authority. Native refresh
 * revocation initially leaves a signed JWT valid; attempted reuse then triggers
 * Blygger's stronger grant-family revocation. RFC7009 permits token-type limits:
 * https://www.rfc-editor.org/rfc/rfc7009.html#section-2.1
 * JWT expiry is an exclusive acceptance boundary (RFC7519 §4.1.4):
 * https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1.4
 * OIDC authentication age is defined independently of a recreated session:
 * https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest
 * Model: explicit deadline neighbors and independent root/configuration changes.
 * History grammar: issue/revoke/reuse, cookie-secret cutover, missing configuration,
 * forged consent, native schema failure and offline renewal at T-1/T.
 * Driver: public Worker flows; selected native handler probes exercise consent
 * binding directly. Fake Date controls deadlines without replacing provider state.
 * Refinement: HTTP decisions and cookie absence; D1 observes schema, rollback and
 * native expiry. A DB expiry read is a boundary locator, not an independent proof
 * of correct configured duration. The fixed grant witness checks that duration.
 * Limits: no full OIDC profile matrix or every concurrent refresh schedule.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { makeApp } from '../src/index.ts';
import { authorizationServer } from '../src/oauth.ts';
import { flow } from './oauth-flow-driver.ts';
import type { Env } from '../src/types.ts';

async function issue() {
  const f = await flow();
  const approval = await f.decide('browser-a', true);
  const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
  const response = await f.token(code); expect(response.status).toBe(200);
  const tokens = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
  return { ...f, code, tokens };
}
const refresh = (f: Awaited<ReturnType<typeof issue>>) => f.request(f.issuer + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: f.tokens.refresh_token, resource: f.base + '/blyg/api' }) });
async function withEnv(url: string, currentEnv: Env, init: RequestInit = {}) {
  const ctx = createExecutionContext(), headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', '198.51.100.230');
  const response = await makeApp('/blyg').fetch(new Request(url, { ...init, headers }), currentEnv, ctx);
  await waitOnExecutionContext(ctx); return response;
}

describe('native auth lifecycle receiving boundaries', () => {
  it('reports unsupported JWT revocation and separates refresh revocation from access validity', async () => {
    const f = await issue();
    const revoke = (token: string, hint: string) => f.request(f.issuer + '/oauth2/revoke', { method: 'POST', body: new URLSearchParams({ client_id: f.client.client_id, token, token_type_hint: hint }) });
    const jwt = await revoke(f.tokens.access_token, 'access_token');
    expect(jwt.status).toBe(400); expect(await jwt.json()).toMatchObject({ error: 'unsupported_token_type' });
    expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + f.tokens.access_token } })).status).toBe(200);
    expect((await revoke(f.tokens.refresh_token, 'refresh_token')).status).toBe(200);
    expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + f.tokens.access_token } })).status).toBe(200);
    expect((await refresh(f)).status).toBe(400);
    expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + f.tokens.access_token } })).status).toBe(401);
  });

  it('keeps authenticated server API issuance separate from an exhausted public DCR budget', async () => {
    const f = await flow();
    for (let i = 0; i < 4; i++) expect((await f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [f.redirect], token_endpoint_auth_method: 'none' }) })).status).toBe(201);
    expect((await f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [f.redirect], token_endpoint_auth_method: 'none' }) })).status).toBe(429);
    const manual = await f.request('/blyg/api/authorizations', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'authenticated API bypass', scope: ['owner:read'], resource: 'api' }) });
    expect(manual.status).toBe(200); expect(await manual.json()).toHaveProperty('access_token');
    expect((await f.request('/blyg/api/authorizations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
  });

  it('rejects hostile native consent origins and false wrapper owner credentials', async () => {
    const f = await flow(), server = await authorizationServer(f.issuer, env);
    const authorization = await server.handler(new Request(f.authorize, { headers: { cookie: f.binding } }));
    expect(authorization.status).toBe(302);
    const signedQuery = new URL(authorization.headers.get('location')!, f.base).search.slice(1);
    for (const origin of ['https://attacker.example.test', 'http://localhost:3000']) {
      const native = await server.handler(new Request(f.issuer + '/oauth2/consent', { method: 'POST', headers: { cookie: f.binding, Origin: origin, 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.231' }, body: JSON.stringify({ accept: true, oauth_query: signedQuery }) }));
      expect(native.status).toBe(403);
    }
    const falseCredential = await server.handler(new Request(f.issuer + '/oauth2/consent', { method: 'POST', headers: { cookie: 'better-auth.session_token=bogus', Origin: f.base, 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.232' }, body: JSON.stringify({ accept: true, oauth_query: signedQuery }) }));
    expect(falseCredential.status).toBe(401);
    const tampered = new URLSearchParams(signedQuery); tampered.set('scope', 'owner:manage');
    const forgedConsent = await server.handler(new Request(f.issuer + '/oauth2/consent', { method: 'POST', headers: { cookie: f.binding, Origin: f.base, 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.234' }, body: JSON.stringify({ accept: true, oauth_query: tampered.toString() }) }));
    expect(forgedConsent.status).toBe(400);
    expect((await f.request(f.authorize, { headers: { cookie: 'blyg_session=bogus' } })).status).toBe(302);
    expect((await f.request(f.issuer + '/consent', { method: 'POST', headers: { cookie: 'blyg_session=bogus' }, body: new URLSearchParams({ handle: f.handle, decision: 'allow' }) })).status).toBe(401);
  });

  it('rejects a pending code and old access token after cookie-secret cutover', async () => {
    const f = await issue(), pending = await flow();
    const approval = await pending.decide('browser-a', true);
    const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
    const rotated = { ...env, COOKIE_SECRET: env.COOKIE_SECRET + '-lifecycle-rotation' };
    const exchange = await withEnv(pending.issuer + '/oauth2/token', rotated, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: pending.client.client_id, redirect_uri: pending.redirect, resource: pending.base + '/blyg/api', code_verifier: pending.verifier }) });
    expect(exchange.status).toBe(400);
    expect((await withEnv(f.base + '/blyg/api/settings', rotated, { headers: { Authorization: 'Bearer ' + f.tokens.access_token } })).status).toBe(401);
  });

  it('expires issued OAuth access at the exact one-hour JWT deadline', async () => {
    const f = await issue();
    const claims = JSON.parse(atob(f.tokens.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp: number };
    expect(f.tokens.expires_in).toBe(3600);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(claims.exp * 1000 - 1);
      expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + f.tokens.access_token } })).status).toBe(200);
      vi.setSystemTime(claims.exp * 1000);
      expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + f.tokens.access_token } })).status).toBe(401);
    } finally { vi.useRealTimers(); }
  });

  it('rejects refresh at the exact native 30-day deadline', async () => {
    const f = await issue();
    const row = await env.DB.prepare('SELECT expiresAt FROM oauthRefreshToken WHERE clientId=?').bind(f.client.client_id).first<{ expiresAt: string | number }>();
    expect(row).not.toBeNull();
    const expiry = new Date(row!.expiresAt).getTime();
    expect(Number.isFinite(expiry)).toBe(true);
    expect(expiry).toBeGreaterThan(Date.now());
    vi.useFakeTimers({ toFake: ['Date'] });
    try { vi.setSystemTime(expiry); expect((await refresh(f)).status).toBe(400); }
    finally { vi.useRealTimers(); }
  });

  it('retains the mounted request host as issuer rather than taking forwarded host', async () => {
    for (const origin of ['https://installation-a.example.test', 'https://installation-b.example.test']) {
      const response = await withEnv(origin + '/blyg/studio/auth/.well-known/openid-configuration', env, { headers: { 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' } });
      expect(await response.json()).toMatchObject({ issuer: origin + '/blyg/studio/auth' });
    }
  });

  it('has the native deployed schema and rolls back a failed D1 batch', async () => {
    for (const table of ['user', 'session', 'account', 'verification', 'jwks', 'oauthClient', 'oauthResource', 'oauthClientResource', 'oauthRefreshToken', 'oauthAccessToken', 'oauthConsent', 'oauthClientAssertion', 'rateLimit', 'oauth_records', 'oauth_state', 'oauth_authorizations', 'oauth_revocations']) {
      const columns = await env.DB.prepare(`PRAGMA table_info("${table}")`).all(); expect(columns.results.length, table).toBeGreaterThan(0);
    }
    await expect(env.DB.batch([
      env.DB.prepare('CREATE TABLE auth_failed_migration_probe (id TEXT PRIMARY KEY)'),
      env.DB.prepare("INSERT INTO auth_failed_migration_probe VALUES ('one')"),
      env.DB.prepare("INSERT INTO auth_failed_migration_probe VALUES ('one')"),
    ])).rejects.toThrow();
    expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_failed_migration_probe'").first()).toBeNull();
  });

  it('fails closed instead of issuing an owner cookie with a missing wrapping secret', async () => {
    const response = await withEnv('https://missing-secret.example.test/blyg/studio/login', { ...env, COOKIE_SECRET: '' }, { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it.each(['', undefined])('fails closed with missing owner password %s', async password => {
    const response = await withEnv('https://missing-owner.example.test/blyg/studio/login', { ...env, OWNER_PASSWORD: password } as Env, { method: 'POST', body: new URLSearchParams({ password: '' }) });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('keeps an offline refresh usable one second before its fixed thirty-day grant deadline', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    try {
      const f = await issue(), nativeFlow = await issue(); vi.setSystemTime(now + 2591999 * 1000);
      const response = await refresh(f);
      if (response.status === 500) {
        const server = await authorizationServer(nativeFlow.issuer, env);
        const native = await server.handler(new Request(nativeFlow.issuer + '/oauth2/token', { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.233' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: nativeFlow.client.client_id, refresh_token: nativeFlow.tokens.refresh_token, resource: nativeFlow.base + '/blyg/api' }) }));
        const value = await native.json() as { access_token?: string };
        let rejected: { name?: string; status?: string; body?: { error?: string; error_description?: string } } | undefined;
        try { if (value.access_token) await server.api.delegatedAccess({ body: { token: value.access_token } }); }
        catch (error) { rejected = error as typeof rejected; }
        // These bounded fields contain no token, code, key, password or stack.
        console.warn('offline-refresh diagnostic', JSON.stringify({ publicStatus: response.status, nativeStatus: native.status, name: rejected?.name, status: rejected?.status, error: rejected?.body?.error, description: rejected?.body?.error_description }));
      }
      expect(response.status).toBe(200);
      const renewed = await response.json() as { access_token: string; refresh_token: string };
      expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + renewed.access_token } })).status).toBe(200);
      vi.setSystemTime(now + 2592000 * 1000);
      expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + renewed.access_token } })).status).toBe(401);
      expect((await f.request(f.issuer + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: renewed.refresh_token, resource: f.base + '/blyg/api' }) })).status).toBe(400);
    } finally { vi.useRealTimers(); }
  });

  it.each([undefined, '', 'b'.repeat(43)])('rejects omitted, empty or grammatically valid wrong verifier %s', async verifier => {
    const f = await flow(), approval = await f.decide('browser-a', true);
    const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: f.client.client_id, redirect_uri: f.redirect, resource: f.base + '/blyg/api' });
    if (verifier !== undefined) form.set('code_verifier', verifier);
    const response = await f.request(f.issuer + '/oauth2/token', { method: 'POST', body: form });
    expect(response.status).toBe(400);
    const value = await response.json() as { access_token?: string; error?: string };
    expect(value.access_token).toBeUndefined(); expect(value.error).toBeTruthy();
  });

});
