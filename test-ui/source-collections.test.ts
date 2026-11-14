import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { Detail } from '../src/ui/data.ts';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { createLiveQueryCollection, and, eq } from '@tanstack/react-db';
import { onlineManager } from '@tanstack/query-core';
import { sourceSchemas } from '../src/ui/data-schemas.ts';
import { zListItemsResponse, zHopper, zSubscription, zAuthorization } from '../sdk/dist/schemas.js';
import { READ_BATCH_PATHS, type ReadBatchOperation, type ReadBatchInput } from '../src/read-batch-policy.ts';

let db: typeof import('../src/ui/data.ts');
let revision = 0;
let itemRevision = 1;
let epoch = 'test';
let text = 'original';
let missing = false;
let failWrite = false;
let failRead = false;
let failSummary = false;
let failReading = false;
let importedReading = false;
const readVersions = new Map<string, number>();
const readWrites: { method: string; remoteId: string }[] = [];
const signalWrites: (1 | -1 | null)[] = [];
let signalWriteFailures = 0;
let orphanMember = false;
let invalidItem = false;
let itemCount = 1;
let mentionCount = 0;
let mentionGroupCount = 0;
let receiptsPerGroup = 1;
let outboundCount = 0;
let nullableMentions = false;
const hiddenMentions = new Set<string>();
let itemPins: { version: number; kind: 'fragment' | 'thread' }[] = [];
let signalRows: { subscriptionId: string; remoteId: string; thumb: 1 | -1; at: string }[] = [];
let memberCount = 4;
let versionCount = 0;
let pageRows = 0;
let releaseWrite: (() => void) | undefined;
let writeGate: Promise<void> | undefined;
let detailGate: Promise<void> | undefined;
let detailEntered: (() => void) | undefined;
const requests: { path: string; params: URLSearchParams }[] = [];
const views: { cleanup(): Promise<void> | void }[] = [];
const item = () => ({ id: 'a', revision: itemRevision, contentMd: text, kind: 'fragment' as const, status: 'draft' as const, created: '2026-10-06', updated: '2026-10-06', version: itemPins.length ? 1 : 0, dirty: false, responses: 'default' as const, highlight: 'default' as const, provenance: [], stubOf: null, forkedFrom: null, forkCite: null, pins: itemPins });
const detail = (): Detail => ({ ...item(), kind: 'fragment', media: [], publishedMedia: [], published: null });
const hopper = { id: 'h', name: 'Hopper', public: false, slug: null, created: '2026-10-06', slugFrozen: false, description: null };
const contents = () => ({ hopper, items: Array.from({ length: memberCount }, (_, i) => ({ subscriptionId: 's', remoteId: String(i), contentHtml: `${text} ${i}`, contentMd: text, kind: 'fragment', state: 'current', version: 1, created: null, updated: null, observedAt: '2026-10-06', contentHash: null, author: null, media: null, transclusions: null, l0: false, pinnedVersionRetained: null, page: null, stubOf: null, forkedFrom: null, generated: null })), memberships: Array.from({ length: memberCount }, (_, i) => ({ hopperId: 'h', subscriptionId: 's', remoteId: String(i), addedAt: '2026-10-06' })), total: 4, sourceCount: 1 });
const entry = (key: string, kind = 'fragment') => ({ key, source: 'own', kind, withdrawn: false, l0: false, contentHtml: text, displayAt: '2026-10-06' });
function page<T>(items: T[], query: URLSearchParams, defaultLimit = 100) {
  const start = Number(query.get('cursor') ?? 0), limit = Number(query.get('limit') ?? defaultLimit);
  pageRows += items.slice(start, start + limit).length;
  return { items: items.slice(start, start + limit), page: { limit, nextCursor: start + limit < items.length ? String(start + limit) : null } };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const mentionTarget = (group: number) => group === 0 ? 'a' : `tail-${String(group).padStart(5, '0')}`;
const groupCount = () => mentionGroupCount || (mentionCount ? 1 : 0);
function mentionRows(group: number) {
  return Array.from({ length: receiptsPerGroup }, (_, index) => {
    const id = group === 0 && index === 0 ? 'm' : `m-${String(group).padStart(5, '0')}-${String(index).padStart(5, '0')}`;
    return { id, source: `https://source.test/f/${id}/`, target: `https://studio.test/f/${mentionTarget(group)}/`, targetItemId: mentionTarget(group),
      status: 'verified', relation: 'stub', sourceOrigin: 'https://source.test/', sourceId: 'remote', sourceKind: 'fragment', sourceVersion: 1,
      sourcePage: null, firstSeen: '2026-11-03', lastSeen: '2026-11-03',
      verifiedAt: nullableMentions && index < 2 ? index === 0 ? null : '' : '2026-11-03',
      attempts: 0, error: null, hidden: hiddenMentions.has(id), sourceAuthor: null };
  }).sort((a, b) => a.verifiedAt === b.verifiedAt ? a.id.localeCompare(b.id)
    : a.verifiedAt === null ? 1 : b.verifiedAt === null ? -1 : a.verifiedAt > b.verifiedAt ? -1 : 1);
}
function groupRows() {
  return Array.from({ length: groupCount() }, (_, group) => {
    const rows = mentionRows(group), latest = rows[0];
    return { targetItemId: mentionTarget(group), total: rows.length, visible: rows.filter(row => !row.hidden).length,
      verifiedAt: latest.verifiedAt ?? '', lastSeen: latest.lastSeen, firstId: latest.id };
  }).sort((a, b) => a.firstId.localeCompare(b.firstId));
}

beforeAll(async () => {
  vi.stubGlobal('location', { origin: 'http://studio.test' });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'hidden', getElementById: (id: string) => id === 'studio-root' ? { dataset: { apiBase: '/api' } } : null }));
  vi.stubGlobal('fetch', async function serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/read-batch') {
      const body = await request.json() as { operation: ReadBatchOperation; requests: ReadBatchInput[] };
      return json(await Promise.all(body.requests.map(async child => {
        const path = READ_BATCH_PATHS[body.operation].replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(child.path?.[key] ?? ''));
        const childUrl = new URL('/api' + path, url);
        childUrl.search = new URLSearchParams(child.query).toString();
        const response = await serve(new Request(childUrl));
        return { status: response.status, body: await response.json(), headers: {} };
      })));
    }
    // Logical requests after unpacking the transport; API tests own batch auth.
    requests.push({ path: url.pathname, params: url.searchParams });
    if (url.pathname === '/api/changes') return json({ epoch, domains: Object.fromEntries(['items', 'reading', 'hoppers', 'subscriptions', 'signals', 'settings', 'feed', 'mentions', 'responses', 'interactions', 'browse', 'shelf'].map((domain) => [domain, revision])) });
    if (url.pathname === '/api/items' && request.method === 'POST') {
      const body = await request.json(); text = body.contentMd; revision++; itemCount = 1;
      const { pins, ...created } = item();
      return json(created, 201);
    }
    if (url.pathname === '/api/signals') return json(page(signalRows, url.searchParams));
    if (url.pathname === '/api/signals/s/remote') {
      const thumb = request.method === 'DELETE' ? null : (await request.json()).thumb;
      signalWrites.push(thumb);
      await writeGate;
      if (signalWriteFailures) { signalWriteFailures--; return json({ code: 'internal', message: 'write failed' }, 503); }
      if (failWrite) return json({ code: 'internal', message: 'write failed' }, 503);
      signalRows = thumb === null ? [] : [{ subscriptionId: 's', remoteId: 'remote', thumb, at: '2026-11-03T00:00:00Z' }];
      revision++;
      return json({ ok: true });
    }
    if (url.pathname.startsWith('/api/reading/s/') && url.pathname.endsWith('/read')) {
      const remoteId = url.pathname.slice('/api/reading/s/'.length, -'/read'.length);
      readWrites.push({ method: request.method, remoteId });
      await writeGate;
      if (failWrite) return json({ code: 'internal', message: 'write failed' }, 503);
      if (request.method === 'DELETE') readVersions.delete(remoteId);
      else readVersions.set(remoteId, (await request.json()).version);
      revision++;
      return json({ ok: true });
    }
    if (url.pathname === '/api/items/a' && request.method === 'PATCH') {
      const body = await request.json();
      await writeGate;
      if (failWrite) return json({ code: 'internal', message: 'write failed' }, 503);
      if (body.expectedRevision !== itemRevision) return json({ code: 'revision-conflict', message: 'item revision conflict' }, 409);
      text = body.contentMd; revision++; itemRevision++;
      return json(item());
    }
    if (url.pathname === '/api/items/a' && request.method === 'DELETE') {
      missing = true; revision++;
      return json({ ok: true });
    }
    if (url.pathname === '/api/items/summary') return failSummary
      ? json({ code: 'internal', message: 'summary unavailable' }, 503)
      : json({ all: itemCount, drafts: itemCount, changes: 0, public: 0, withdrawn: 0 });
    if (url.pathname === '/api/items/a/restore' && request.method === 'POST') {
      const body = await request.json();
      if (body.expectedRevision !== itemRevision) return json({ code: 'revision-conflict', message: 'item revision conflict' }, 409);
      text = 'restored text'; revision++; itemRevision++;
      return json({ ok: true, restored: 1, publishesAs: 2, revision: itemRevision });
    }
    if (url.pathname === '/api/items/a/versions') {
      const values = Array.from({ length: versionCount }, (_, index) => ({ itemId: 'a', version: versionCount - index, kind: 'fragment', contentMd: text, contentHtml: text, contentHash: 'hash', publishedAt: '2026-10-31', note: null, transclusions: [], pinned: false, pinnedAt: null, generated: [], stubOf: null, stubCite: null, noteGenerated: false }))
        .filter(row => !url.searchParams.has('version') || row.version === Number(url.searchParams.get('version')));
      return json(page(values, url.searchParams, 25));
    }
    if (url.pathname === '/api/items/a') {
      detailEntered?.(); await detailGate;
      if (failRead) return json({ code: 'internal', message: 'read failed' }, 503);
      return missing ? json({ code: 'not-found', message: 'not found' }, 404) : json({ ...detail(), ...(invalidItem ? { contentMd: 42 } : {}) });
    }
    if (url.pathname.startsWith('/api/items/tail-')) return json({ ...detail(), id: url.pathname.slice('/api/items/'.length) });
    if (url.pathname === '/api/items') {
      const values = missing ? [] : Array.from({ length: itemCount }, (_, i) => ({ ...item(), id: i === 0 ? 'a' : `tail-${String(i).padStart(5, '0')}`, ...(invalidItem ? { contentMd: 42 } : {}) }))
        .sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
        .filter(row => (!url.searchParams.has('id') || row.id === url.searchParams.get('id')) && (!url.searchParams.has('updated') || row.updated === url.searchParams.get('updated')));
      return json(page(values, url.searchParams));
    }
    if (url.pathname === '/api/hoppers') return json(page([hopper], url.searchParams));
    if (url.pathname === '/api/hoppers/h') {
      if (missing) return json({ code: 'not-found', message: 'not found' }, 404);
      return json({ hopper, total: memberCount + (orphanMember ? 1 : 0), sourceCount: 1 });
    }
    if (url.pathname === '/api/hoppers/h/memberships') {
      if (missing) return json({ code: 'not-found', message: 'not found' }, 404);
      const result = contents();
      if (orphanMember) result.memberships.unshift({ hopperId: 'h', subscriptionId: 's', remoteId: 'not-imported', addedAt: '2026-10-06' });
      const byId = new Map(result.items.map(item => [item.remoteId, item]));
      return json(page(result.memberships.map(member => ({ ...member, item: byId.get(member.remoteId) ?? null })), url.searchParams));
    }
    if (url.pathname === '/api/reading/summary') {
      const requested = url.searchParams.get('sub') ?? 'all';
      return json({ counts: { all: 30, own: 30, subscriptions: {} }, selected: requested === 'invalid' ? 'all' : requested });
    }
    if (url.pathname === '/api/reading') {
      if (failReading) return json({ code: 'internal', message: 'readback failed' }, 503);
      const sub = url.searchParams.get('sub') ?? 'all';
      const kind = url.searchParams.get('kind') ?? 'fragment';
      const entries = sub === 'own' ? [entry('shared', kind), ...Array.from({ length: 29 }, (_, i) => entry(`own-${i}`, kind))]
        : [entry('first', kind), entry('shared', kind), ...Array.from({ length: 23 }, (_, i) => entry(`filler-${i}`, kind)), ...Array.from({ length: 5 }, (_, i) => entry(`next-${i}`, kind))];
      const rows = importedReading ? entries.map(row => ({ ...row, source: 'imported', imported: {
        subscriptionId: 's', subscriptionTitle: 'Source', remoteId: row.key, kind: row.kind,
        withdrawn: false, l0: false, updated: null, observedAt: '2026-10-06', contentHtml: text,
        pinnedVersionRetained: null, sourceUrl: null, version: 1, readVersion: readVersions.get(row.key) ?? null,
      } })) : entries;
      return json({ ...page(rows, url.searchParams, 50), readState: true, readStateClear: true });
    }
    if (url.pathname === '/api/freshness') return json({ items: missing ? [] : [{ id: 'a', version: 1, dirty: false, quotes: [], stale: 2, blocking: 0, behind: 3 }] });
    if (url.pathname === '/api/mentions/m/source') return json({ holder: 's', subscription: null });
    if (url.pathname === '/api/mentions/m' && request.method === 'PATCH') {
      const { hidden } = await request.json();
      if (hidden) hiddenMentions.add('m'); else hiddenMentions.delete('m');
      revision++;
      return json({ ok: true, hidden });
    }
    if (url.pathname === '/api/mentions/summary') return json({ inbound: groupCount() * receiptsPerGroup, outbound: outboundCount, groups: groupCount() });
    if (url.pathname === '/api/mention-groups') {
      const rows = groupRows().filter(row => ['targetItemId', 'verifiedAt', 'lastSeen', 'firstId'].every(field =>
        !url.searchParams.has(field) || row[field as keyof typeof row] === url.searchParams.get(field)));
      return json(page(rows, url.searchParams));
    }
    if (url.pathname === '/api/mentions') {
      const rows = url.searchParams.get('direction') === 'inbound'
        ? Array.from({ length: groupCount() }, (_, group) => mentionRows(group)).flat().filter(row =>
          ['targetItemId', 'verifiedAt', 'lastSeen', 'id'].every(field => !url.searchParams.has(field) || row[field as keyof typeof row] === url.searchParams.get(field))
          && (!url.searchParams.has('verifiedAtNull') || row.verifiedAt === null))
        : Array.from({ length: outboundCount }, (_, index) => ({ id: `out-${String(index).padStart(5, '0')}`, itemId: 'a', version: 1, targetVersion: null,
          target: 'https://target.test/', endpoint: null, status: 'pending', attempts: 0, nextAttemptAt: null, lastError: null, created: '2026-11-03' }))
          .filter(row => ['id', 'created'].every(field => !url.searchParams.has(field) || row[field as keyof typeof row] === url.searchParams.get(field)));
      return json({ ...page<unknown>(rows, url.searchParams), direction: url.searchParams.get('direction') });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  db = await import('../src/ui/data.ts');
});

beforeEach(() => { revision = 0; itemRevision = 1; epoch = 'test'; text = 'original'; missing = false; failWrite = false; failRead = false; failSummary = false; failReading = false; importedReading = false; readVersions.clear(); readWrites.length = 0; signalWrites.length = 0; signalWriteFailures = 0; orphanMember = false; invalidItem = false; writeGate = undefined; detailGate = undefined; detailEntered = undefined; releaseWrite = undefined; requests.length = 0; itemCount = 1; mentionCount = 0; mentionGroupCount = 0; receiptsPerGroup = 1; outboundCount = 0; nullableMentions = false; hiddenMentions.clear(); memberCount = 4; versionCount = 0; pageRows = 0; itemPins = []; signalRows = []; });
afterEach(async () => {
  releaseWrite?.();
  await Promise.all(views.splice(0).map((view) => view.cleanup()));
  await Promise.all(Object.values(db.listViews).map((view) => view.cleanup()));
  await db.staleThreadItemsView.cleanup();
  await db.mentionGroupItemsView.cleanup();
  await Promise.all(Object.keys(sourceSchemas).map(name => db[name as keyof typeof sourceSchemas].cleanup()));
  db.queryClient.clear();
});
afterAll(() => { db.queryClient.unmount(); vi.unstubAllGlobals(); });

async function refetch(...prefixes: string[]) {
  await Promise.all(prefixes.map(prefix => db.queryClient.refetchQueries(
    { queryKey: [prefix], type: 'active' },
    { throwOnError: true },
  )));
}

test('editor projections share one item read on open and per changed revision', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  await editor.preload();
  expect(requests.filter((request) => request.path === '/api/items/a')).toHaveLength(1);
  await refetch('items', 'item-history');
  expect(requests.filter((request) => request.path === '/api/items/a')).toHaveLength(1);
  text = 'fresh'; revision++;
  await db.changed('items');
  expect(requests.filter((request) => request.path === '/api/items/a')).toHaveLength(2);
  expect(editor.toArray[0].contentMd).toBe('fresh');
});

test('an open editor does not adopt a foreign revision from polling for its unsaved text', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  await editor.preload();
  const write = db.createDraftAction('a', editor.toArray[0].revision);
  text = 'foreign edit'; itemRevision++; revision++;
  await db.changed('items');
  expect(editor.toArray[0].revision).toBe(2);
  await expect(write({ type: 'save', text: 'local unsaved text' })).rejects.toMatchObject({ statusCode: 409 });
  expect(text).toBe('foreign edit');
  expect(itemRevision).toBe(2);
});

test('an editor advances its revision from each acknowledged local write', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  await editor.preload();
  const write = db.createDraftAction('a', editor.toArray[0].revision);
  expect(await write({ type: 'save', text: 'one' })).toMatchObject({ revision: 2 });
  expect(await write({ type: 'save', text: 'two' })).toMatchObject({ revision: 3 });
  expect(text).toBe('two');
});

test('paced saves update every loaded item view immediately and roll back on failure', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  await Promise.all([db.listViews.items.preload(), editor.preload()]);
  writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const saving = db.createDraftAction('a', 1)({ type: 'save', text: 'local edit' });
  // Register failure handling before releasing the gated persistence call.
  const failed = expect(saving).rejects.toThrow('write failed');
  await vi.waitFor(() => expect(editor.toArray[0].contentMd).toBe('local edit'));
  expect(db.listViews.items.toArray[0].contentMd).toBe('local edit');
  expect(text).toBe('original');
  failWrite = true; releaseWrite!();
  await failed;
  await vi.waitFor(() => expect(editor.toArray[0].contentMd).toBe('original'));
  expect(db.listViews.items.toArray[0].contentMd).toBe('original');
});

test('queued saves confirm rows without reloading an active archive or item detail', async () => {
  itemCount = 251;
  const archive = createLiveQueryCollection(q => q.from({ item: db.items }));
  const editor = db.itemDetail('a'); views.push(archive, editor);
  await Promise.all([archive.preload(), db.listViews.items.preload(), editor.preload()]);
  requests.length = 0;
  writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const write = db.createDraftAction('a', 1);
  const first = write({ type: 'save', text: 'one' });
  await vi.waitFor(() => expect(requests.some(request => request.path === '/api/items/a')).toBe(true));
  const second = write({ type: 'save', text: 'two' });
  await vi.waitFor(() => expect(editor.toArray[0].contentMd).toBe('two'));
  releaseWrite!();
  expect(await first).toMatchObject({ revision: 2 });
  expect(await second).toMatchObject({ revision: 3 });
  expect(editor.toArray[0]).toMatchObject({ contentMd: 'two', revision: 3 });
  expect(archive.toArray.find(row => row.id === 'a')?.contentMd).toBe('two');
  expect(requests.map(request => request.path)).toEqual(['/api/items/a', '/api/items/a']);
});

test('failed aggregate reads cannot undo an acknowledged save or discard', async () => {
  const editor = db.itemDetail('a');
  const summary = createLiveQueryCollection(q => q.from({ summary: db.itemSummary }));
  views.push(editor, summary);
  await Promise.all([editor.preload(), summary.preload()]);
  failSummary = true;
  const write = db.createDraftAction('a', 1);
  await expect(write({ type: 'save', text: 'acknowledged' })).resolves.toMatchObject({ revision: 2 });
  expect(editor.toArray[0].contentMd).toBe('acknowledged');
  expect(db.itemSummary.health.failureReason?.cause).toMatchObject({ message: 'summary unavailable' });
  await expect(write({ type: 'delete' })).resolves.toMatchObject({ ok: true });
  expect(missing).toBe(true);
  expect(db.items.has('a')).toBe(false);
  await vi.waitFor(() => expect(editor.toArray).toEqual([]));
});

test('thumbs change before acknowledgement and roll back rejected writes', async () => {
  await db.listViews.signals.preload();
  writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const transaction = db.setThumb({ sub: 's', remoteId: 'remote', thumb: 1 });
  const failed = expect(transaction.when('settled')).rejects.toThrow('write failed');
  await vi.waitFor(() => expect(db.listViews.signals.toArray[0]?.thumb).toBe(1));
  expect(signalRows).toEqual([]);
  failWrite = true; releaseWrite!(); await failed;
  await vi.waitFor(() => expect(db.listViews.signals.toArray).toEqual([]));
});

test('thumb read-back confirms set, change, and clear before settlement', async () => {
  await db.listViews.signals.preload();
  await db.setThumb({ sub: 's', remoteId: 'remote', thumb: 1 }).when('settled');
  expect(db.listViews.signals.toArray[0]?.thumb).toBe(1);
  await db.setThumb({ sub: 's', remoteId: 'remote', thumb: -1 }).when('settled');
  expect(db.listViews.signals.toArray[0]?.thumb).toBe(-1);
  await db.setThumb({ sub: 's', remoteId: 'remote', thumb: null }).when('settled');
  expect(db.listViews.signals.toArray).toEqual([]);
});

test('rapid thumb intents show at once and persist in order, including clear', async () => {
  await db.listViews.signals.preload();
  writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const first = db.setThumb({ sub: 's', remoteId: 'remote', thumb: 1 });
  await vi.waitFor(() => expect(signalWrites).toEqual([1]));
  const second = db.setThumb({ sub: 's', remoteId: 'remote', thumb: -1 });
  expect(db.signals.toArray[0]?.thumb).toBe(-1);
  const third = db.setThumb({ sub: 's', remoteId: 'remote', thumb: null });
  expect(db.signals.toArray).toEqual([]);
  // Later writes cannot reach the server while its older intent is held.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(signalWrites).toEqual([1]);
  releaseWrite!();
  await Promise.all([first, second, third].map(receipt => receipt.when('settled')));
  expect(signalWrites).toEqual([1, -1, null]);
  expect(signalRows).toEqual([]);
  expect(db.listViews.signals.toArray).toEqual([]);
});

test('empty and unchanged thumb captures still persist the server intent', async () => {
  // The server has a row which this client has not materialized.
  signalRows = [{ subscriptionId: 's', remoteId: 'remote', thumb: 1, at: '2026-11-03T00:00:00Z' }];
  await db.setThumb({ sub: 's', remoteId: 'remote', thumb: null }).when('settled');
  expect(signalRows).toEqual([]);
  expect(signalWrites).toEqual([null]);
  await db.listViews.signals.preload();
  await db.setThumb({ sub: 's', remoteId: 'remote', thumb: 1 }).when('settled');
  await db.setThumb({ sub: 's', remoteId: 'remote', thumb: 1 }).when('settled');
  expect(signalWrites).toEqual([null, 1, 1]);
});

test('a rejected older thumb does not discard the newer queued intent', async () => {
  await db.listViews.signals.preload();
  signalWriteFailures = 1;
  writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const first = db.setThumb({ sub: 's', remoteId: 'remote', thumb: 1 });
  const failed = expect(first.when('settled')).rejects.toThrow('write failed');
  const second = db.setThumb({ sub: 's', remoteId: 'remote', thumb: -1 });
  releaseWrite!();
  await failed;
  await second.when('settled');
  expect(signalWrites).toEqual([1, -1]);
  expect(signalRows[0]?.thumb).toBe(-1);
  expect(db.signals.toArray[0]?.thumb).toBe(-1);
});

test('read marking persists off-page and unchanged rows instead of skipping its mutationFn', async () => {
  importedReading = true;
  const view = db.readingView('all', 0); views.push(view);
  await view.preload();
  expect(db.reading.toArray.some(row => row.key === 'next-4')).toBe(false);
  const writes = { read: [{ sub: 's', remoteId: 'next-4', version: 1 }], unread: [] };
  await db.markReading({ keys: ['next-4'], read: true, writes }).when('settled');
  expect(readVersions.get('next-4')).toBe(1);
  const loaded = { read: [{ sub: 's', remoteId: 'first', version: 1 }], unread: [] };
  await db.markReading({ keys: ['first'], read: true, writes: loaded }).when('settled');
  await db.markReading({ keys: ['first'], read: true, writes: loaded }).when('settled');
  expect(readWrites.map(write => write.remoteId)).toEqual(['next-4', 'first', 'first']);
});

test('read marking is optimistic and rejects a failed confirmation after the server write', async () => {
  importedReading = true;
  const view = db.readingView('all', 0); views.push(view);
  await view.preload();
  writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const mutation = db.markReading({ keys: ['first'], read: true,
    writes: { read: [{ sub: 's', remoteId: 'first', version: 1 }], unread: [] } });
  const failed = expect(mutation.when('settled')).rejects.toThrow('readback failed');
  expect(view.toArray[0].imported?.readVersion).toBe(1);
  failReading = true; releaseWrite!();
  await failed;
  expect(readVersions.get('first')).toBe(1);
  await vi.waitFor(() => expect(view.toArray[0].imported?.readVersion).toBeNull());
  failReading = false;
  await db.changed('reading');
  await vi.waitFor(() => expect(view.toArray[0].imported?.readVersion).toBe(1));
});

test('read and unread intents remain ordered when their writes overlap', async () => {
  importedReading = true;
  const view = db.readingView('all', 0); views.push(view);
  await view.preload();
  writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const first = db.markReading({ keys: ['first'], read: true,
    writes: { read: [{ sub: 's', remoteId: 'first', version: 1 }], unread: [] } });
  await vi.waitFor(() => expect(readWrites).toHaveLength(1));
  const last = db.markReading({ keys: ['first'], read: false,
    writes: { read: [], unread: [{ sub: 's', remoteId: 'first' }] } });
  expect(view.toArray[0].imported?.readVersion).toBeNull();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(readWrites).toHaveLength(1);
  releaseWrite!();
  await Promise.all([first.when('settled'), last.when('settled')]);
  expect(readWrites.map(write => write.method)).toEqual(['PUT', 'DELETE']);
  expect(readVersions.has('first')).toBe(false);
  expect(view.toArray[0].imported?.readVersion).toBeNull();
});

test('a paused confirmation cannot acknowledge an optimistic read mark', async () => {
  importedReading = true;
  const view = db.readingView('all', 0); views.push(view);
  await view.preload();
  onlineManager.setOnline(false);
  try {
    const mutation = db.markReading({ keys: ['first'], read: true,
      writes: { read: [{ sub: 's', remoteId: 'first', version: 1 }], unread: [] } });
    await expect(mutation.when('settled')).rejects.toThrow('Could not confirm changes while offline');
    expect(readVersions.get('first')).toBe(1);
    expect(view.toArray[0].imported?.readVersion).toBeNull();
  } finally { onlineManager.setOnline(true); }
});

test('updates preload only asks for labels belonging to the stale queue', async () => {
  itemCount = 5_000;
  await db.preloadStaleThreads();
  expect(db.staleThreadItemsView.toArray[0]).toMatchObject({ freshness: { id: 'a', behind: 3 }, item: { id: 'a' } });
  expect(requests.filter(request => request.path === '/api/items')).toEqual([]);
  expect(requests.filter(request => request.path === '/api/items/a')).toHaveLength(1);
  expect(db.items.size).toBe(1);
  revision++; text = 'changed label';
  await db.changed('items');
  await vi.waitFor(() => expect(db.staleThreadItemsView.toArray[0].item?.contentMd).toBe('changed label'));
});

test('restore read-back cannot grant a queued old-text save a foreign revision', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  await editor.preload();
  const write = db.createDraftAction('a', editor.toArray[0].revision);
  let release!: () => void;
  const entered = new Promise<void>(resolve => { detailEntered = resolve; });
  detailGate = new Promise<void>(resolve => { release = resolve; });
  const restoring = write({ type: 'restore', version: 1 });
  await entered;
  text = 'foreign edit after restore'; itemRevision++; revision++;
  // Navigation's Draft.save captures local text while restore is still pending.
  const queued = write({ type: 'save', text: 'old local text' });
  const results = Promise.allSettled([restoring, queued]);
  release();
  expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(text).toBe('foreign edit after restore');
});

test('hopper projections share summary and membership pages per revision', async () => {
  const preview = db.hopperPreview('h'), full = db.hopperDetail('h'); views.push(preview, full);
  await preview.preload();
  const reads = () => requests.filter((request) => request.path === '/api/hoppers/h');
  expect(reads()).toHaveLength(1);
  expect(requests.filter(request => request.path === '/api/hoppers/h/memberships')[0].params.get('limit')).toBe('3');
  await full.preload();
  expect(reads()).toHaveLength(1);
  expect(requests.filter(request => request.path === '/api/hoppers/h/memberships')).toHaveLength(2);
  await refetch('hoppers', 'hopper-stats', 'hopper-entries', 'hopper-memberships');
  expect(reads()).toHaveLength(1);
  text = 'fresh'; revision++;
  await db.changed('hoppers');
  expect(reads()).toHaveLength(2);
  expect(full.toArray[0].items).toHaveLength(4);
  expect(preview.toArray[0].items).toHaveLength(3);
  expect(full.toArray[0].items[0].contentHtml).toBe('fresh 0');
});

test('shared owner reads reload after an epoch change with the same revision', async () => {
  const editor = db.itemDetail('a'), hopperView = db.hopperPreview('h'); views.push(editor, hopperView);
  await Promise.all([editor.preload(), hopperView.preload()]);
  epoch = 'restored'; text = 'restored content';
  await Promise.all([refetch('items', 'item-history'), refetch('hoppers', 'hopper-stats', 'hopper-entries', 'hopper-memberships')]);
  expect(requests.filter((request) => request.path === '/api/items/a')).toHaveLength(2);
  expect(requests.filter((request) => request.path === '/api/hoppers/h')).toHaveLength(2);
  expect(editor.toArray[0].contentMd).toBe('restored content');
  expect(hopperView.toArray[0].items[0].contentHtml).toBe('restored content 0');
});

test('invalid owner responses are not shared as successful reads and retry at the same revision', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  invalidItem = true;
  await expect(db.preloadView(editor)).rejects.toThrow('expected string');
  expect(db.items.get('a')).toBeUndefined();
  invalidItem = false;
  await db.queryClient.resetQueries({ predicate: (query) => query.state.status === 'error' });
  await db.preloadView(editor);
  expect(editor.toArray[0].contentMd).toBe('original');
});

test('editor and list share optimistic item fields and roll back together', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  await Promise.all([db.listViews.items.preload(), editor.preload()]);
  expect(db.itemHistory.get('a')).not.toHaveProperty("contentMd");
  writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const transaction = db.items.update('a', (row) => { row.contentMd = 'draft'; });
  await vi.waitFor(() => expect(editor.toArray[0].contentMd).toBe('draft'));
  expect(db.listViews.items.toArray[0].contentMd).toBe('draft');
  failWrite = true; releaseWrite!();
  await expect(transaction.when('settled')).rejects.toThrow('write failed');
  await vi.waitFor(() => expect(editor.toArray[0].contentMd).toBe('original'));
  expect(db.listViews.items.toArray[0].contentMd).toBe('original');
});

test('item writes persist through the source and removed items leave every view', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  await Promise.all([db.listViews.items.preload(), editor.preload()]);
  const transaction = db.items.update('a', (row) => { row.contentMd = 'saved'; });
  await transaction.when('settled');
  expect(editor.toArray[0].contentMd).toBe('saved');
  expect(db.listViews.items.toArray[0].contentMd).toBe('saved');
  missing = true; revision++;
  await db.changed('items');
  expect(editor.toArray).toEqual([]);
  await vi.waitFor(() => expect(db.listViews.items.toArray).toEqual([]));
});

test('list polls do not start detail sources without a subscribed demand', async () => {
  await db.listViews.items.preload();
  requests.length = 0;
  await refetch('items', 'item-history');
  expect(requests.map((request) => request.path)).toEqual(['/api/changes']);
});

test('route preload and sorted list share a backend sequence and exact boundary read', async () => {
  const sorted = createLiveQueryCollection({ query: (q) => q.from({ item: db.items }).orderBy(({ item }) => item.updated, 'desc') });
  views.push(sorted);
  await Promise.all([db.listViews.items.preload(), sorted.preload()]);
  expect(requests.filter(request => request.path === '/api/items' && !request.params.has('id'))).toHaveLength(1);
  expect(requests.filter(request => request.path === '/api/items' && request.params.get('id') === 'a')).toHaveLength(1);
  requests.length = 0;
  await refetch('items', 'item-history');
  expect(requests.map((request) => request.path)).toEqual(['/api/changes']);
});

test('route retry restarts a failed detail graph after the Query cache recovers', async () => {
  const editor = db.itemDetail('a'); views.push(editor);
  failRead = true;
  await expect(db.preloadView(editor)).rejects.toThrow('read failed');
  failRead = false;
  await db.queryClient.resetQueries({ predicate: (query) => query.state.status === 'error' });
  await db.preloadView(editor);
  expect(editor.toArray[0].contentMd).toBe('original');
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
  expect(sourceSchemas.items.parse(item())).toMatchObject({ ...item(), orderKey: expect.any(String) });
  expect(zListItemsResponse.shape.items.element.safeParse(item()).success).toBe(true);
  expect(sourceSchemas.hoppers).toBe(zHopper);
  expect(sourceSchemas.subscriptions).toBe(zSubscription);
  expect(sourceSchemas.authorizations).toBe(zAuthorization);
});

test('invalid synced rows retain the last good state and retry before the same revision is cached', async () => {
  await db.listViews.items.preload();
  invalidItem = true; text = 'new version'; revision++;
  await expect(db.items.utils.refetch({ throwOnError: true })).rejects.toThrow('expected string');
  expect(db.items.get('a')?.contentMd).toBe('original');
  invalidItem = false;
  await db.items.utils.refetch({ throwOnError: true });
  expect(db.items.get('a')?.contentMd).toBe('new version');
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
  expect(db.reading.size).toBe(80);
  const reads = requests.filter((request) => request.path === '/api/reading').length;
  await refetch('reading');
  expect(requests.filter((request) => request.path === '/api/reading')).toHaveLength(reads);
  text = 'remote change'; revision++;
  await refetch('reading');
  expect([all, own, next, threads].every((view) => view.toArray.every((row) => row.contentHtml === 'remote change'))).toBe(true);
  await own.cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  requests.length = 0; revision++;
  await refetch('reading');
  expect(requests.filter((request) => request.path === '/api/reading').map((request) => request.params.get('sub'))).not.toContain('own');
  expect(all.toArray.find((row) => row.key === 'shared')?.rank).toBe(1);
});

test('hopper previews demand three entries and detail uses the same source rows', async () => {
  const full = db.hopperDetail('h'), preview = db.hopperPreview('h'); views.push(full, preview);
  await preview.preload();
  expect(preview.toArray[0].items).toHaveLength(3);
  expect(requests.filter((request) => request.path === '/api/hoppers/h/memberships').every((request) => request.params.get('limit') === '3')).toBe(true);
  await full.preload();
  expect(full.toArray[0].items).toHaveLength(4); expect(preview.toArray[0].items).toHaveLength(3);
  expect(db.hopperEntries.size).toBe(4);
  expect(db.hopperStats.get('h')).not.toHaveProperty('hopper');
  await db.hoppers.utils.writeUpdate({ id: 'h', name: 'Renamed' });
  await vi.waitFor(() => expect(preview.toArray[0].hopper.name).toBe('Renamed'));
  expect(full.toArray[0].hopper.name).toBe('Renamed');
  text = 'fresh content'; revision++;
  await refetch('hoppers', 'hopper-stats', 'hopper-entries', 'hopper-memberships');
  expect(preview.toArray[0].items[0].contentHtml).toBe('fresh content 0');
});

test('hopper memberships remain visible when an imported body is absent', async () => {
  orphanMember = true;
  const full = db.hopperDetail('h'), preview = db.hopperPreview('h'); views.push(full, preview);
  await Promise.all([full.preload(), preview.preload()]);
  expect(full.toArray[0].memberships.map((member) => member.remoteId)).toContain('not-imported');
  expect(full.toArray[0].memberships).toHaveLength(5);
  expect(full.toArray[0].items).toHaveLength(4);
  expect(preview.toArray[0].memberships).toHaveLength(3);
  expect(preview.toArray[0].items).toHaveLength(2);
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

test('mention preload fetches target labels without waiting for source cards or the unrelated archive', async () => {
  itemCount = 5_000;
  mentionCount = 1;
  await db.preloadMentions();
  expect(requests.filter(request => request.path === '/api/items')).toEqual([]);
  expect(requests.filter(request => request.path === '/api/items/a')).toHaveLength(1);
  expect(requests.filter(request => request.path === '/api/mentions/m/source')).toEqual([]);
  expect(db.items.size).toBe(1);
});

test('mention groups stay bounded and grow beyond the preloaded window with complete counts', async () => {
  itemCount = 5_000; mentionGroupCount = 300; receiptsPerGroup = 150; outboundCount = 800;
  await db.preloadMentions();
  expect(db.mentionGroupItemsView.toArray).toHaveLength(11);
  expect(db.mentionGroups.size).toBeLessThanOrEqual(12);
  expect(db.items.size).toBeLessThanOrEqual(12);
  expect(db.mentionSummary.toArray[0]).toMatchObject({ inbound: 45_000, outbound: 800, groups: 300 });
  expect(requests.filter(request => request.path === '/api/mentions')).toEqual([]);
  await db.mentionGroupItemsView.utils.setWindow({ offset: 0, limit: 51 });
  expect(db.mentionGroupItemsView.toArray.map(row => row.group.targetItemId)).toEqual(Array.from({ length: 51 }, (_, index) => mentionTarget(index)));
  expect(db.mentionGroups.size).toBeLessThanOrEqual(52);
  expect(db.items.size).toBeLessThanOrEqual(52);
  expect(requests.filter(request => request.path === '/api/mentions')).toEqual([]);
});

test('a receipt window only loads its target and grows without draining a large group', async () => {
  mentionGroupCount = 50; receiptsPerGroup = 150;
  const view = createLiveQueryCollection(q => q.from({ mention: db.inbound })
    .where(({ mention }) => eq(mention.targetItemId, 'a'))
    .orderBy(({ mention }) => mention.orderKey, { direction: 'asc', stringSort: 'lexical' }).limit(10));
  views.push(view); await view.preload();
  expect(view.toArray).toHaveLength(10);
  expect(db.inbound.size).toBeLessThanOrEqual(11);
  expect(pageRows).toBeLessThan(30);
  await view.utils.setWindow({ offset: 0, limit: 30 });
  expect(view.toArray.map(row => row.id)).toEqual(mentionRows(0).slice(0, 30).map(row => row.id));
  expect(db.inbound.size).toBeLessThanOrEqual(31);
  expect(requests.filter(request => request.path === '/api/mentions').every(request => request.params.get('targetItemId') === 'a')).toBe(true);
  expect(requests.filter(request => request.path === '/api/mentions/summary')).toEqual([]);
});

test('receipt boundary requests distinguish null verification dates from empty strings', async () => {
  mentionCount = 1; receiptsPerGroup = 13; nullableMentions = true;
  for (const value of [null, '']) {
    const row = mentionRows(0).find(row => row.verifiedAt === value)!;
    const key = sourceSchemas.inbound.parse(row).orderKey;
    const view = createLiveQueryCollection(q => q.from({ mention: db.inbound })
      .where(({ mention }) => and(eq(mention.targetItemId, 'a'), eq(mention.orderKey, key))));
    views.push(view); await view.preload();
    expect(view.toArray.map(row => row.verifiedAt)).toEqual([value]);
  }
  const reads = requests.filter(request => request.path === '/api/mentions');
  expect(reads.some(request => request.params.get('verifiedAtNull') === 'true' && !request.params.has('verifiedAt'))).toBe(true);
  expect(reads.some(request => request.params.has('verifiedAt') && request.params.get('verifiedAt') === '' && !request.params.has('verifiedAtNull'))).toBe(true);
});

test('a hidden receipt confirms the group visible count without changing its total', async () => {
  mentionCount = 1; receiptsPerGroup = 150;
  await db.preloadMentions();
  const view = createLiveQueryCollection(q => q.from({ mention: db.inbound })
    .where(({ mention }) => eq(mention.targetItemId, 'a'))
    .orderBy(({ mention }) => mention.orderKey, { direction: 'asc', stringSort: 'lexical' }).limit(10));
  views.push(view); await view.preload();
  expect(db.mentionGroups.get('a')).toMatchObject({ total: 150, visible: 150 });
  await db.inbound.update('m', row => { row.hidden = true; }).when('settled');
  expect(db.mentionGroups.get('a')).toMatchObject({ total: 150, visible: 149 });
  expect(view.toArray[0].hidden).toBe(true);
});

test('outbound mention windows remain bounded across tied creation dates', async () => {
  outboundCount = 1_000;
  const view = createLiveQueryCollection(q => q.from({ mention: db.outbound })
    .orderBy(({ mention }) => mention.orderKey, { direction: 'asc', stringSort: 'lexical' }).limit(25));
  views.push(view); await view.preload();
  expect(view.toArray).toHaveLength(25);
  expect(db.outbound.size).toBeLessThanOrEqual(26);
  await view.utils.setWindow({ offset: 0, limit: 50 });
  expect(view.toArray.map(row => row.id)).toEqual(Array.from({ length: 50 }, (_, index) => `out-${String(index).padStart(5, '0')}`));
  expect(db.outbound.size).toBeLessThanOrEqual(51);
});

test('mention lists and source cards re-read only when their revisions move', async () => {
  mentionCount = 1; outboundCount = 1;
  const view = db.mentionSource('m'); views.push(view);
  const incoming = createLiveQueryCollection(q => q.from({ mention: db.inbound })
    .where(({ mention }) => eq(mention.targetItemId, 'a'))
    .orderBy(({ mention }) => mention.orderKey, { direction: 'asc', stringSort: 'lexical' }).limit(10));
  const outgoing = createLiveQueryCollection(q => q.from({ mention: db.outbound })
    .orderBy(({ mention }) => mention.orderKey, { direction: 'asc', stringSort: 'lexical' }).limit(25));
  views.push(incoming, outgoing);
  await Promise.all([incoming.preload(), outgoing.preload(), view.preload()]);
  const reads = (path: string) => requests.filter((request) => request.path === path).length;
  const counts = () => [reads('/api/mentions'), reads('/api/mentions/m/source')];
  const initial = counts();
  expect(initial[0]).toBeGreaterThanOrEqual(2);
  expect(initial[1]).toBe(1);
  // An unchanged tick answers from the cached responses after one revision check each.
  await Promise.all([db.inbound.utils.refetch(), db.outbound.utils.refetch(), db.mentionSources.utils.refetch()]);
  expect(counts()).toEqual(initial);
  revision++;
  await Promise.all([db.inbound.utils.refetch(), db.outbound.utils.refetch(), db.mentionSources.utils.refetch()]);
  expect(counts()).toEqual(initial.map(count => count * 2));
  await Promise.all([db.inbound.cleanup(), db.outbound.cleanup()]);
});

test('a missing reading source keeps the requested identity for the router redirect', async () => {
  const view = db.readingView('invalid', 0), summary = db.readingSummaryView('invalid'); views.push(view, summary);
  await Promise.all([view.preload(), summary.preload()]);
  expect(view.toArray).toHaveLength(25);
  expect(view.toArray.every(row => row.view === 'invalid')).toBe(true);
  expect(summary.toArray[0]).toMatchObject({ view: 'invalid', selected: 'all', total: 30 });
});

test('native windows stay bounded across a large timestamp tie and grow in the server order', async () => {
  itemCount = 5_000;
  const view = createLiveQueryCollection(q => q.from({ item: db.items })
    .orderBy(({ item }) => item.orderKey, { direction: 'asc', stringSort: 'lexical' }).limit(25));
  views.push(view);
  await view.preload();
  expect(view.toArray).toHaveLength(25);
  expect(pageRows).toBeLessThanOrEqual(26);
  await view.utils.setWindow({ offset: 0, limit: 50 });
  expect(view.toArray.map(row => row.id)).toEqual(Array.from({ length: 50 }, (_, i) => `tail-${String(4_999 - i).padStart(5, '0')}`));
  expect(pageRows).toBeLessThanOrEqual(52);
  expect(db.items.size).toBeLessThanOrEqual(50);
  expect(requests.filter(request => request.path === '/api/items').every(request => !request.params.has('offset'))).toBe(true);
});

test('membership windows acquire only their bounded cohort as the view grows', async () => {
  memberCount = 5_000;
  const view = createLiveQueryCollection(q => q.from({ member: db.hopperMemberships })
    .where(({ member }) => eq(member.hopperId, 'h')).orderBy(({ member }) => member.rank, 'asc').limit(25));
  views.push(view); await view.preload();
  expect(view.toArray).toHaveLength(25); expect(pageRows).toBeLessThanOrEqual(26);
  await view.utils.setWindow({ offset: 0, limit: 50 });
  expect(view.toArray.map(row => row.remoteId)).toEqual(Array.from({ length: 50 }, (_, i) => String(i)));
  expect(pageRows).toBeLessThanOrEqual(52); expect(db.hopperMemberships.size).toBeLessThanOrEqual(50);
});

test('history windows acquire only requested versions and exact boundaries', async () => {
  versionCount = 5_000;
  const view = createLiveQueryCollection(q => q.from({ version: db.itemVersions })
    .where(({ version }) => eq(version.itemId, 'a')).orderBy(({ version }) => version.version, { direction: 'desc', stringSort: 'lexical' }).limit(25));
  views.push(view); await view.preload();
  expect(view.toArray).toHaveLength(25); expect(pageRows).toBeLessThanOrEqual(26);
  await view.utils.setWindow({ offset: 0, limit: 50 });
  expect(view.toArray.map(row => row.version)).toEqual(Array.from({ length: 50 }, (_, i) => 5_000 - i));
  expect(pageRows).toBeLessThanOrEqual(52); expect(db.itemVersions.size).toBeLessThanOrEqual(50);
});

// Write DTOs do not carry the pin summaries projected by list/get reads.
test('first draft save accepts a write DTO and advances the next acknowledged revision', async () => {
  itemCount = 0; await db.listViews.items.preload();
  const write = db.createDraftAction();
  expect(await write({ type: 'save', text: 'first save', kind: 'fragment' })).toMatchObject({ id: 'a', revision: 1 });
  expect(db.items.get('a')).toMatchObject({ contentMd: 'first save' });
  expect(await write({ type: 'save', text: 'second save', kind: 'fragment' })).toMatchObject({ id: 'a', revision: 2 });
  expect(db.items.get('a')?.contentMd).toBe('second save');
});

test('a fork write DTO can enter the item collection before its detail is loaded', async () => {
  itemCount = 0; await db.listViews.items.preload();
  const { pins, ...fork } = item();
  await db.items.utils.writeUpsert({ ...fork, pins: [] });
  expect(db.items.get('a')).toMatchObject({ id: 'a', contentMd: 'original' });
});

test('an existing item save preserves cached pin summaries', async () => {
  itemPins = [{ version: 1, kind: 'fragment' }];
  await db.listViews.items.preload();
  await db.createDraftAction('a', 1)({ type: 'save', text: 'pinned save' });
  expect(db.items.get('a')?.pins).toEqual([{ version: 1, kind: 'fragment' }]);
});

test('saving an unloaded published item obtains its pin summaries instead of clearing them', async () => {
  itemCount = 0; await db.listViews.items.preload();
  itemCount = 1; itemPins = [{ version: 1, kind: 'fragment' }];
  await db.createDraftAction('a', 1)({ type: 'save', text: 'unloaded pinned save' });
  expect(requests.filter(request => request.path === '/api/items/a').length).toBeGreaterThan(0);
  expect(db.items.get('a')?.pins).toEqual(itemPins);
});

test('a create or save after the item source was collected confirms on the server and continues (#142)', async () => {
  const { createItem } = await import('../src/ui/server-mutations.ts');
  itemCount = 0; await db.listViews.items.preload();
  await db.listViews.items.cleanup(); await db.items.cleanup();
  expect(db.items.status).toBe('cleaned-up');
  await expect(createItem({ kind: 'thread', contentMd: 'stub draft' })).resolves.toMatchObject({ id: 'a' });
  await expect(db.createDraftAction()({ type: 'save', text: 'first save', kind: 'fragment' })).resolves.toMatchObject({ id: 'a' });
});
