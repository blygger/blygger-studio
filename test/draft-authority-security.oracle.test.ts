/**
 * Decision #52 makes drafting and publication separate capabilities. A draft-only
 * action must not remove or alter a published projection, even if publication
 * races the action's read. OWASP requires authorization at the point of use:
 * https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
 * Model: capture public bytes after owner publication; draft edits/restoration
 * leave those bytes unchanged, and deletion refuses a published item.
 * Driver: real REST handlers with injected draft capability after token validation
 * (native token validation belongs to auth-security.oracle.test.ts). D1 supplies
 * real storage; a controlled batch seam pauses deletion after its state read.
 * Refinement: the owner can publish while delete is paused, then delete must409
 * and the public item must remain200 with exactly the captured bytes.
 * Limits: one controlled race and named fields, not every publication schedule.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { Hono } from 'hono';
import { createOwnerApi } from '../src/owner-api.ts';
import { makeApp } from '../src/index.ts';

const base = 'https://draft-security.example.test';
async function receive(app: Hono<any>, path: string, init: RequestInit = {}, bindings = env) {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(base + path, init), bindings, ctx);
  await waitOnExecutionContext(ctx); return response;
}
async function fixture() {
  const app = makeApp('/blyg');
  const login = await receive(app, '/blyg/studio/login', { method: 'POST', headers: { 'CF-Connecting-IP': 'fd00:' + crypto.randomUUID().replaceAll('-', '').match(/.{4}/g)!.slice(0,7).join(':') }, body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
  expect(login.status).toBe(302);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const owner = (path: string, method = 'GET', body?: unknown) => receive(app, path, { method, headers: { cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const created = await owner('/blyg/api/items', 'POST', { kind: 'thread', content_md: 'Public authority fixture' });
  expect(created.status).toBe(201); const { id } = await created.json() as { id: string };
  return { app, owner, id, cookie };
}
it('draft edits and restoration leave every named public projection unchanged', async () => {
  const f = await fixture();
  expect((await f.owner(`/blyg/api/items/${f.id}/publish`, 'POST')).status).toBe(200);
  const publicPath = `/blyg/items/${f.id}.json`;
  const before = await (await receive(f.app, publicPath)).text();
  const draft = new Hono().route('/api', createOwnerApi({ scope: ['owner:draft'], clientId: 'draft-fixture', userId: 'owner' }));
  for (const [method, path, body, status] of [
    ['PATCH', `/api/items/${f.id}`, { content_md: 'Unpublished text', stub_of: { url: 'https://citation.example/post' } }, 200],
    ['POST', `/api/items/${f.id}/restore`, { version: 1 }, 200],
    ['DELETE', `/api/items/${f.id}`, undefined, 409],
  ] as const) {
    const result = await receive(draft, path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(result.status).toBe(status);
    const after = await receive(f.app, publicPath); expect(after.status).toBe(200);
    expect(await after.text(), 'draft authority cannot change published item bytes').toBe(before);
  }
});
it('a draft-only deletion cannot remove an item published during its stale-state window', async () => {
  const f = await fixture();
  const form = new FormData(); form.set('item_id', f.id);
  form.set('file', new File(['disposable fixture'], 'fixture.png', { type: 'image/png' }));
  const upload = await receive(f.app, '/blyg/api/media', { method: 'POST', headers: { cookie: f.cookie }, body: form });
  expect(upload.status).toBe(201); const media = await upload.json() as { id: string };
  let reached!: () => void, release!: () => void;
  const claimed = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const statements = new WeakMap<object, { sql: string; native: D1PreparedStatement }>();
  const wrap = (native: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(native, { get(target, key) {
      if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }); statements.set(proxy, { sql, native }); return proxy;
  };
  const database = new Proxy(env.DB, { get(target, key) {
    if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
    if (key === 'batch') return async (batch: D1PreparedStatement[]) => {
      if (batch.some(statement => /DELETE FROM items/i.test(statements.get(statement)?.sql ?? ''))) { reached(); await resume; }
      return target.batch(batch.map(statement => statements.get(statement)?.native ?? statement));
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const draft = new Hono().route('/api', createOwnerApi({ scope: ['owner:draft'], clientId: 'draft-race', userId: 'owner' }));
  const deletion = receive(draft, `/api/items/${f.id}`, { method: 'DELETE' }, { ...env, DB: database });
  try {
    await Promise.race([claimed, deletion.then(() => { throw new Error('Deletion did not reach the batch checkpoint'); })]);
    const published = await f.owner(`/blyg/api/items/${f.id}/publish`, 'POST'); expect(published.status).toBe(200);
    const path = `/blyg/items/${f.id}.json`, baseline = await receive(f.app, path); expect(baseline.status).toBe(200);
    const bytes = await baseline.text();
    release(); expect((await deletion).status, 'draft deletion must reject stale published authority').toBe(409);
    const retained = await receive(f.app, path); expect(retained.status, 'published item must remain visible').toBe(200);
    expect(await retained.text()).toBe(bytes);
    expect(await env.DB.prepare('SELECT id FROM media WHERE id=?').bind(media.id).first(), 'publication race preserves media rows too').not.toBeNull();
  } finally { release(); await deletion.catch(() => undefined); }
});
