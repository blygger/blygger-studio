import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { Detail } from '../src/ui/data.ts';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { createLiveQueryCollection } from '@tanstack/react-db';
import { sourceSchemas } from '../src/ui/data-schemas.ts';
import { zListItemsResponse, zHopper, zSubscription, zAuthorization } from '../sdk/dist/schemas.js';

let db: typeof import('../src/ui/data.ts');
let revision = 0;
let epoch = 'test';
let text = 'original';
let missing = false;
let failWrite = false;
let failRead = false;
let orphanMember = false;
let invalidItem = false;
let releaseWrite: (() => void) | undefined;
let writeGate: Promise<void> | undefined;
const requests: { path: string; params: URLSearchParams }[] = [];
const views: { cleanup(): Promise<void> | void }[] = [];
const item = () => ({ id: 'a', content_md: text, kind: 'fragment' as const, status: 'draft' as const, created: '2026-10-06', updated: '2026-10-06', version: 0, dirty: false, responses: 'default' as const, highlight: 'default' as const, provenance: [], stub_of: null, forked_from: null, fork_cite: null, pins: [] });
const detail = (): Detail => ({ ...item(), authored_kind: 'fragment', media: [], versions: [], published: null });
const hopper = { id: 'h', name: 'Hopper', public: false, slug: null, created: '2026-10-06', slug_frozen: false, description: null };
const contents = () => ({ hopper, items: Array.from({ length: 4 }, (_, i) => ({ subscription_id: 's', remote_id: String(i), content_html: `${text} ${i}`, content_md: text, kind: 'fragment', state: 'current', version: 1, created: null, updated: null, observed_at: '2026-10-06', content_hash: null, author_json: null, media_json: null, transclusions_json: null, l0: false, pinned_version_retained: null, page: null, stub_of_json: null, forked_from_json: null, generated_json: null })), memberships: Array.from({ length: 4 }, (_, i) => ({ hopper_id: 'h', subscription_id: 's', remote_id: String(i), added_at: '2026-10-06' })), total: 4, source_count: 1 });
const entry = (key: string, kind = 'fragment') => ({ key, source: 'own', kind, withdrawn: false, l0: false, contentHtml: text, displayAt: '2026-10-06' });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  vi.stubGlobal('location', { origin: 'http://studio.test' });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'hidden' }));
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url);
    requests.push({ path: url.pathname, params: url.searchParams });
    if (url.pathname === '/api/changes') return json({ epoch, domains: Object.fromEntries(['items', 'reading', 'hoppers', 'subscriptions', 'signals', 'settings', 'feed'].map((domain) => [domain, revision])) });
    if (url.pathname === '/api/items/a' && request.method === 'PATCH') {
      const body = await request.json();
      await writeGate;
      if (failWrite) return json({ error: 'write failed' }, 503);
      text = body.content_md; revision++;
      return json(item());
    }
    if (url.pathname === '/api/items/a') {
      if (failRead) return json({ error: 'read failed' }, 503);
      return missing ? json({ error: 'not found' }, 404) : json({ ...detail(), ...(invalidItem ? { content_md: 42 } : {}) });
    }
    if (url.pathname === '/api/items') return json({ items: missing ? [] : [{ ...item(), ...(invalidItem ? { content_md: 42 } : {}) }], total: missing ? 0 : 1, offset: 0, limit: 100 });
    if (url.pathname === '/api/hoppers') return json({ items: [hopper], total: 1, offset: 0, limit: 100 });
    if (url.pathname === '/api/hoppers/h') {
      if (missing) return json({ error: 'not found' }, 404);
      const result = contents();
      if (orphanMember) result.memberships.unshift({ hopper_id: 'h', subscription_id: 's', remote_id: 'not-imported', added_at: '2026-10-06' });
      return json(url.searchParams.get('preview') === 'true' ? { ...result, items: result.items.slice(0, 3), memberships: result.memberships.slice(0, 3) } : result);
    }
    if (url.pathname === '/api/reading') {
      const sub = url.searchParams.get('sub') ?? 'all';
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const kind = url.searchParams.get('kind') ?? 'fragment';
      // The same entity is at rank 1 in "all" and rank 0 in "own".
      // Another feed or lens must not overwrite either position.
      const entries = offset > 0 ? [entry('next', kind)] :
        sub === 'all' ? [entry('first', kind), entry('shared', kind)] : [entry('shared', kind)];
      return json({ items: entries, offset, limit: 25, selected: sub === 'invalid' ? 'all' : sub, read_state: true, read_state_clear: true, total: 30, counts: { all: 30, own: 30, subscriptions: {} } });
    }
    if (url.pathname === '/api/mentions/m/source') return json({ holder: 's', subscription: null });
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  db = await import('../src/ui/data.ts');
});

beforeEach(() => { revision = 0; epoch = 'test'; text = 'original'; missing = false; failWrite = false; failRead = false; orphanMember = false; invalidItem = false; writeGate = undefined; releaseWrite = undefined; requests.length = 0; });
afterEach(async () => {
  releaseWrite?.();
  await Promise.all(views.splice(0).map((view) => view.cleanup()));
  await Promise.all(Object.values(db.listViews).map((view) => view.cleanup()));
  await Promise.all([db.items, db.itemHistory, db.hoppers, db.hopperStats, db.hopperEntries, db.hopperMemberships, db.reading, db.mentionSources].map((source) => source.cleanup()));
  db.queryClient.clear();
});
afterAll(() => { db.polling.stop(); db.queryClient.unmount(); vi.unstubAllGlobals(); });

test('editor projections share one item read on open and per changed revision', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  await editor.preload();
  expect(requests.filter((request) => request.path === '/api/items/a')).toHaveLength(1);
  await db.refreshItems();
  expect(requests.filter((request) => request.path === '/api/items/a')).toHaveLength(1);
  text = 'fresh'; revision++;
  await db.changed('items');
  expect(requests.filter((request) => request.path === '/api/items/a')).toHaveLength(2);
  expect(editor.toArray[0].content_md).toBe('fresh');
});

test('hopper projections share each preview and full response per revision', async () => {
  const preview = db.hopperPreview('h'), full = db.hopperDetail('h'); views.push(preview, full);
  await preview.preload();
  const reads = () => requests.filter((request) => request.path === '/api/hoppers/h');
  expect(reads()).toHaveLength(1);
  expect(reads()[0].params.get('preview')).toBe('true');
  await full.preload();
  expect(reads()).toHaveLength(2);
  expect(reads()[1].params.get('preview')).toBeNull();
  await db.refreshHoppers();
  expect(reads()).toHaveLength(2);
  text = 'fresh'; revision++;
  await db.changed('hoppers');
  expect(reads()).toHaveLength(4);
  expect(full.toArray[0].items).toHaveLength(4);
  expect(preview.toArray[0].items).toHaveLength(3);
  expect(full.toArray[0].items[0].content_html).toBe('fresh 0');
});

test('shared owner reads reload after an epoch change with the same revision', async () => {
  const editor = db.itemDetail('a'), hopperView = db.hopperPreview('h'); views.push(editor, hopperView);
  await Promise.all([editor.preload(), hopperView.preload()]);
  epoch = 'restored'; text = 'restored content';
  await Promise.all([db.refreshItems(), db.refreshHoppers()]);
  expect(requests.filter((request) => request.path === '/api/items/a')).toHaveLength(2);
  expect(requests.filter((request) => request.path === '/api/hoppers/h')).toHaveLength(2);
  expect(editor.toArray[0].content_md).toBe('restored content');
  expect(hopperView.toArray[0].items[0].content_html).toBe('restored content 0');
});

test('invalid owner responses are not shared as successful reads and retry at the same revision', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  invalidItem = true;
  await expect(db.preloadView(editor)).rejects.toThrow('expected string');
  expect(db.items.get('a')).toBeUndefined();
  invalidItem = false;
  await db.queryClient.resetQueries({ predicate: (query) => query.state.status === 'error' });
  await db.preloadView(editor);
  expect(editor.toArray[0].content_md).toBe('original');
});

test('editor and list share optimistic item fields and roll back together', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  await Promise.all([db.listViews.items.preload(), editor.preload()]);
  expect(db.itemHistory.get('a')).not.toHaveProperty('content_md');
  writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const transaction = db.items.update('a', (row) => { row.content_md = 'draft'; });
  await vi.waitFor(() => expect(editor.toArray[0].content_md).toBe('draft'));
  expect(db.listViews.items.toArray[0].content_md).toBe('draft');
  failWrite = true; releaseWrite!();
  await expect(transaction.isPersisted.promise).rejects.toThrow('write failed');
  await vi.waitFor(() => expect(editor.toArray[0].content_md).toBe('original'));
  expect(db.listViews.items.toArray[0].content_md).toBe('original');
});

test('item writes persist through the source and removed items leave every view', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  await Promise.all([db.listViews.items.preload(), editor.preload()]);
  const transaction = db.items.update('a', (row) => { row.content_md = 'saved'; });
  await transaction.isPersisted.promise;
  await db.changed('items');
  expect(editor.toArray[0].content_md).toBe('saved');
  expect(db.listViews.items.toArray[0].content_md).toBe('saved');
  missing = true; revision++;
  await db.changed('items');
  expect(editor.toArray).toEqual([]);
  expect(db.listViews.items.toArray).toEqual([]);
});

test('list polls do not start detail sources without a subscribed demand', async () => {
  await db.listViews.items.preload();
  requests.length = 0;
  await db.refreshItems();
  expect(requests.map((request) => request.path)).toEqual(['/api/changes']);
});

test('route preload and locally sorted list share one backend demand', async () => {
  const sorted = createLiveQueryCollection({ query: (q) => q.from({ item: db.items }).orderBy(({ item }) => item.updated, 'desc') });
  views.push(sorted);
  await Promise.all([db.listViews.items.preload(), sorted.preload()]);
  expect(requests.filter((request) => request.path === '/api/items')).toHaveLength(1);
  requests.length = 0;
  await db.refreshItems();
  expect(requests.map((request) => request.path)).toEqual(['/api/changes']);
});

test('route retry restarts a failed detail graph after the Query cache recovers', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  failRead = true;
  await expect(db.preloadView(editor)).rejects.toThrow('read failed');
  failRead = false;
  await db.queryClient.resetQueries({ predicate: (query) => query.state.status === 'error' });
  await db.preloadView(editor);
  expect(editor.toArray[0].content_md).toBe('original');
});

test('missing detail resources produce a route error while source subsets remain empty', async () => {
  missing = true;
  const editor = db.itemDetail('a'), hopper = db.hopperDetail('h'); views.push(editor, hopper);
  await expect(db.preloadDetail(editor, 'Item')).rejects.toThrow('Item not found');
  await expect(db.preloadDetail(hopper, 'Hopper')).rejects.toThrow('Hopper not found');
  expect(editor.toArray).toEqual([]); expect(hopper.toArray).toEqual([]);
});

test('all sources use generated OpenAPI schemas or explicit client extensions', () => {
  for (const [name, schema] of Object.entries(sourceSchemas)) {
    const source = db[name as keyof typeof sourceSchemas];
    expect(source.config.schema).toBe(schema);
  }
  expect(sourceSchemas.items).toBe(zListItemsResponse.shape.items.element);
  expect(sourceSchemas.hoppers).toBe(zHopper);
  expect(sourceSchemas.subscriptions).toBe(zSubscription);
  expect(sourceSchemas.authorizations).toBe(zAuthorization);
});

test('invalid synced rows retain the last good state and retry before the same revision is cached', async () => {
  await db.listViews.items.preload();
  invalidItem = true; text = 'new version'; revision++;
  await expect(db.items.utils.refetch({ throwOnError: true })).rejects.toThrow('expected string');
  expect(db.items.get('a')?.content_md).toBe('original');
  invalidItem = false;
  await db.items.utils.refetch({ throwOnError: true });
  expect(db.items.get('a')?.content_md).toBe('new version');
});

test('Zod rejects invalid local mutations before sending a write', async () => {
  await db.listViews.items.preload(); requests.length = 0;
  expect(() => db.items.update('a', (row) => { Object.assign(row, { kind: 'invalid-kind' }); })).toThrow();
  expect(db.items.get('a')?.kind).toBe('fragment');
  expect(requests).toEqual([]);
});

test('reading feeds, lenses, and pages use one source with independent positions', async () => {
  const all = db.readingView('all', 0), own = db.readingView('own', 0), next = db.readingView('all', 25), threads = db.readingView('all~thread', 0);
  views.push(all, own, next, threads);
  await Promise.all([all, own, next, threads].map((view) => view.preload()));
  expect(all.toArray.find((row) => row.key === 'shared')?.rank).toBe(1);
  expect(own.toArray[0].rank).toBe(0); expect(next.toArray[0].rank).toBe(25);
  expect(threads.toArray.find((row) => row.key === 'shared')?.kind).toBe('thread');
  expect(db.reading.size).toBe(6);
  const reads = requests.filter((request) => request.path === '/api/reading').length;
  await db.refreshReading();
  expect(requests.filter((request) => request.path === '/api/reading')).toHaveLength(reads);
  text = 'remote change'; revision++;
  await db.refreshReading();
  expect([all, own, next, threads].every((view) => view.toArray.every((row) => row.contentHtml === 'remote change'))).toBe(true);
  await own.cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  requests.length = 0; revision++;
  await db.refreshReading();
  expect(requests.filter((request) => request.path === '/api/reading').map((request) => request.params.get('sub'))).not.toContain('own');
  expect(all.toArray.find((row) => row.key === 'shared')?.rank).toBe(1);
});

test('hopper previews demand three entries and detail uses the same source rows', async () => {
  const full = db.hopperDetail('h'), preview = db.hopperPreview('h'); views.push(full, preview);
  await preview.preload();
  expect(preview.toArray[0].items).toHaveLength(3);
  expect(requests.filter((request) => request.path === '/api/hoppers/h').every((request) => request.params.get('preview') === 'true')).toBe(true);
  await full.preload();
  expect(full.toArray[0].items).toHaveLength(4); expect(preview.toArray[0].items).toHaveLength(3);
  expect(db.hopperEntries.size).toBe(4);
  expect(db.hopperStats.get('h')).not.toHaveProperty('hopper');
  db.hoppers.utils.writeUpdate({ id: 'h', name: 'Renamed' });
  await vi.waitFor(() => expect(preview.toArray[0].hopper.name).toBe('Renamed'));
  expect(full.toArray[0].hopper.name).toBe('Renamed');
  text = 'fresh content'; revision++;
  await db.refreshHoppers();
  expect(preview.toArray[0].items[0].content_html).toBe('fresh content 0');
});

test('hopper memberships remain visible when an imported body is absent', async () => {
  orphanMember = true;
  const full = db.hopperDetail('h'), preview = db.hopperPreview('h'); views.push(full, preview);
  await Promise.all([full.preload(), preview.preload()]);
  expect(full.toArray[0].memberships.map((member) => member.remote_id)).toContain('not-imported');
  expect(full.toArray[0].memberships).toHaveLength(5);
  expect(full.toArray[0].items).toHaveLength(4);
  expect(preview.toArray[0].memberships).toHaveLength(3);
  expect(preview.toArray[0].items).toHaveLength(3);
});

test('backend source collections are top-level singletons with on-demand sync', () => {
  const directory = new URL('../src/ui/', import.meta.url);
  let sources = 0;
  const ids = new Set<string>();
  for (const name of readdirSync(directory).filter((name) => /\.tsx?$/.test(name))) {
    const file = ts.createSourceFile(name, readFileSync(new URL(name, directory), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'createCollection') {
        const collectionOptions = node.arguments[0];
        // Command collections store local requests and have no backend query.
        if (ts.isCallExpression(collectionOptions) && collectionOptions.expression.getText(file) === 'localOnlyCollectionOptions') return;
        expect(name).toBe('data.ts');
        expect(ts.isVariableDeclaration(node.parent)).toBe(true);
        expect(ts.isVariableStatement(node.parent.parent.parent)).toBe(true);
        expect(ts.isSourceFile(node.parent.parent.parent.parent)).toBe(true);
        const options = node.arguments[0];
        expect(ts.isCallExpression(options)).toBe(true);
        if (!ts.isCallExpression(options)) return;
        const config = options.arguments[0];
        expect(ts.isObjectLiteralExpression(config)).toBe(true);
        if (!ts.isObjectLiteralExpression(config)) return;
        const properties = new Map(config.properties.filter(ts.isPropertyAssignment).map((property) => [property.name.getText(file), property.initializer]));
        const id = properties.get('id'), syncMode = properties.get('syncMode');
        expect(properties.get('schema')?.getText(file)).toMatch(/^sourceSchemas\./);
        expect(id && ts.isStringLiteral(id)).toBe(true);
        expect(syncMode && ts.isStringLiteral(syncMode) && syncMode.text).toBe('on-demand');
        if (id && ts.isStringLiteral(id)) { expect(ids.has(id.text)).toBe(false); ids.add(id.text); }
        sources++;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  expect(sources).toBeGreaterThan(0);
});

test('mention-source views reuse one on-demand source and requested keys', async () => {
  const first = db.mentionSource('m'), second = db.mentionSource('m'); views.push(first);
  expect(first).toBe(second);
  await Promise.all([first.preload(), second.preload()]);
  expect(first.toArray[0].holder).toBe('s');
  expect(requests.filter((request) => request.path === '/api/mentions/m/source')).toHaveLength(1);
});

test('a missing reading source keeps the requested identity for the router redirect', async () => {
  const view = db.readingView('invalid', 0); views.push(view);
  await view.preload();
  expect(view.toArray).toHaveLength(1);
  expect(db.queryClient.getQueriesData<{ data: { selected: string } }>({ queryKey: ['reading', 'invalid'] })[0][1]?.data.selected).toBe('all');
});
