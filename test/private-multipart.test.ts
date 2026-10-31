import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { makeApp } from '../src/index.ts';
import { createDraft, getItem } from '../src/model.ts';
import { BASE, login } from './helpers.ts';

async function fixture() {
  const cookie = await login();
  const item = await createDraft(env.DB, 'attachment target');
  const app = makeApp('/blyg');
  let puts = 0;
  const bucket = new Proxy(env.MEDIA, { get(target, key) {
    if (key === 'put') return (...args: Parameters<R2Bucket['put']>) => { puts++; return target.put(...args); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return {
    item,
    get puts() { return puts; },
    async upload(fields: Record<string, string> = {}) {
      const form = new FormData();
      form.set('file', new File(['multipart bytes'], 'multipart.png', { type: 'image/png' }));
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      const context = createExecutionContext();
      const response = await app.fetch(new Request(`${BASE}/blyg/api/media`, { method: 'POST', headers: { cookie }, body: form }), { ...env, MEDIA: bucket }, context);
      await waitOnExecutionContext(context);
      return response;
    },
  };
}

it.each(['item_id', 'unexpected'])('rejects the unknown multipart field %s before media or R2 writes', async field => {
  const f = await fixture();
  const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM media').first();
  const response = await f.upload({ [field]: f.item.id, expectedRevision: String(f.item.revision) });
  expect.soft(response.status).toBe(400);
  expect.soft(await response.json()).toMatchObject({
    code: 'invalid-input',
    message: expect.stringContaining(field),
    details: { issues: [{ path: [], message: expect.stringContaining(field) }] },
  });
  expect.soft(f.puts).toBe(0);
  expect.soft(await env.DB.prepare('SELECT COUNT(*) AS n FROM media').first()).toEqual(before);
  expect((await getItem(env.DB, f.item.id))!.revision).toBe(f.item.revision);
});

it('accepts itemId and advances its attachment revision', async () => {
  const f = await fixture();
  const response = await f.upload({ itemId: f.item.id, expectedRevision: String(f.item.revision), inline: 'true', alt: 'current fields' });
  expect(response.status).toBe(201);
  const media = await response.json<{ id: string; url: string; revision: number }>();
  expect(media.revision).toBe(f.item.revision + 1);
  expect(media.url).toMatch(/^https:\/\/example\.com\/blyg\/media\//);
  const stored = await env.DB.prepare('SELECT item_id, r2_key, inline, alt FROM media WHERE id=?').bind(media.id).first<{ item_id: string; r2_key: string; inline: number; alt: string }>();
  expect(stored).toMatchObject({ item_id: f.item.id, inline: 1, alt: 'current fields' });
  expect(await (await env.MEDIA.get(stored!.r2_key))!.text()).toBe('multipart bytes');
  expect((await getItem(env.DB, f.item.id))!.revision).toBe(media.revision);
  expect(f.puts).toBe(1);
});

it('accepts an unattached upload when itemId is omitted', async () => {
  const f = await fixture();
  const response = await f.upload();
  expect(response.status).toBe(201);
  const media = await response.json<{ id: string; revision?: number }>();
  expect(media).not.toHaveProperty('revision');
  const stored = await env.DB.prepare('SELECT item_id, r2_key FROM media WHERE id=?').bind(media.id).first<{ item_id: string | null; r2_key: string }>();
  expect(stored?.item_id).toBeNull();
  expect(await (await env.MEDIA.get(stored!.r2_key))!.text()).toBe('multipart bytes');
  expect((await getItem(env.DB, f.item.id))!.revision).toBe(f.item.revision);
  expect(f.puts).toBe(1);
});
