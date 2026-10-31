import { SELF, env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BASE, login } from './helpers.ts';
import { BlyggerApi, createBlyggerClient, unwrap } from '../sdk/dist/index.js';
import { readChanges } from '../src/changes.ts';

it('requires the observed revision and returns a typed conflict without changing state', async () => {
  const cookie = await login();
  const client = createBlyggerClient({ baseUrl: BASE + '/blyg/api', headers: { cookie }, fetch: (input, init) => SELF.fetch(new Request(input, init)) });
  const item = await unwrap(BlyggerApi.createItem({ client, body: { contentMd: 'first' } }));
  expect(item.revision).toBe(1);
  const path = { id: item.id };
  const updated = await unwrap(BlyggerApi.updateItem({ client, path, body: { contentMd: 'newer', expectedRevision: item.revision } }));
  expect(updated.revision).toBe(2);
  const stale = await BlyggerApi.publishItem({ client, path, body: { expectedRevision: item.revision } });
  expect(stale.response!.status).toBe(409);
  expect(stale.error).toMatchObject({ code: 'revision-conflict', details: { expectedRevision: 1 } });
  const missing = await SELF.fetch(BASE + '/blyg/api/items/' + item.id, { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ contentMd: 'must not install' }) });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ code: 'invalid-input', details: { issues: [{ path: ['expectedRevision'], message: expect.any(String) }] } });
  expect(await unwrap(BlyggerApi.getItem({ client, path }))).toMatchObject({ revision: 2, version: 0, contentMd: 'newer' });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM versions WHERE item_id=?').bind(item.id).first()).toEqual({ n: 0 });
  const published = await unwrap(BlyggerApi.publishItem({ client, path, body: { expectedRevision: updated.revision } }));
  expect(published).toMatchObject({ version: 1, revision: 3 });
});

it('couples attachment add/remove receipts to the item revision', async () => {
  const cookie = await login();
  const client = createBlyggerClient({ baseUrl: BASE + '/blyg/api', headers: { cookie }, fetch: (input, init) => SELF.fetch(new Request(input, init)) });
  const item = await unwrap(BlyggerApi.createItem({ client }));
  const media = await unwrap(BlyggerApi.uploadMedia({ client, body: { file: new File(['image'], 'revision.png', { type: 'image/png' }), itemId: item.id, expectedRevision: item.revision } }));
  expect(media.revision).toBe(2);
  const stale = await BlyggerApi.deleteMedia({ client, path: { id: media.id }, body: { expectedRevision: item.revision } });
  expect(stale.response!.status).toBe(409);
  expect(await env.DB.prepare('SELECT item_id FROM media WHERE id=?').bind(media.id).first()).toEqual({ item_id: item.id });
  const removed = await unwrap(BlyggerApi.deleteMedia({ client, path: { id: media.id }, body: { expectedRevision: media.revision } }));
  expect(removed).toMatchObject({ outcome: 'deleted', revision: 3 });
  expect(await unwrap(BlyggerApi.getItem({ client, path: { id: item.id } }))).toMatchObject({ revision: 3 });
});

it.each([false, true])('invalidates private reads for revision-only writes (published=%s)', async published => {
  const cookie = await login();
  const client = createBlyggerClient({ baseUrl: BASE + '/blyg/api', headers: { cookie }, fetch: (input, init) => SELF.fetch(new Request(input, init)) });
  const item = await unwrap(BlyggerApi.createItem({ client }));
  const revision = published ? (await unwrap(BlyggerApi.publishItem({ client, path: { id: item.id }, body: { expectedRevision: item.revision } }))).revision : item.revision;
  const before = await readChanges(env.DB);
  expect(await unwrap(BlyggerApi.updateItem({ client, path: { id: item.id }, body: { expectedRevision: revision, responses: 'default' } }))).toMatchObject({ revision: revision + 1 });
  const after = await readChanges(env.DB);
  expect(after.domains.items).toBe(before.domains.items + 1);
  expect(after.domains.reading).toBe(before.domains.reading);
  expect(after.domains.feed).toBe(before.domains.feed);
});

it('does not drop a supplied attachment precondition after restore detaches the media', async () => {
  const cookie = await login();
  const client = createBlyggerClient({ baseUrl: BASE + '/blyg/api', headers: { cookie }, fetch: (input, init) => SELF.fetch(new Request(input, init)) });
  const item = await unwrap(BlyggerApi.createItem({ client }));
  const published = await unwrap(BlyggerApi.publishItem({ client, path: { id: item.id }, body: { expectedRevision: item.revision } }));
  const media = await unwrap(BlyggerApi.uploadMedia({ client, body: { file: new File(['image'], 'detached.png', { type: 'image/png' }), itemId: item.id, expectedRevision: published.revision } }));
  await unwrap(BlyggerApi.restoreItem({ client, path: { id: item.id }, body: { version: 1, expectedRevision: media.revision! } }));
  const removed = await BlyggerApi.deleteMedia({ client, path: { id: media.id }, body: { expectedRevision: media.revision } });
  expect(removed.response!.status).toBe(409);
  expect(removed.error).toMatchObject({ code: 'revision-conflict' });
  expect(await env.DB.prepare('SELECT item_id FROM media WHERE id=?').bind(media.id).first()).toEqual({ item_id: null });
  const stored = await env.DB.prepare('SELECT r2_key FROM media WHERE id=?').bind(media.id).first<{ r2_key: string }>();
  expect(stored).not.toBeNull();
  expect(await env.MEDIA.get(stored!.r2_key)).not.toBeNull();
});
