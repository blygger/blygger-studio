/**
 * Operator policy: bound body bytes before JSON/form parsing or business work.
 * This is a local DoS limit, not an OAuth protocol requirement. The driver sends
 * real Worker requests with no Content-Length, so a declared-length shortcut
 * cannot stand in for a streamed limit. A valid neighboring write still works.
 * Model: REST limit 128 bytes admits a small write, refuses an oversized write
 * with 413, and persists no rejected item. OAuth defaults to 1 MiB and must
 * refuse an oversized registration without growing oauthClient.
 * Limits: fixed receiving histories; no deployed ingress/memory/load claim.
 * https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { flow } from './oauth-flow-driver.ts';
it('REST refuses streamed oversized bodies before writing', async () => {
  const f = await flow(), bindings = { ...env, API_BODY_LIMIT: '128' };
  const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM items').first<{ n: number }>();
  const response = await f.request('/blyg/api/items', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ contentMd: 'x'.repeat(129 - JSON.stringify({ contentMd: '' }).length) }) }, bindings);
  expect(response.status, 'byte admission must precede write work').toBe(413);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM items').first()).toEqual(before);
  expect((await f.request('/blyg/api/items', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ contentMd: 'x'.repeat(128 - JSON.stringify({ contentMd: '' }).length) }) }, bindings)).status).toBe(201);
});
it('OAuth refuses oversized registration bodies before client storage', async () => {
  const f = await flow();
  const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM oauthClient').first();
  const response = await f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'x'.repeat(1024 * 1024), redirect_uris: [f.redirect], token_endpoint_auth_method: 'none' }) });
  expect(response.status, 'OAuth byte admission must precede parsing/storage').toBe(413);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM oauthClient').first()).toEqual(before);
});
