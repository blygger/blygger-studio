import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createDraft, getItem, getVersion, insertMedia, pinVersion, publish, putSettings, restoreVersion, saveWorkingCopy } from '../src/model.ts';
import { runGenerateScope } from '../src/tk-generate.ts';

it('creates a private revision independently of the publication version', async () => {
  const item = await createDraft(env.DB, 'first');
  expect(item).toMatchObject({ revision: 1, version: 0 });
});

it('does not publish a stale working snapshot after another edit', async () => {
  const captured = await createDraft(env.DB, 'old text');
  await saveWorkingCopy(env.DB, captured.id, 'new text');
  await expect(publish(env.DB, captured, null)).rejects.toThrow('item revision conflict');
  expect(await getVersion(env.DB, captured.id, 1)).toBeNull();
  expect(await getItem(env.DB, captured.id)).toMatchObject({ content_md: 'new text', version: 0 });
});

it('installs generated text and provenance only if the captured revision still holds', async () => {
  await putSettings(env.DB, { ai_model: 'claude-opus-5' });
  const captured = await createDraft(env.DB, '[TK]write a greeting[/TK]');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = runGenerateScope({ ...env, AI_PROVIDER_KEY: 'fixture' }, captured, 0, async () => {
    entered(); await gate;
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'fixture', content: [{ type: 'text', text: 'late greeting' }] }) };
  });
  try {
    await Promise.race([started, pending.then(result => { throw new Error(`provider not reached: ${JSON.stringify(result)}`); })]);
    await saveWorkingCopy(env.DB, captured.id, 'a newer human edit');
  } finally { release(); }
  await expect(pending).rejects.toThrow('item revision conflict');
  expect(await getItem(env.DB, captured.id)).toMatchObject({ content_md: 'a newer human edit', tk_provenance_json: null });
});

it('invalidates a captured restore when attachment membership changes', async () => {
  const item = await createDraft(env.DB, 'published');
  await publish(env.DB, item, null);
  const captured = (await getItem(env.DB, item.id))!;
  await insertMedia(env.DB, { id: 'revision-attachment', item_id: item.id, r2_key: 'media/revision.png', mime: 'image/png', alt: null, inline: 0 });
  await expect(restoreVersion(env.DB, captured, 1)).rejects.toThrow('item revision conflict');
  expect(await env.DB.prepare('SELECT item_id FROM media WHERE id=?').bind('revision-attachment').first()).toEqual({ item_id: item.id });
});

it('pins a version only under the expected item revision', async () => {
  const item = await createDraft(env.DB, 'published');
  await publish(env.DB, item, null);
  const captured = (await getItem(env.DB, item.id))!;
  await saveWorkingCopy(env.DB, item.id, 'newer working text');
  await expect(pinVersion(env.DB, item.id, 1, captured.revision)).rejects.toThrow('item revision conflict');
  expect((await getVersion(env.DB, item.id, 1))!.pinned).toBe(0);
});
