/**
 * A PKCE hash match must not make malformed verifier syntax valid.
 * Session reconstruction must also preserve the age of the owner's password check.
 *
 * Contract: RFC7636 §4.1/§4.2 define verifier/challenge syntax; OIDC Core defines
 * prompt and max_age, not the time a wrapper happens to recreate a session:
 * https://www.rfc-editor.org/rfc/rfc7636.html#section-4.1
 * https://www.rfc-editor.org/rfc/rfc7636.html#section-4.2
 * https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest
 * RFC9700 §4.14.2 motivates rotation/replay defense:
 * https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2
 * Model: literal syntax boundaries, authentication-age relations and permitted race
 * outcomes. At most one rotation returns200; zero winners are safe if replay has
 * already revoked the grant. An uncontested neighbor must still issue successfully.
 * History grammar: short/long/punctuated PKCE inputs, matching malformed hashes,
 * concurrent reuse, old legacy cookies, same-second continuation and forged origins.
 * Driver: public flow routes; fake Date fixes old-login and same-second boundaries.
 * Refinement: protocol errors, continuation paths, cookie/session absence and denied
 * access after settled replay. Metadata tests record both working mounted URLs and
 * missing host-root routes;404 is a known profile limit, not conformance success.
 * Limits: the separate controlled two-isolate driver forces one race schedule.
 * This suite does not establish every schedule or full optional OIDC conformance.
 * The race uses one grant. Native refresh-family cleanup spans client/owner;
 * application grant tombstones do not make that native cleanup grant-isolated.
 */
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { flow } from './oauth-flow-driver.ts';

async function approved() {
  const f = await flow(), accepted = await f.decide('browser-a', true);
  expect(accepted.status).toBe(302);
  return { ...f, code: new URL(accepted.headers.get('location')!).searchParams.get('code')! };
}
const challenge = async (verifier: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
describe('OAuth implementation source boundaries', () => {
  // PKCE has two independent laws: permitted syntax and S256 binding. A matching
  // hash of an invalid verifier satisfies binding but must still fail syntax.
  // The valid neighbor below keeps this from becoming a blanket-denial oracle.
  it.each(['short', 'a'.repeat(129), 'a'.repeat(42) + '!'])('rejects malformed PKCE authorization challenge grammar %s', async value => {
    const f = await flow(), url = new URL(f.authorize); url.searchParams.set('code_challenge', value);
    const response = await f.request(url.href, { headers: { cookie: f.owner } });
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get('location')!);
    expect(callback.origin).toBe(new URL(f.redirect).origin);
    expect(callback.searchParams.get('error')).toBe('invalid_request');
    expect(callback.searchParams.has('code')).toBe(false);
  });
  it.each(['short', 'a'.repeat(129), 'a'.repeat(42) + '!'])('rejects malformed verifier even when its S256 hash matches the bound challenge %s', async verifier => {
    const f = await flow({ authorize: { code_challenge: await challenge(verifier) } });
    const accepted = await f.decide('browser-a', true), code = new URL(accepted.headers.get('location')!).searchParams.get('code')!;
    const response = await f.token(code, { code_verifier: verifier });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });
  it.each([true, false])('shows the grant lifetime and discloses offline consent only when requested (%s)', async offline => {
    const f = await flow({ scope: 'openid owner:read owner:draft' + (offline ? ' offline_access' : '') });
    const response = await f.request(f.authorize, { headers: { cookie: f.owner } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    const html = await response.text();
    expect(/Access tokens last one hour/.test(html)).toBe(true);
    if (offline) expect(/30 days/.test(html)).toBe(true);
    expect(/requests offline access/.test(html)).toBe(offline);
  });
  it('allows a valid PKCE grammar neighbor', async () => {
    const f = await approved(); expect((await f.token(f.code)).status).toBe(200);
  });
  it('permits at most one concurrent rotation and revokes the active descendant on detected old-token reuse', async () => {
    const f = await approved(), issued = await (await f.token(f.code)).json() as { refresh_token: string; access_token: string };
    const refresh = (token: string) => f.request(f.issuer + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: token, resource: f.base + '/blyg/api' }) });
    const responses = await Promise.all([refresh(issued.refresh_token), refresh(issued.refresh_token)]);
    const winners = responses.filter(response => response.status === 200);
    expect(winners.length).toBeLessThanOrEqual(1);
    expect(responses.every(response => response.status === 200 || response.status === 400)).toBe(true);
    const winner = winners.length ? await winners[0].json() as { refresh_token: string } : undefined;
    // Repeat the old token after both operations have settled, so this witness
    // does not mistake one race-loser response for proof of compromised-grant invalidation.
    const replay = await refresh(issued.refresh_token); expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
    if (winner) expect((await refresh(winner.refresh_token)).status).toBe(400);
    // Replay may settle before the concurrent winner returns. It is safe to
    // reject both, but not to leave either access credential usable afterward.
    const access = await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + issued.access_token } });
    expect(access.status).toBe(401);
  });
  it('uses registration metadata error for an unknown requested scope', async () => {
    const f = await flow();
    const response = await f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [f.redirect], token_endpoint_auth_method: 'none', scope: 'unknown-source-oracle-scope' }) });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: 'invalid_client_metadata' });
  });
  it('keeps discovery mounted without claiming the unselected RFC8414 host-root convention', async () => {
    const f = await flow();
    const mounted = await f.request(f.issuer + '/.well-known/openid-configuration');
    expect(mounted.status).toBe(200); expect(await mounted.json()).toMatchObject({ issuer: f.issuer });
    expect((await f.request('/.well-known/oauth-authorization-server/blyg/studio/auth')).status).toBe(404);
  });
  it('publishes usable challenge-linked MCP resource metadata while leaving host-root discovery unselected', async () => {
    const f = await flow(), response = await f.request('/blyg/studio/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
    const url = response.headers.get('www-authenticate')!.match(/resource_metadata="([^"]+)"/)![1];
    expect(new URL(url).pathname.startsWith('/blyg/studio/auth/')).toBe(true);
    const metadata = await f.request(url); expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: f.base + '/blyg/studio/mcp', authorization_servers: [f.issuer] });
    expect((await f.request('/.well-known/oauth-protected-resource/blyg/studio/mcp')).status).toBe(404);
  });
  it('keeps the age of a legacy-only owner cookie when creating its native session', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    try {
      const f = await flow({ scope: 'openid owner:read owner:draft' });
      vi.setSystemTime(now + 7200 * 1000);
      const url = new URL(f.authorize); url.searchParams.set('max_age', '3600');
      // Omit all native cookies. Reconstructing the native session must not
      // turn the two-hour-old owner authentication into a fresh login.
      const response = await f.request(url.href, { headers: { cookie: f.owner } });
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('location')!, f.base).pathname).toBe('/blyg/studio/login');
    } finally { vi.useRealTimers(); }
  });
  it.each(['login', 'max_age'])('resumes a password-checked native continuation within the same second (%s)', async mode => {
    const now = Math.floor(Date.now() / 1000) * 1000 + 731;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    try {
      const f = await flow({ scope: 'openid owner:read owner:draft' }), url = new URL(f.authorize);
      url.searchParams.set(mode === 'login' ? 'prompt' : 'max_age', mode === 'login' ? 'login' : '0');
      const authorization = await f.request(url.href, { headers: { cookie: f.owner + '; ' + f.binding } });
      expect(authorization.status).toBe(302);
      const loginURL = new URL(authorization.headers.get('location')!);
      const posted = await f.request('/blyg/studio/login', { method: 'POST', headers: { cookie: f.owner, Origin: f.base }, body: new URLSearchParams({ password: env.OWNER_PASSWORD, oauth_query: loginURL.search.slice(1) }) });
      const failure = posted.status === 302 ? undefined : await posted.clone().json().catch(() => ({})) as { error?: string; code?: string; message?: string };
      expect(posted.status, failure ? JSON.stringify({ error: failure.error, code: failure.code, message: failure.message }) : '').toBe(302);
      const continuation = new URL(posted.headers.get('location')!, f.base);
      expect(continuation.pathname).toBe('/blyg/studio/auth/consent');
      const cookies = new Map([[f.owner.split('=')[0], f.owner]]);
      for (const cookie of posted.headers.getSetCookie()) { const value = cookie.split(';')[0]; cookies.set(value.split('=')[0], value); }
      const consent = await f.request(continuation.href, { headers: { cookie: [...cookies.values()].join('; ') } });
      expect(consent.status).toBe(200);
      expect((await consent.text()).includes('name="handle"')).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it.each(['get', 'post'])('rejects an invalid signed reauthentication query before creating a session (%s)', async method => {
    const f = await flow({ scope: 'openid owner:read owner:draft' });
    const before = await env.DB.prepare('SELECT COUNT(*) AS count FROM session').first<{ count: number }>();
    const query = 'client_id=' + encodeURIComponent(f.client.client_id) + '&sig=invalid&exp=9999999999';
    const response = method === 'get'
      ? await f.request('/blyg/studio/login?' + query, { headers: { cookie: f.owner } })
      : await f.request('/blyg/studio/login', { method: 'POST', headers: { cookie: f.owner, Origin: f.base }, body: new URLSearchParams({ password: env.OWNER_PASSWORD, oauth_query: query }) });
    expect(response.status).toBe(400); expect(response.headers.getSetCookie()).toHaveLength(0);
    const after = await env.DB.prepare('SELECT COUNT(*) AS count FROM session').first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });
  it.each(['foreign-origin', 'cross-site-fetch'])('rejects cross-origin password continuation before minting cookies (%s)', async attack => {
    const f = await flow({ scope: 'openid owner:read owner:draft' }), url = new URL(f.authorize); url.searchParams.set('prompt', 'login');
    const authorization = await f.request(url.href, { headers: { cookie: f.owner } });
    expect(authorization.status).toBe(302);
    const query = new URL(authorization.headers.get('location')!).search.slice(1);
    const before = await env.DB.prepare('SELECT COUNT(*) AS count FROM session').first<{ count: number }>();
    const response = await f.request('/blyg/studio/login', { method: 'POST', headers: { cookie: f.owner, Origin: attack === 'foreign-origin' ? 'https://attacker.example' : f.base, ...(attack === 'cross-site-fetch' ? { 'Sec-Fetch-Site': 'cross-site' } : {}) }, body: new URLSearchParams({ password: env.OWNER_PASSWORD, oauth_query: query }) });
    expect(response.status).toBe(403); expect(response.headers.getSetCookie()).toHaveLength(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM session').first<{ count: number }>())?.count).toBe(before?.count);
  });
  it.each(['/internal/owner', '/internal/access', '/internal/manual', '/sign-in/email', '/oauth2/create-client', '/oauth2/update-client', '/oauth2/delete-client'])('does not publish native administrative endpoint %s', async path => {
    const f = await flow(), response = await f.request(f.issuer + path, { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(404);
  });
});
