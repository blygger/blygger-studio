import { applyD1Migrations, env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { apiJson, getPublic, login } from './helpers.ts';
import { getVersion } from '../src/model.ts';
import { versionResource } from '../src/contract/resources.ts';
import { loadFeedHistory } from '../src/feeds/history.ts';

it('backfills only known version states and preserves ambiguous legacy behavior', async () => {
  // Recreate the actual pre-0034 version schema, then apply the parsed migration.
  await env.DB.prepare('DROP TRIGGER change_versions_update').run();
  await env.DB.prepare('ALTER TABLE versions DROP COLUMN kind').run();
  const previous = env.TEST_MIGRATIONS.find(m => m.name.startsWith('0024'))!;
  await env.DB.prepare(previous.queries.find((q: string) => q.includes('CREATE TRIGGER change_versions_update'))!).run();

  const fixtures: Array<{ id: string; text: string; transclusions: string | null; latest?: boolean; withdrawn?: boolean; expected: string | null }> = [
    { id: 'old-text-fragment', text: 'retained words', transclusions: null, expected: 'fragment' },
    { id: 'old-text-thread', text: 'retained thread', transclusions: '[]', expected: 'thread' },
    { id: 'known-empty-public', text: '', transclusions: null, latest: true, expected: 'fragment' },
    { id: 'known-current-endcap', text: '', transclusions: null, latest: true, withdrawn: true, expected: 'withdrawn' },
    { id: 'ambiguous-old-empty', text: '', transclusions: null, expected: null },
    { id: 'known-old-empty-thread', text: '', transclusions: '[]', expected: 'thread' },
    { id: 'malformed-old-empty', text: '', transclusions: '', expected: null },
  ];
  const at = '2026-10-01T00:00:00Z';
  for (const f of fixtures) {
    await env.DB.prepare('INSERT INTO items (id,kind,status,created,updated,version,content_md) VALUES (?,?,?,?,?,?,?)')
      .bind(f.id, f.withdrawn ? 'withdrawn' : f.transclusions === '[]' ? 'thread' : 'fragment', f.withdrawn ? 'withdrawn' : 'public', at, at, f.latest ? 1 : 2, 'working copy').run();
    await env.DB.prepare('INSERT INTO versions (item_id,version,content_md,content_html,content_hash,published_at,note,transclusions,pinned) VALUES (?,1,?,?,?,?,?,?,?)')
      .bind(f.id, f.text, `<p>frozen ${f.id}</p>`, `hash-${f.id}`, at, 'A note does not establish intent', f.transclusions, f.id === 'ambiguous-old-empty' ? 1 : 0).run();
  }
  const before = (await env.DB.prepare('SELECT * FROM versions ORDER BY item_id').all<Record<string, unknown>>()).results;
  const pinPath = '/blyg/items/ambiguous-old-empty/v1.json';
  const pinBefore = await (await getPublic(pinPath)).text();
  const migration = env.TEST_MIGRATIONS.find(m => m.name.startsWith('0034'))!;
  await applyD1Migrations(env.DB, [{ ...migration, name: 'fixture-version-state-0034' }]);
  const after = (await env.DB.prepare('SELECT * FROM versions ORDER BY item_id').all<Record<string, unknown>>()).results;
  expect(after.map(({ kind: _kind, ...row }) => row)).toEqual(before);
  for (const f of fixtures) expect((await getVersion(env.DB, f.id, 1))?.kind, f.id).toBe(f.expected);
  expect(await (await getPublic(pinPath)).text()).toBe(pinBefore);

  const cookie = await login();
  const ambiguous = (await getVersion(env.DB, 'ambiguous-old-empty', 1))!;
  expect(versionResource(ambiguous).kind).toBe('withdrawn');
  expect((await apiJson(cookie, 'PUT', '/api/items/ambiguous-old-empty/versions/1/pin')).status).toBe(409);
  expect((await apiJson(cookie, 'POST', '/api/items/ambiguous-old-empty/restore', { version: 1 })).status).toBe(409);
  expect((await apiJson(cookie, 'GET', '/api/fork-options?id=ambiguous-old-empty')).json.versions).toEqual([]);
  const history = await loadFeedHistory(env.DB);
  expect(history.items.find(row => row.id === 'ambiguous-old-empty')?.versions).toEqual([]);
  expect(history.items.find(row => row.id === 'known-old-empty-thread')?.versions).toMatchObject([{ version: 1 }]);

  // An old Worker can still insert during the migration/deploy window.
  await env.DB.prepare("INSERT INTO versions (item_id,version,content_md,content_hash,published_at) VALUES ('ambiguous-old-empty',3,'','legacy-hash',?)").bind(at).run();
  const legacy = (await getVersion(env.DB, 'ambiguous-old-empty', 3))!;
  expect(legacy.kind).toBeNull();
  expect(versionResource(legacy).kind).toBe('withdrawn');
  await expect(env.DB.prepare("UPDATE versions SET kind='unknown'").run()).rejects.toThrow();
});

it('invalidates version-state changes but not no-op updates', async () => {
  await env.DB.prepare("INSERT INTO items(id,kind,status,created,updated,version,content_md) VALUES ('state-trigger','fragment','public','at','at',1,'')").run();
  await env.DB.prepare("INSERT INTO versions(item_id,version,content_md,content_hash,published_at) VALUES ('state-trigger',1,'','hash','at')").run();
  const state = () => env.DB.prepare('SELECT items,reading,feed FROM change_state WHERE id=1').first<{ items: number; reading: number; feed: number }>();
  const before = (await state())!;
  await env.DB.prepare("UPDATE versions SET kind='fragment' WHERE item_id='state-trigger'").run();
  expect(await state()).toEqual({ items: before.items + 1, reading: before.reading + 1, feed: before.feed + 1 });
  const changed = await state();
  await env.DB.prepare("UPDATE versions SET kind='fragment' WHERE item_id='state-trigger'").run();
  expect(await state()).toEqual(changed);
});
