/**
 * Studio search keeps working and published words separate, indexes eligible
 * imports through their lifecycle, and applies literal substring queries before
 * returning cursor pages. This oracle owns searchOperation and search-terms.
 *
 * ```ts
 * GET('/search?q=indexprevious') // → the publication during an unpublished edit
 * GET('/search?q=indexreplacement&include=drafts') // → the working copy
 * GET('/search?q=INDEX ORBLEF ld') // → a row matching all terms across ID and body
 * GET('/search?q=ld') // → no hits; a blank query still browses
 * GET('/search?q=common-in-other-subscription&sub=pick-a') // → only pick-a, under 100 row reads
 * ```
 * A retained pin stays searchable after an import becomes a tombstone; replacing
 * its text must remove its old terms. Working edits must not replace published
 * terms until publication. The model stores those source facts as ordinary
 * strings and matches with includes, without SQL, FTS, or production helpers.
 * For every tested source history, returned identities and continuation agree
 * with those facts (docs/search.md and PR #146's original search tests).
 * For every original indexed-work witness, each selected source is looked up
 * once and fewer than 100 source rows are read, including continuation pages.
 *
 * Histories preserve the PR's short-term, quoted-term, URL, pin, republish and
 * withdrawal witnesses. Own changes use real PATCH/publish/withdraw requests;
 * imported fixtures write source tables. The D1 driver calls the
 * same read operation as REST; a transparent meter records native rows_read and
 * EXPLAIN. Backup histories read a real owner archive and restore its source
 * rows in both item/version orders, without copying derived search state.
 * For every such restore, search returns the same identities and archived
 * tables exclude derived search data (Venkatesh Rao, vgururao, PR #146 review,
 * 2026-11-20). A restore with triggers disabled requires the documented rebuild.
 * Limits: finite source histories and local D1; remote migration application,
 * billed work, arbitrary Unicode folding and a shipped restore UI are separate.
 */
import { env, SELF } from 'cloudflare:test';
import { differs, oracleProperty, pass, type Observation } from '@tanstack/oracles';
import { readOperations } from '../src/read-api.ts';
import { apiJson, BASE, STUDIO, login } from './helpers.ts';
import { withOracleStorage } from './oracle-storage.ts';

type Query = { q: string; include?: string; source?: string; sub?: string; sort?: string; limit?: string; cursor?: string };
type Action = { op: 'query'; query: Query } | { op: 'edit' | 'publish' | 'withdraw' | 'remove-import' } | { op: 'import'; body: string; retained: boolean };
const own = 'index-own', imported = 'index-pickaold', url = 'https://example.com/a/very/long/literal-path-that-was-too-long-for-sql-like';
const firstBody = `first-index-body ${url} x"y orbleflux`;
const initial = { working: 'indexprevious publication', published: 'indexprevious publication', visible: true, body: firstBody, held: true };
const query = (q: string, options: Omit<Query, 'q'> = {}): Action => ({ op: 'query', query: { q, ...options } });
const histories: { name: string; actions: Action[] }[] = [
  { name: 'literal substrings and short terms', actions: [query('PICKA ORBLEF ld', { sub: 'pick-a' }), query('PICKA ORBLEF xx', { sub: 'pick-a' }), query('ld'), query('', { sub: 'pick-a' }), query(url), query('x"y'), query('x"z'), query('orble%flux'), query('_orbleflux'), query('index\0ignored'), query('indexprevious index\0ignored')] },
  { name: 'retained import and delete', actions: [query('first-index-body'), { op: 'import', body: 'pinned-index-body', retained: true }, query('first-index-body'), query('pinned-index-body'), { op: 'remove-import' }, query('pinned-index-body')] },
  { name: 'ineligible tombstone', actions: [{ op: 'import', body: 'unretained-index-body', retained: false }, query('unretained-index-body')] },
  { name: 'working edit republish withdraw', actions: [query('indexprevious'), { op: 'edit' }, query('indexprevious'), query('indexprevious', { include: 'drafts' }), query('indexreplacement'), query('indexreplacement', { include: 'drafts' }), { op: 'publish' }, query('indexprevious'), query('indexreplacement'), { op: 'withdraw' }, query('indexreplacement'), query('indexreplacement', { include: 'drafts' })] },
];
// Only source facts survive between actions. No derived index state is modeled.
function model(plan: typeof histories[number]) {
  const state = { ...initial }, results: string[][] = [];
  for (const action of plan.actions) switch (action.op) {
    case 'edit': state.working = 'indexreplacement working copy'; break;
    case 'publish': state.published = state.working; break;
    case 'withdraw': state.visible = false; break;
    case 'import': state.body = action.body; state.held = action.retained; break;
    case 'remove-import': state.held = false; break;
    case 'query': {
      const q = action.query, words = q.q.trim().split(/\s+/).filter(Boolean);
      const candidates = [
        { id: own, body: q.include === 'drafts' ? state.working : state.published, eligible: state.visible && q.source !== 'imported' && !q.sub },
        { id: imported, body: state.body, eligible: state.held && q.source !== 'mine' && (!q.sub || q.sub === 'pick-a') },
      ];
      results.push(candidates.filter(row => row.eligible && (!words.length || words.some(word => !word.includes('\0') && [...word].length >= 3)) && words.every(word => [row.id, row.body].some(text => text.toLowerCase().includes(word.toLowerCase())))).map(row => row.id).sort());
    }
  }
  return results;
}
const context = (db = env.DB) => ({ env: { ...env, DB: db }, url: `${BASE}/blyg/api/search`, access: null, extensions: [], defer() {} });
async function seed() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,created) VALUES('pick-a','blyg','https://a.example/','https://a.example/feed.xml','2026-01-01')"),
    env.DB.prepare("INSERT INTO items(id,kind,status,created,updated,version,content_md) VALUES(?,'fragment','public','2026-01-01','2026-01-01',1,?)").bind(own, initial.working),
    env.DB.prepare("INSERT INTO versions(item_id,version,content_md,content_html,content_hash,published_at) VALUES(?,1,?,'<p>publication</p>','hash','2026-01-01')").bind(own, initial.published),
    env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_md) VALUES('pick-a',?,'fragment','current',1,'2026-01-01',?)").bind(imported, firstBody),
  ]);
}
async function search(q: Query, db = env.DB) {
  return readOperations.search(context(db), { path: {}, query: q });
}
const complete = (trace: readonly Observation[]) => trace.some(entry => entry.checkpoint === 'complete');
const law = 'source search identities';
oracleProperty({
  id: 'search-index-source-history', owns: ['src/read-api.ts#searchOperation', 'src/search-terms.ts'],
  law: { statement: 'For every enumerated source history, literal conjunctive substring searches return exactly eligible imported or selected own-copy identities; short-only queries return no hits and blank queries browse.', authority: 'docs/search.md; PR #146 original picker-search and search-drafts tests.', limits: 'Finite original ASCII source histories, terms and copy transitions; not arbitrary Unicode folding or concurrent publication.' },
  histories, label: plan => plan.name, model,
  driver: async (plan, observe) => {
    await withOracleStorage(async () => {
      await seed(); const cookie = await login();
      async function mutate(method: string, suffix: string, body?: unknown) {
        try {
          const result = await apiJson(cookie, method, `/blyg/api/items/${own}${suffix}`, body);
          observe('source mutation', result.status);
        } catch (error) { observe('source mutation', { error: String(error) }); }
      }
      for (const action of plan.actions) switch (action.op) {
        case 'edit': await mutate('PATCH', '', { contentMd: 'indexreplacement working copy' }); break;
        case 'publish': await mutate('POST', '/publish', {}); break;
        case 'withdraw': await mutate('POST', '/withdraw', {}); break;
        case 'import': await env.DB.prepare("UPDATE imported_items SET state='tombstone',pinned_version_retained=?,content_md=? WHERE remote_id=?").bind(action.retained ? 1 : null, action.body, imported).run(); break;
        case 'remove-import': await env.DB.prepare('DELETE FROM imported_items WHERE remote_id=?').bind(imported).run(); break;
        case 'query': {
          try {
            const result = await search(action.query);
            observe('search result', result.ok ? { ids: result.value.items.map(row => row.id).sort(), more: result.value.page.nextCursor !== null } : { error: result });
          } catch (error) { observe('search result', { error: String(error) }); }
        }
      }
    });
    observe('complete', true);
  },
  check: (_plan, trace, expected) => {
    for (const entry of trace.filter(entry => entry.checkpoint === 'source mutation')) { const bad = differs(entry.checkpoint, law, entry.value, 200); if (bad) return bad; }
    const rows = trace.filter(entry => entry.checkpoint === 'search result');
    for (let i = 0; i < rows.length; i++) { const bad = differs('search result', law, rows[i].value, { ids: expected[i], more: false }); if (bad) return bad; }
    return complete(trace) ? differs('complete', law, rows.length, expected.length) ?? pass : pass;
  },
  calibrations: [{ name: 'retained pin loses its replacement', law, history: { enumerated: 1 }, corrupt: trace => trace.map((entry, index) => entry.checkpoint === 'search result' && index === 2 ? { ...entry, value: { ids: [], more: false } } : entry) }],
});

// The meter observes native statement work, not elapsed time or modeled costs.
function measured() {
  const reads: { rows: number; lookups: number }[] = [];
  const wrap = (stmt: D1PreparedStatement, sql: string, binds: unknown[] = []): D1PreparedStatement => new Proxy(stmt, { get(target, key) {
    if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
    if (key === 'all' && sql.includes('cursor_source')) return async () => {
      const result = await target.all();
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
      reads.push({ rows: result.meta.rows_read, lookups: plan.results.filter(row => row.detail.includes('SCAN f VIRTUAL TABLE INDEX')).length });
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { db, reads };
}
// Model the same source facts by sorting an array and slicing it, independently
// of SQL cursor ranges and FTS. Page widths expose terminal and nonterminal tails.
const workLaw = 'indexed search work';
type WorkPlan = { noise: number; limit: number };
function workModel(plan: WorkPlan) {
  const rows = [
    { id: own, source: 'mine', sub: '', updated: '2026-12-01', body: 'orbleflux' },
    { id: imported, source: 'imported', sub: 'pick-a', updated: '2026-01-01', body: firstBody },
    { id: 'work-new', source: 'imported', sub: 'pick-a', updated: '2026-02-01', body: 'orbleflux' },
    { id: 'one-scoped-match', source: 'imported', sub: 'pick-a', updated: '2026-01-01', body: 'common-in-other-subscription' },
  ];
  function pages(q: string, source = 'all', sub = '', oldest = false, limit = plan.limit) {
    const matched = rows.filter(row => (source === 'all' || row.source === source) && (!sub || row.sub === sub) && row.body.includes(q)).sort((a, b) => (a.updated.localeCompare(b.updated) || a.id.localeCompare(b.id)) * (oldest ? 1 : -1));
    return Array.from({ length: Math.min(2, Math.ceil(matched.length / limit)) }, (_, page) => ({ ids: matched.slice(page * limit, (page + 1) * limit).map(row => row.id), more: (page + 1) * limit < matched.length, statements: 1, lookups: source === 'all' && !sub ? 2 : 1 }));
  }
  return [...pages('orbleflux'), ...pages('common-in-other-subscription', 'all', 'pick-a', false, 20), ...pages('orbleflux', 'imported', '', true)];
}
oracleProperty({
  id: 'search-index-bounded-work', owns: ['src/read-api.ts#searchOperation', 'src/cursor-page.ts#cursorPage'],
  law: { statement: 'For every original scoped and paged search witness, return the exact ordered source identities with fewer than 100 D1 source row reads and one FTS lookup per selected source on each page.', authority: 'PR #146 picker-search indexed-work witness; docs/search.md Cost.', limits: 'Local D1 rows_read and query plans for a 1000-row unrelated fixture; not billed D1 work or elapsed latency.' },
  histories: [{ noise: 500, limit: 1 }, { noise: 500, limit: 2 }],
  model: workModel,
  driver: async (plan, observe) => {
    await withOracleStorage(async () => {
      await seed();
      await env.DB.batch([
        env.DB.prepare("UPDATE items SET updated='2026-12-01',content_md='orbleflux' WHERE id=?").bind(own),
        env.DB.prepare("UPDATE versions SET content_md='orbleflux' WHERE item_id=?").bind(own),
        env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,created) VALUES('pick-aa','blyg','https://aa.example/','https://aa.example/feed.xml','2026-01-01')"),
        env.DB.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n < ?)
          INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_md)
          SELECT CASE WHEN n<=? THEN 'pick-a' ELSE 'pick-aa' END,'unrelated-'||n,'fragment','current',1,'2026-01-01',CASE WHEN n<=? THEN 'unrelated body' ELSE 'common-in-other-subscription' END FROM numbers`).bind(plan.noise * 2, plan.noise, plan.noise),
        env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_md) VALUES('pick-a','one-scoped-match','fragment','current',1,'2026-01-01','common-in-other-subscription'),('pick-a','work-new','fragment','current',1,'2026-02-01','orbleflux')"),
      ]);
      const meter = measured();
      async function call(q: Query) {
        try {
          const start = meter.reads.length, result = await search(q, meter.db), reads = meter.reads.slice(start);
          observe('indexed page', result.ok ? { ids: result.value.items.map(row => row.id), more: result.value.page.nextCursor !== null, reads: reads.reduce((sum, read) => sum + read.rows, 0), statements: reads.length, lookups: reads.reduce((sum, read) => sum + read.lookups, 0) } : { error: result });
          return result.ok ? result.value.page.nextCursor : null;
        } catch (error) { observe('indexed page', { error: String(error) }); return null; }
      }
      // Limit=1 exposes both the merged-source and imported-only continuation.
      const q = { q: 'orbleflux', limit: String(plan.limit) }, first = await call(q);
      if (first) await call({ ...q, cursor: first });
      await call({ q: 'common-in-other-subscription', sub: 'pick-a' });
      const oldest = { ...q, source: 'imported', sort: 'oldest' }, next = await call(oldest);
      if (next) await call({ ...oldest, cursor: next });
    }); observe('complete', true);
  },
  check: (_plan, trace, expected) => {
    const rows = trace.filter(entry => entry.checkpoint === 'indexed page');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i].value as { reads: number };
      const bad = differs('indexed page', workLaw, { ...row, reads: undefined }, { ...expected[i], reads: undefined }) ?? differs('indexed page', workLaw, Number.isFinite(row.reads) && row.reads < 100, true); if (bad) return bad;
    }
    return complete(trace) ? differs('complete', workLaw, rows.length, expected.length) ?? pass : pass;
  },
  calibrations: [
    { name: 'right rows after scanning other subscriptions', law: workLaw, history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'indexed page' ? { ...entry, value: { ...(entry.value as object), reads: 501 } } : entry) },
    { name: 'discarded duplicate source statement', law: workLaw, history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'indexed page' ? { ...entry, value: { ...(entry.value as object), statements: 2 } } : entry) },
    { name: 'reused prior metric without a source statement', law: workLaw, history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'indexed page' ? { ...entry, value: { ...(entry.value as object), statements: 0 } } : entry) },
  ],
});

// Parse only the archive transport here; expected search identities remain the
// source facts above. Header/checksum correctness belongs to backup.test.ts.
function archiveTables(bytes: Uint8Array) {
  const decoder = new TextDecoder(), rows = new Map<string, Record<string, unknown>[]>();
  const text = (at: number, size: number) => decoder.decode(bytes.subarray(at, at + size)).replace(/\0.*$/s, '');
  for (let at = 0; at + 512 <= bytes.length && bytes[at];) {
    const name = text(at, 100), size = parseInt(text(at + 124, 12), 8), table = name.match(/^blyg-backup\/tables\/([^/]+)\//)?.[1];
    if (table) rows.set(table, [...(rows.get(table) ?? []), ...text(at + 512, size).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))]);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return rows;
}
const restoreLaw = 'restored search';
oracleProperty({
  id: 'search-index-backup-restore', owns: ['src/backup-format.ts#excludedTable', 'src/read-api.ts#searchOperation'],
  law: { statement: 'For every tested source-table restore order, the backup excludes derived search tables and restored sources produce the same search identities through the installed triggers.', authority: 'Venkatesh Rao (vgururao), PR #146 review 2026-11-20: derived search data stays out of backup; restore must leave search working.', limits: 'Real local owner backup, items/versions/subscriptions/imported_items, both item/version orders, triggers enabled; remote migration and a future restore UI are separate.' },
  histories: [['items', 'versions', 'subscriptions', 'imported_items'], ['subscriptions', 'imported_items', 'versions', 'items']],
  model: () => ({ ids: [imported, own].sort(), derivedTables: [] }),
  driver: async (order, observe) => {
    await withOracleStorage(async () => {
      await seed(); const cookie = await login();
      const response = await SELF.fetch(`${BASE}${STUDIO}/backup`, { headers: { cookie } });
      observe('backup status', response.status);
      const tables = archiveTables(new Uint8Array(await response.arrayBuffer()));
      const derivedTables = [...tables.keys()].filter(name => name.startsWith('search_'));
      await env.DB.batch(['versions', 'items', 'imported_items', 'subscriptions'].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
      // Empty search first proves that restored results cannot be stale FTS hits.
      const empty = await search({ q: 'index' }); observe('empty search', empty.ok ? empty.value.items.map(row => row.id) : empty);
      for (const table of order) for (const row of tables.get(table) ?? []) {
        const columns = Object.keys(row), quoted = columns.map(name => '"' + name.replaceAll('"', '""') + '"');
        await env.DB.prepare(`INSERT INTO ${table}(${quoted.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).bind(...columns.map(name => row[name])).run();
      }
      const result = await search({ q: 'index' });
      observe('restored search', result.ok ? { ids: result.value.items.map(row => row.id).sort(), derivedTables } : { error: result });
    }); observe('complete', true);
  },
  check: (_plan, trace, expected) => {
    for (const entry of trace) {
      const wanted = entry.checkpoint === 'backup status' ? 200 : entry.checkpoint === 'empty search' ? [] : entry.checkpoint === 'restored search' ? expected : undefined;
      if (wanted !== undefined) { const bad = differs(entry.checkpoint, restoreLaw, entry.value, wanted); if (bad) return bad; }
    }
    return complete(trace) ? differs('complete', restoreLaw, trace.filter(entry => entry.checkpoint === 'restored search').length, 1) ?? pass : pass;
  },
  calibrations: [{ name: 'restore loses imported index entries', law: restoreLaw, history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'restored search' ? { ...entry, value: { ids: [own], derivedTables: [] } } : entry) }],
});
