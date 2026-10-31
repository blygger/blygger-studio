import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { makeApp } from '../src/index.ts';
import { BlyggerApi, createBlyggerClient, unwrap } from '../sdk/dist/browser.js';

// Bounded acceptance checks complement the state-history oracles. They own
// owner/delegated isolation, bearer CORS, and SDK credential transport.
let browserSequence = 0;
async function fixture() {
  const ip = `2001:db8:b001:${(++browserSequence).toString(16)}::1`;
  const app = makeApp('/blyg'), base = 'https://boundary.example.test';
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); request.headers.set('cf-connecting-ip', ip);
    const ctx = createExecutionContext(), response = await app.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx); return response;
  };
  const login = await fetch(base + '/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const mint = await fetch(base + '/blyg/api/authorizations', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'boundary', scope: ['owner:read', 'owner:draft', 'owner:publish', 'owner:manage'], resource: 'api' }) });
  expect(mint.status).toBe(200);
  const credential = await mint.json() as { access_token: string; authorization: { id: string } };
  return { base, fetch, cookie, credential };
}
describe('owner and delegated authorization boundaries', () => {
  it('never grants a token access to credential management, even with an owner cookie', async () => {
    const f = await fixture();
    for (const [method, path] of [['GET', '/authorizations'], ['POST', '/authorizations'], ['DELETE', '/authorizations'], ['DELETE', '/authorizations/' + f.credential.authorization.id]]) {
      const response = await f.fetch(f.base + '/blyg/api' + path, { method, headers: { cookie: f.cookie, Authorization: 'Bearer ' + f.credential.access_token, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ name: 'forbidden', scope: ['owner:read'], resource: 'api' }) } : {}) });
      expect(response.status).toBe(401);
    }
  });
  it('does not fall back to an owner cookie when a supplied bearer token is invalid', async () => {
    const f = await fixture();
    expect((await f.fetch(f.base + '/blyg/api/settings', { headers: { cookie: f.cookie, Authorization: 'Bearer bad-token' } })).status).toBe(401);
  });
  it('allows browser bearer preflight and reads, while denying cross-origin owner-cookie writes', async () => {
    const f = await fixture();
    const preflight = await f.fetch(f.base + '/blyg/api/settings', { method: 'OPTIONS', headers: { Origin: 'https://client.example.test', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization' } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe('*'); expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    const read = await f.fetch(f.base + '/blyg/api/settings', { headers: { Origin: 'https://client.example.test', Authorization: 'Bearer ' + f.credential.access_token } });
    expect(read.status).toBe(200); expect(read.headers.get('access-control-allow-origin')).toBe('*');
    const write = await f.fetch(f.base + '/blyg/api/settings', { method: 'PATCH', headers: { cookie: f.cookie, Origin: 'https://attacker.example.test', 'Content-Type': 'application/json' }, body: '{}' });
    expect(write.status).toBe(403);
  });
  it('uses the unmodified generated SDK with native OAuth auth configuration', async () => {
    const f = await fixture();
    const client = createBlyggerClient({ baseUrl: f.base + '/blyg/api', fetch: f.fetch, auth: security => security.scheme === 'bearer' ? f.credential.access_token : undefined });
    const settings = await unwrap(BlyggerApi.getSettings({ client }));
    expect(settings.site_title).toBeDefined();
    const created = await unwrap(BlyggerApi.createItem({ client, body: { content_md: 'SDK bearer draft' } }));
    expect(created.content_md).toBe('SDK bearer draft');
  });
});
