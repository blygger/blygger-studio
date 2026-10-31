import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { operationDefinitions } from '../src/operations.ts';
import { runOperation } from '../src/operation-runner.ts';
import { createDraft, getItem, saveWorkingCopy } from '../src/model.ts';
import type { OperationContext } from '../src/operation-types.ts';

function context(bindings = env): OperationContext {
  return { env: bindings, url: 'https://revision.example/blyg/api', access: null, extensions: [], defer() {} };
}
it('reports a typed revision conflict when the target disappears during R2 upload and cleans the bytes', async () => {
  const item = await createDraft(env.DB, 'upload target');
  let storedKey = '';
  const media = new Proxy(env.MEDIA, { get(target, key) {
    if (key === 'put') return async (...args: Parameters<R2Bucket['put']>) => {
      storedKey = args[0];
      const result = await target.put(...args);
      await env.DB.prepare('DELETE FROM items WHERE id=?').bind(item.id).run();
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const result = await runOperation(operationDefinitions([]).get('uploadMedia')!, { path: {}, query: {}, media: { itemId: item.id, expectedRevision: item.revision, file: { bytes: new TextEncoder().encode('image'), mime: 'image/png', name: 'race.png' } } }, context({ ...env, MEDIA: media }));
  expect(result).toMatchObject({ ok: false, kind: 'conflict', value: { code: 'revision-conflict', itemId: item.id, expectedRevision: item.revision } });
  expect(storedKey).not.toBe('');
  expect(await env.MEDIA.get(storedKey)).toBeNull();
});
it('reports the same typed conflict for a commit-time draft deletion race', async () => {
  const item = await createDraft(env.DB, 'captured draft');
  let commits = 0;
  const database = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      commits++;
      await saveWorkingCopy(env.DB, item.id, 'competing edit');
      return target.batch(statements);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const result = await runOperation(operationDefinitions([]).get('deleteItem')!, { path: { id: item.id }, query: {}, body: { expectedRevision: item.revision } }, context({ ...env, DB: database }));
  expect(commits).toBe(1);
  expect(result).toMatchObject({ ok: false, kind: 'conflict', value: { code: 'revision-conflict', itemId: item.id, expectedRevision: item.revision } });
  expect(await getItem(env.DB, item.id)).toMatchObject({ content_md: 'competing edit', revision: item.revision + 1 });
});
