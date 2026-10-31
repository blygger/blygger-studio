import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { makeApp } from '../src/index.ts';
import { authorizationServer } from '../src/oauth.ts';
import { BlyggerApi, createBlyggerClient, unwrap } from '../sdk/dist/index.js';
import { flow } from './oauth-flow-driver.ts';

it.each(['', '/blyg', '/notes/b'])('uses one API address at mount %s', async mount => {
  const app = makeApp(mount), origin = 'https://cutover.example.test', api = origin + mount + '/api';
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const ctx = createExecutionContext();
    // The factory mount wins even when the test binding names a different node.
    const response = await app.fetch(new Request(input, init), env, ctx);
    await waitOnExecutionContext(ctx); return response;
  };
  const login = await fetch(origin + mount + '/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const client = createBlyggerClient({ baseUrl: api, headers: { cookie }, fetch });
  const draft = await unwrap(BlyggerApi.createItem({ client, body: { contentMd: 'mounted SDK' } }));
  expect((await unwrap(BlyggerApi.getItem({ client, path: { id: draft.id } }))).contentMd).toBe('mounted SDK');
  const created = await fetch(api + '/items', { method: 'POST', headers: { cookie } });
  expect(created.status).toBe(201);
  expect(created.headers.get('location')).toBe(mount + '/api/items/' + (await created.json<{ id: string }>()).id);
  const caps = await unwrap(BlyggerApi.getCapabilities({ client }));
  expect(caps.endpoints.api).toBe(api);
  expect(caps.contractVersion).toBe('4.0.0');
  const document = await (await fetch(api + '/openapi.json', { headers: { cookie } })).json<any>();
  expect(document.servers).toEqual([{ url: api }]);
  expect(document.paths['/items/{id}']).toBeTruthy();
  expect(Object.keys(document.paths).some(path => path.startsWith('/api'))).toBe(false);
  expect((await fetch(api + '/studio/login', { headers: { cookie } })).status).toBe(404);
  expect((await fetch(origin + mount + '/studio/login')).status).toBe(200);
  const page = await fetch(origin + mount + '/studio', { headers: { cookie } });
  expect(await page.text()).toContain(`data-api-base="${mount}/api"`);
  const denied = await fetch(api + '/settings');
  expect(denied.status).toBe(401);
  expect(denied.headers.get('www-authenticate')).toContain(origin + mount + '/studio/auth/resources/api');
  expect(denied.headers.get('cache-control')).toBe('no-store');
  const preflight = await fetch(api + '/items', { method: 'OPTIONS', headers: { Origin: 'https://client.example', 'Access-Control-Request-Method': 'POST' } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  if (mount) {
    for (const path of ['/api/settings', '/api/openapi.json', '/api/authorizations']) {
      expect((await fetch(origin + path, { headers: { cookie } })).status).toBe(404);
      expect((await fetch(origin + path, { method: 'OPTIONS' })).status).toBe(404);
    }
  }
});

it('rejects a trusted old REST audience and cannot retarget its stored refresh grant', async () => {
  const f = await flow();
  const approval = await f.decide('browser-a', true);
  const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
  const tokens = await (await f.token(code)).json<{ access_token: string; refresh_token: string }>();
  const server = await authorizationServer(f.issuer, env);
  const receive = (token: string) => f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + token } });
  expect((await receive(tokens.access_token)).status).toBe(200);
  // Hold signature, issuer, lifetime, scopes and grant identity constant.
  // Only the pre-cutover audience differs from the valid neighboring token.
  const legacy = await server.api.signJWT({ body: { payload: { ...decodeJwt(tokens.access_token), aud: f.base + '/api' } } });
  expect((await receive(legacy.token)).status).toBe(401);
  expect((await f.request('/api/settings', { headers: { Authorization: 'Bearer ' + legacy.token } })).status).toBe(404);
  const context = await server.$context;
  // Restore the native stored resource values of a pre-cutover approval.
  for (const model of ['oauthRefreshToken', 'oauthConsent']) {
    await context.adapter.updateMany({ model, where: [{ field: 'clientId', value: f.client.client_id }], update: { resources: [f.base + '/api'] } });
  }
  const renewed = await f.request(f.issuer + '/oauth2/token', { method: 'POST', body: new URLSearchParams({
    grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: tokens.refresh_token, resource: f.base + '/blyg/api',
  }) });
  expect(renewed.status).toBe(400);
  expect((await receive(tokens.access_token)).status).toBe(200);
});
