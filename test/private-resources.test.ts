import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BASE, login } from './helpers.ts';
import { createDraft } from '../src/model.ts';
import { makeApp } from '../src/index.ts';

it('exposes intentional camelCase item fields and rejects storage spellings on input', async () => {
  const cookie = await login();
  const stored = await createDraft(env.DB, 'working text', 'thread');
  const read = await SELF.fetch(`${BASE}/blyg/api/items/${stored.id}`, { headers: { cookie } });
  expect(read.status).toBe(200);
  const value = await read.json() as Record<string, unknown>;
  expect(value).toMatchObject({ id: stored.id, revision: 1, kind: 'thread', status: 'draft', contentMd: 'working text', stubOf: null, forkedFrom: null, dirty: true });
  for (const key of ['content_md', 'stub_of', 'forked_from', 'authored_kind', 'tk_provenance_json', 'show_responses']) expect(value).not.toHaveProperty(key);
  const creation = await SELF.fetch(`${BASE}/blyg/api/items`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ contentMd: 'new DTO' }) });
  expect(creation.status).toBe(201);
  const rejected = await SELF.fetch(`${BASE}/blyg/api/items/${stored.id}`, { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ content_md: 'old spelling', expectedRevision: 1 }) });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({ code: 'invalid-input', message: expect.any(String), details: { issues: expect.any(Array) } });
});

it('returns structured remote metadata without rewriting unknown remote members', async () => {
  const cookie = await login();
  await env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES ('dto-remote','blyg','https://remote.example/','https://remote.example/feed.xml','Remote','2026-10-31')").run();
  await env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_md,content_html,author_json,media_json,transclusions_json,stub_of_json,forked_from_json,generated_json) VALUES ('dto-remote','dto-item','thread','current',1,'2026-10-31','remote text','<p>remote text</p>',?,?,?,?,?,?)")
    .bind('{"name":"Remote","future_member":{"keep_snake":true}}', '[{"url":"media/remote.png","future_member":7}]', '[{"id":"remote-ref","future_member":8}]', '{"url":"https://citation.example/","future_member":9}', 'broken JSON', '[{"sources":[],"future_member":10}]').run();
  const response = await SELF.fetch(`${BASE}/blyg/api/imports/dto-remote/dto-item`, { headers: { cookie } });
  expect(response.status).toBe(200);
  const value = await response.json() as Record<string, unknown>;
  expect(value).toMatchObject({ subscriptionId: 'dto-remote', remoteId: 'dto-item', contentMd: 'remote text', author: { name: 'Remote', future_member: { keep_snake: true } }, media: [{ url: 'media/remote.png', future_member: 7 }], transclusions: [{ id: 'remote-ref', future_member: 8 }], stubOf: { future_member: 9 }, forkedFrom: null, generated: [{ future_member: 10 }] });
  for (const key of ['author_json', 'media_json', 'transclusions_json', 'stub_of_json', 'forked_from_json', 'generated_json']) expect(value).not.toHaveProperty(key);
});

it.each(['', '/notes/blyg'])('returns a usable canonical media URL at mount %s', async mount => {
  const app = makeApp(mount);
  const receive = async (path: string, init: RequestInit = {}) => {
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request('https://dto.example' + path, init), env, ctx);
    await waitOnExecutionContext(ctx); return response;
  };
  const loggedIn = await receive(mount + '/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }), headers: { 'CF-Connecting-IP': '2001:db8:3100::' + (mount ? '2' : '1') } });
  const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0];
  const form = new FormData(); form.set('file', new File(['DTO image'], 'dto.png', { type: 'image/png' }));
  const uploaded = await receive(mount + '/api/media', { method: 'POST', headers: { cookie }, body: form });
  expect(uploaded.status).toBe(201);
  const media = await uploaded.json() as { url: string };
  expect(media.url).toMatch(new RegExp('^https://dto\\.example' + mount + '/media/'));
  const image = await app.fetch(new Request(media.url, { headers: { cookie } }), env, createExecutionContext());
  expect(image.status).toBe(200); expect(await image.text()).toBe('DTO image');
});
