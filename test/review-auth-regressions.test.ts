import { testRevisionBody } from './helpers.ts';
import { testItemRevision } from './helpers.ts';
/**
 * External review receiving checks: delegated drafting must not change a published
 * item's media projection. Owner cookies must remain usable behind a Basic gate.
 * Sources: decision #52's separate draft/publish permissions and RFC6750 bearer
 * syntax. Expectations below are literal observable laws, not production scope
 * metadata. Driver: real Worker, native manual tokens and generated SDK requests.
 * Limits: targeted witnesses; the route inventory and history oracles are separate.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createOwnerApi } from '../src/owner-api.ts';
import { contractApp } from '../src/contract/app.ts';
import { makeApp } from '../src/index.ts';
import { BlyggerApi, createBlyggerClient } from '../sdk/dist/browser.js';
import { verifySession } from '../src/auth.ts';
import { authorizationServer } from '../src/oauth.ts';

async function fixture(bindings = env) {
  const app = makeApp('/blyg'), base = 'https://review-regressions.example.test';
  const ip = 'fd00:' + crypto.randomUUID().replaceAll('-', '').match(/.{4}/g)!.slice(0, 7).join(':');
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); request.headers.set('CF-Connecting-IP', ip);
    const ctx = createExecutionContext(), response = await app.fetch(request, bindings, ctx);
    await waitOnExecutionContext(ctx); return response;
  };
  const request = (path: string, init?: RequestInit) => fetch(base + path, init);
  const loggedIn = await request('/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
  expect(loggedIn.status).toBe(302);
  const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0];
  const owner = async (path: string, method = 'GET', body?: unknown, headers = {}) => { body = await testRevisionBody(method, path, body); return request(path, { method, headers: { cookie, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); };
  const mint = async (scope: string[]) => {
    const response = await owner('/blyg/api/authorizations', 'POST', { name: 'Review fixture', scope, resource: 'api' });
    expect(response.status).toBe(200); return (await response.json() as { accessToken: string }).accessToken;
  };
  return { app, base, fetch, request, owner, cookie, mint };
}

it('draft-only attachment cannot alter published media but can attach to a draft', async () => {
  const f = await fixture(), token = await f.mint(['owner:draft']);
  const created = await f.owner('/blyg/api/items', 'POST', { contentMd: 'Published attachment boundary' });
  const { id } = await created.json() as { id: string };
  expect((await f.owner('/blyg/api/items/' + id + '/publish', 'POST')).status).toBe(200);
  const projection = () => f.request('/blyg/items/' + id + '.json').then(value => value.json());
  const before = await projection();
  const upload = async (item: string) => {
    const form = new FormData(); (form.set('itemId', item), form.set('expectedRevision', String(await testItemRevision(item)))); form.set('file', new File(['image'], 'test.png', { type: 'image/png' }));
    return f.request('/blyg/api/media', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  };
  expect((await upload(id)).status, 'draft-only upload cannot publish an attachment').toBe(403);
  expect(await projection()).toEqual(before);
  const draft = await (await f.owner('/blyg/api/items', 'POST', { contentMd: 'Draft attachment neighbor' })).json() as { id: string };
  expect((await upload(draft.id)).status).toBe(201);
});

it('preserves valid owner-cookie access behind an unrelated Basic authorization header', async () => {
  const f = await fixture(), headers = { Authorization: 'Basic ' + btoa('gate:fixture') };
  expect((await f.owner('/blyg/api/settings', 'GET', undefined, headers)).status).toBe(200);
  expect((await f.owner('/blyg/api/authorizations', 'GET', undefined, headers)).status).toBe(200);
  expect((await f.owner('/blyg/api/authorizations', 'POST', { name: 'Gate neighbor', scope: ['owner:read'], resource: 'api' }, headers)).status).toBe(200);
  expect((await f.owner('/blyg/api/settings', 'GET', undefined, { Authorization: 'Bearer invalid' })).status).toBe(401);
});

it('records the SDK plain-session-string compatibility boundary with native transport', async () => {
  const f = await fixture(), session = f.cookie.split('=')[1];
  const legacy = createBlyggerClient({ baseUrl: f.base + '/blyg/api', fetch: f.fetch, auth: session });
  expect((await BlyggerApi.getSettings({ client: legacy })).response!.status).toBe(401);
  const cookie = createBlyggerClient({ baseUrl: f.base + '/blyg/api', fetch: f.fetch, auth: scheme => scheme.in === 'cookie' ? session : undefined });
  expect((await BlyggerApi.getSettings({ client: cookie })).response!.status).toBe(200);
});

it('records rejection of the pre-OAuth owner-cookie format', async () => {
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.COOKIE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(expiry)));
  const cookie = 'blyg_session=' + expiry + '.' + [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('');
  expect(await verifySession(env, cookie)).toBe(false);
});

it('records HTTPS refusal for remote and LAN protected routes with loopback neighbor', async () => {
  const f = await fixture();
  for (const host of ['review-regressions.example.test', '192.168.1.20']) {
    const response = await f.fetch('http://' + host + '/blyg/studio/login');
    expect(response.status).toBe(400); expect(response.headers.get('location')).toBeNull();
  }
  expect((await f.fetch('http://127.0.0.1/blyg/studio/login')).status).toBe(200);
});

it('counts repeated provider construction and D1 initialization batches', async () => {
  const original = env.DB.batch.bind(env.DB); let writes = 0;
  const db = new Proxy(env.DB, { get(target, property) {
    if (property === 'batch') return (...args: Parameters<typeof original>) => { writes++; return original(...args); };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const bindings = { ...env, DB: db };
  const first = await authorizationServer('https://provider-work.example.test/api', bindings);
  const second = await authorizationServer('https://provider-work.example.test/api', bindings);
  expect(writes, 'repeated provider lookup initializes D1 once per configuration').toBe(1); expect(first).toBe(second);
});


// Adversarial registered subject: a future write accidentally omits OpenAPI
// metadata. A read credential must not gain it through the fallback classifier.
it('denies an undeclared write handler rather than treating it as a private read', async () => {
  const owner = createOwnerApi({ scope: ['owner:read'], clientId: 'review', userId: 'owner' });
  // Re-register the real middleware/routes without the terminal 404 handler,
  // then add the adversarial handler. A 404 would not witness authorization.
  const subject = new Hono<{ Bindings: typeof env }>();
  for (const route of owner.routes.slice(0, -1)) subject.on(route.method, route.path, route.handler);
  let effects = 0;
  subject.post('/undeclared-write', c => { effects++; return c.json({ ok: true }); });
  const app = new Hono<{ Bindings: typeof env }>().route('/api', subject);
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request('https://classifier.example.test/api/undeclared-write', { method: 'POST' }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(response.status, 'unclassified writes must fail closed').toBe(403);
  expect(effects).toBe(0);
});

it('logs bounded error kind and registered route without secret-bearing text', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const app = contractApp();
    app.get('/diagnostic/:id', () => { throw new TypeError('credential-sentinel-for-review'); });
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request('https://diagnostic.example.test/diagnostic/private-id?secret=private-query'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(500);
    expect(spy.mock.calls).toContainEqual(['API request failed', { errorType: 'TypeError', method: 'GET', route: '/diagnostic/:id' }]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('credential-sentinel-for-review');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('private-id');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('private-query');
  } finally { spy.mockRestore(); }
});

// Control the R2 await, rather than sleeping: publish between upload start and
// the media-row commit. Publication state must be checked at the write itself.
it('cannot attach draft-only media when publication races the R2 upload', async () => {
  let entered!: () => void, release!: () => void, uploadedKey = '';
  const uploading = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const media = new Proxy(env.MEDIA, { get(target, property) {
    if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => { uploadedKey = args[0]; entered(); await proceed; return target.put(...args); };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const f = await fixture({ ...env, MEDIA: media });
  const token = await f.mint(['owner:draft']);
  const item = await (await f.owner('/blyg/api/items', 'POST', { contentMd: 'Concurrent attachment boundary' })).json() as { id: string };
  const form = new FormData(); (form.set('itemId', item.id), form.set('expectedRevision', String(await testItemRevision(item.id)))); form.set('file', new File(['image'], 'race.png', { type: 'image/png' }));
  const upload = f.request('/blyg/api/media', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  let before: unknown;
  try {
    await uploading;
    expect((await f.owner('/blyg/api/items/' + item.id + '/publish', 'POST')).status).toBe(200);
    before = await (await f.request('/blyg/items/' + item.id + '.json')).json();
  } finally { release(); }
  const denied = await upload;
  expect(denied.status, 'publication invalidates the captured attachment revision').toBe(409);
  expect(await denied.json()).toMatchObject({ code: 'revision-conflict' });
  expect(await (await f.request('/blyg/items/' + item.id + '.json')).json()).toEqual(before);
  expect((await env.DB.prepare('SELECT id FROM media WHERE item_id=?').bind(item.id).all()).results).toEqual([]);
  expect(uploadedKey).not.toBe('');
  expect(await env.MEDIA.head(uploadedKey), 'denied raced upload must remove its R2 object').toBeNull();
});

// Dependency-defined Error names are input too. Logging them verbatim would
// move the leak from message/stack into another field.
it('bounds dependency-defined error names in diagnostics', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const app = contractApp();
    app.get('/diagnostic/:id', () => { const error = new Error('secret-message'); error.name = 'secret-error-name'; throw error; });
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request('https://diagnostic.example.test/diagnostic/secret-path'), env, ctx);
    await waitOnExecutionContext(ctx); expect(response.status).toBe(500);
    expect(spy.mock.calls, 'diagnostic fields must reject unbounded input').toContainEqual(['API request failed', { errorType: 'UnknownError', method: 'GET', route: '/diagnostic/:id' }]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret');
  } finally { spy.mockRestore(); }
});
