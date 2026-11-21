/**
 * Contract: design v3 P1–P10/R1–R9 and minute feed/daily maintenance jobs.
 * Reference: polling-cache-oracle-model.ts.
 * Driver: real D1/R2 bindings, real makeApp feed HTTP routes and internal change-state reads, and direct
 * source SQL. Provider gates delay completed reads/conditional puts, never
 * manufacture expected XML or source revisions. Comparisons observe parsed
 * RSS, saved bytes/generation, HTTP validators and counted statement work.
 * History grammar: repeated metadata/body values, INSERT/UPDATE/DELETE, failed
 * and competing builds, cold cache, stable versus interrupted render, epochs.
 * Calibration: wrong source/domain/value answers are rejected at named public
 * checkpoints; additional production-mutant controls are documented separately.
 * Limits: local workerd D1/R2 is a receiving fixture, not deployed Cloudflare;
 * it does not establish quotas, global single-flight or bounded stale time.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { oracleProperty, differs, pass, type Observation, type Verdict } from '@tanstack/oracles';
import { withOracleStorage } from './oracle-storage.ts';
import { withOracleCleanup } from './oracle-cleanup.ts';
import fc from 'fast-check';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import worker, { makeApp } from '../src/index.ts';
import { readChanges, readFeedRevision } from '../src/changes.ts';
import type { Env } from '../src/types.ts';
import { BASE, login } from './helpers.ts';

import { changedDomains, FeedReference, type FeedFacts, type OracleDomain, type OracleToken } from './polling-cache-oracle-model.ts';
import { triggerFamilies, triggerFields } from './polling-cache-trigger-cases.ts';
import resetEpochSql from '../scripts/reset-change-epoch.sql?raw';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const app = makeApp('/blyg');
let triggerDefinitions: string[] = [];
beforeAll(async () => {
  triggerDefinitions = (await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'change_%'").all<{ sql: string }>()).results.map(row => row.sql);
});
beforeEach(async () => {
  // The pool shares storage within this file. Restore deliberate fault fixtures
  // and reset only tables owned by this oracle, before running a new history.
  for (const sql of triggerDefinitions) await env.DB.prepare(sql.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS ')).run();
  await env.DB.prepare('INSERT OR IGNORE INTO change_state(id) VALUES(1)').run();
  await env.DB.prepare("UPDATE change_state SET epoch=lower(hex(randomblob(16))),items=0,reading=0,subscriptions=0,hoppers=0,signals=0,settings=0,feed=0,mentions=0,responses=0,interactions=0,browse=0,shelf=0 WHERE id=1").run();
  await env.DB.batch(['versions','media','items','settings','hopper_items','signals','read_state','imported_items','subscriptions','hoppers','mentions_in','mentions_out','interactions','browse_log','shelf','shelf_revision','item_syndication'].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  await clearArtifacts();
});
afterEach(() => vi.useRealTimers());
async function request(bindings: Env = env, headers: HeadersInit = {}, method = 'GET') {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`${BASE}/blyg/feed.xml`, { headers, method }), bindings, ctx);
  return { response, finish: () => waitOnExecutionContext(ctx) };
}
type Observe = (checkpoint: string, value: unknown) => void;
async function changes(_cookie: string, observe: Observe): Promise<OracleToken> {
  const state = await readChanges(env.DB);
  observe('change-state read', typeof state.epoch === 'string' && typeof state.domains === 'object');
  return state;
}
function facts(xml: string, observe: Observe): FeedFacts {
  observe('RSS syntax', XMLValidator.validate(xml) === true);
  const channel = new XMLParser({ ignoreAttributes: false, parseTagValue: false, isArray: name => name === 'item' }).parse(xml).rss.channel;
  return { title: channel.title, bio: channel.description, body: channel.item?.[0]?.description ?? '' };
}
async function seed() {
  await clearArtifacts();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings(key,value) VALUES('site_title','A') ON CONFLICT(key) DO UPDATE SET value='A'"),
    env.DB.prepare("INSERT INTO settings(key,value) VALUES('author_bio','bio-A') ON CONFLICT(key) DO UPDATE SET value='bio-A'"),
    env.DB.prepare("INSERT INTO items(id,kind,status,created,updated,version,content_md) VALUES('cache-item','fragment','public','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1,'body-A') ON CONFLICT(id) DO UPDATE SET status='public',kind='fragment',version=1,content_md='body-A'"),
    env.DB.prepare("INSERT INTO versions(item_id,version,content_md,content_html,content_hash,published_at) VALUES('cache-item',1,'body-A','<p>body-A</p>','hash','2026-01-01T00:00:00Z') ON CONFLICT(item_id,version) DO UPDATE SET content_md='body-A',content_html='<p>body-A</p>'"),
  ]);
}
async function setFacts(value: string) {
  await env.DB.batch([
    env.DB.prepare("UPDATE settings SET value=? WHERE key='site_title'").bind(value),
    env.DB.prepare("UPDATE settings SET value=? WHERE key='author_bio'").bind(`bio-${value}`),
    env.DB.prepare("UPDATE versions SET content_md=?,content_html=? WHERE item_id='cache-item' AND version=1").bind(`body-${value}`, `<p>body-${value}</p>`),
  ]);
}
const expected = (value: string): FeedFacts => ({ title: value, bio: `bio-${value}`, body: `<p>body-${value}</p>` });
// Transparent provider wrappers count actual statements and allow a completed
// read to pause before the caller receives it. Expected values come from facts.
function observedDB(after?: (sql: string) => Promise<void>) {
  const statements: string[] = [];
  const sqlByStatement = new WeakMap<D1PreparedStatement, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...args: Parameters<D1PreparedStatement['bind']>) => wrap(target.bind(...args), sql);
      if (['all', 'first', 'run', 'raw'].includes(String(property))) return async (...args: unknown[]) => {
        statements.push(sql);
        const value = await (target[property as 'all'] as (...args: unknown[]) => Promise<unknown>).apply(target, args);
        await after?.(sql);
        return value;
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    },
    }); sqlByStatement.set(proxy, sql); return proxy;
  };
  const db = new Proxy(env.DB, { get(target, property) {
    if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === 'batch') return async (batch: D1PreparedStatement[]) => { statements.push(...batch.map(stmt => sqlByStatement.get(stmt) ?? 'UNKNOWN BATCH STATEMENT')); return target.batch(batch); };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { db, statements };
}
function observedBucket(beforePut?: () => Promise<void>) {
  let puts = 0;
  const bucket = new Proxy(env.MEDIA, { get(target, property) {
    if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => { puts++; await beforePut?.(); return target.put(...args); };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { bucket, puts: () => puts };
}
async function clearArtifacts() {
  const objects = await env.MEDIA.list({ prefix: '__cache/feed/' });
  if (objects.objects.length) await env.MEDIA.delete(objects.objects.map(object => object.key));
}
async function generation() {
  const row = await env.DB.prepare('SELECT epoch, feed FROM change_state WHERE id = 1').first<{ epoch: string; feed: number }>();
  if (!row) throw new Error('oracle source state missing');
  return { epoch: row.epoch, revision: row.feed };
}
// Epochs and ETags are opaque equality identities, not stable expected strings.
// Assigning handles retains all same/different relations without leaking random
// epochs into deterministic traces. Feed source tokens are controlled inputs to
// the cache, separately judged by the trigger properties below.
function identities() {
  const epochs = new Map<string, number>(), tags = new Map<string, number>();
  const handle = (map: Map<string, number>, value: string) => { if (!map.has(value)) map.set(value, map.size); return map.get(value)!; };
  return { epoch: (value: string) => handle(epochs, value), tag: (value: string) => handle(tags, value) };
}
async function saved(observe: Observe, ids: ReturnType<typeof identities>) {
  const objects = await env.MEDIA.list({ prefix: '__cache/feed/' });
  observe('saved artifact count', objects.objects.length);
  if (!objects.objects[0]) return undefined;
  const object = await env.MEDIA.get(objects.objects[0].key);
  if (!object) throw new Error('oracle saved artifact disappeared');
  const xml = await object.text(), epoch = object.customMetadata?.epoch ?? '', revision = Number(object.customMetadata?.revision);
  const comment = xml.match(/^<\?xml[^>]*\?>\n<!-- cache-generation:([a-f0-9]+) -->/);
  let binding: unknown;
  if (comment) {
    const bytes = Uint8Array.from(comment[1].match(/../g)!, pair => parseInt(pair, 16));
    try { const decoded = JSON.parse(new TextDecoder().decode(bytes)); binding = Array.isArray(decoded) ? [decoded[0], ids.epoch(decoded[1]), decoded[2]] : decoded; }
    catch (error) { binding = { error: error instanceof Error ? error.message : String(error) }; }
  }
  observe('feed generation bytes', { binding, metadata: [object.customMetadata?.renderer, ids.epoch(epoch), revision] });
  return { xml, epoch: ids.epoch(epoch), revision, etag: ids.tag(object.httpEtag), facts: facts(xml, observe), bytes: xml.replace(/<!-- cache-generation:[a-f0-9]+ -->/, '<!-- generation separately observed -->') };
}
const values = (trace: readonly Observation[], checkpoint: string) => trace.filter(entry => entry.checkpoint === checkpoint).map(entry => entry.value);
function common(trace: readonly Observation[], law: string): Verdict | undefined {
  for (const entry of trace) {
    if (entry.checkpoint === 'change-state read') { const mismatch = differs(entry.checkpoint, law, entry.value, true); if (mismatch) return mismatch; }
    if (entry.checkpoint === 'receiving response status') {
      const mismatch = differs(entry.checkpoint, law, entry.value, 200); if (mismatch) return mismatch;
    }
    if (entry.checkpoint === 'RSS syntax') { const mismatch = differs('RSS syntax', law, entry.value, true); if (mismatch) return mismatch; }
    if (entry.checkpoint === 'saved artifact count') { const mismatch = differs(entry.checkpoint, law, entry.value, 1); if (mismatch) return mismatch; }
    if (entry.checkpoint === 'feed generation bytes') {
      const value = entry.value as { binding: unknown; metadata: unknown };
      const mismatch = differs(entry.checkpoint, law, value.binding, value.metadata); if (mismatch) return mismatch;
    }
  }
}
const domainDelta = (before: OracleToken, after: OracleToken) => ({ domains: changedDomains(before, after).sort(), advances: Object.keys(before.domains).filter(domain => after.domains[domain as OracleDomain] > before.domains[domain as OracleDomain]).sort(), sameEpoch: before.epoch === after.epoch });
async function thrown(operation: () => Promise<unknown>) {
  // Only the promised production call is captured. Fixture and cleanup errors
  // remain their original runner errors, with their cause/secondary diagnostics.
  try { await operation(); return undefined; } catch (error) { return error instanceof Error ? { name: error.name, message: error.message } : { name: 'ThrownValue', message: String(error) }; }
}

async function stored(observe: Observe, operation: () => Promise<void>) {
  await withOracleStorage(operation);
  observe('history complete', true);
}
const complete = (trace: readonly Observation[]) => values(trace, 'history complete').length > 0;

// An effect history names source operations, never expected counter answers.
// The handwritten response-dependency matrix is the independent model. Each
// table/column/event row survives as its own bounded receiving history.
type EffectPlan = { table: string; event?: 'insert' | 'update' | 'remove'; field?: string; value?: string | number; published?: boolean };
const effectPlans: EffectPlan[] = [
  ...triggerFields.map(field => ({ table: triggerFamilies[field.family].table, field: field.field, value: field.value })),
  ...triggerFamilies.map(family => ({ table: family.table })),
  { table: 'items', event: 'remove', published: true },
];
function effectModel(plan: EffectPlan) {
  const family = triggerFamilies.find(family => family.table === plan.table)!;
  const field = triggerFields.find(field => triggerFamilies[field.family].table === plan.table && field.field === plan.field);
  const domains = [...(field?.domains ?? family.domains)].sort();
  return Array.from({ length: plan.field || plan.event ? 1 : 3 }, () => ({ domains, advances: plan.field ? undefined : domains, sameEpoch: true }));
}
async function effectDriver(plan: EffectPlan, observe: Observe, removeTrigger = false) {
  await stored(observe, async () => {
    const family = triggerFamilies.find(family => family.table === plan.table)!, cookie = await login();
    if (plan.published) {
      await seed(); if (removeTrigger) await env.DB.exec('DROP TRIGGER change_items_delete');
      const before = await changes(cookie, observe);
      await env.DB.prepare("DELETE FROM items WHERE id='cache-item'").run();
      observe('trigger exact domain effects', domainDelta(before, await changes(cookie, observe))); return;
    }
    if (plan.field) {
      await env.DB.prepare(family.insert).run();
      if (family.table === 'items') await env.DB.prepare(family.update).run();
      const before = await changes(cookie, observe);
      await env.DB.prepare(`UPDATE ${family.table} SET ${plan.field}=?`).bind(plan.value).run();
      observe('trigger exact domain effects', domainDelta(before, await changes(cookie, observe))); return;
    }
    for (const event of plan.event ? [plan.event] : ['insert', 'update', 'remove'] as const) {
      const before = await changes(cookie, observe); await env.DB.prepare(family[event]).run();
      observe('trigger exact domain effects', domainDelta(before, await changes(cookie, observe)));
    }
  });
}
oracleProperty({
  id: 'polling-cache-receiving', owns: ['src/changes.ts', 'src/feed-cache.ts'],
  law: { statement: 'For every named tracked source effect, exactly the domains whose receiving responses depend on that effect advance in the same epoch; every declared affected counter increases.', authority: 'docs/d1-polling-cache-design.md P2/P3/R1 and independent polling-cache-trigger-cases.ts response dependency matrix', limits: 'The complete original finite table/column/event matrix against local D1, not all future schema fields or deployed billing.' },
  histories: effectPlans, label: plan => plan.field ? `tracks ${plan.table}.${plan.field} independently` : plan.published ? 'published item deletion' : `${plan.table}: direct insert/update/delete effect family`,
  model: effectModel, driver: effectDriver,
  check: (_plan, trace, expected) => {
    const law = 'trigger exact domain effects'; const invalid = common(trace, law); if (invalid) return invalid;
    const rows = values(trace, law) as ReturnType<typeof domainDelta>[];
    for (let index = 0; index < rows.length; index++) {
      const wanted = expected[index]; if (!wanted) return differs(law, law, rows.length, expected.length)!;
      const mismatch = differs(law, law, { domains: rows[index].domains, advances: wanted.advances ? rows[index].advances : undefined, sameEpoch: rows[index].sameEpoch }, wanted); if (mismatch) return mismatch;
    }
    return complete(trace) ? differs('history complete', law, rows.length, expected.length) ?? pass : pass;
  },
  calibrations: [
    ...[[], ['subscriptions', 'feed'], ['reading']].map((domains, index) => ({ name: `missing extra or stale domains ${index}`, law: 'trigger exact domain effects', history: { enumerated: 0 }, corrupt: (trace: readonly Observation[]) => trace.map(entry => entry.checkpoint === 'trigger exact domain effects' ? { ...entry, value: { ...(entry.value as object), domains } } : entry) })),
    { name: 'actual missing-delete trigger', law: 'trigger exact domain effects', history: { enumerated: effectPlans.length - 1 }, driver: (plan, observe) => effectDriver(plan, observe, true) },
  ],
});

// Missing state and overflow are transaction laws: a failed tracked write must
// leave its source untouched. The history changes only the state fault or event;
// the same model and receiving comparison apply to every table.
type AtomicPlan = { table: string; event: 'insert' | 'update' | 'remove'; fault: 'missing' | 'overflow' };
const atomicPlans: AtomicPlan[] = triggerFamilies.flatMap(family => (['insert', 'update', 'remove'] as const).map(event => ({ table: family.table, event, fault: 'missing' as const })));
atomicPlans.push({ table: 'items', event: 'update', fault: 'overflow' });
oracleProperty({
  id: 'polling-cache-atomic', owns: ['src/changes.ts'],
  law: { statement: 'For every tracked insert, update or deletion with absent change state or an overflowing counter, the write rejects and the transaction preserves its prior source rows.', authority: 'docs/d1-polling-cache-design.md R1; original missing-state/overflow receiving matrix', limits: 'All original table/event faults, MAX_SAFE_INTEGER items overflow and native blob reader faults; local D1.' },
  histories: atomicPlans, label: plan => `${plan.table}: ${plan.fault} state rejects ${plan.event}`,
  model: plan => ({ rejected: true, writes: plan.fault === 'overflow' ? 2 : 1 }),
  driver: async (plan, observe) => stored(observe, async () => {
    if (plan.fault === 'overflow') {
      await seed();
      await env.DB.prepare('UPDATE change_state SET items=9007199254740991 WHERE id=1').run();
      const beforeItem = await env.DB.prepare("SELECT content_md FROM items WHERE id='cache-item'").first();
      const itemError = await thrown(() => env.DB.prepare("UPDATE items SET content_md='overflow' WHERE id='cache-item'").run());
      observe('atomic tracked write', { error: itemError, before: beforeItem, after: await env.DB.prepare("SELECT content_md FROM items WHERE id='cache-item'").first() });
      await env.DB.prepare('DELETE FROM change_state WHERE id=1').run();
      const beforeTitle = await env.DB.prepare("SELECT value FROM settings WHERE key='site_title'").first();
      const titleError = await thrown(() => env.DB.prepare("UPDATE settings SET value='lost' WHERE key='site_title'").run());
      observe('atomic tracked write', { error: titleError, before: beforeTitle, after: await env.DB.prepare("SELECT value FROM settings WHERE key='site_title'").first() });
      return;
    }
    const family = triggerFamilies.find(family => family.table === plan.table)!;
    if (plan.event !== 'insert') await env.DB.prepare(family.insert).run();
    const before = (await env.DB.prepare(`SELECT * FROM ${plan.table} ORDER BY rowid`).all()).results;
    await env.DB.prepare('DELETE FROM change_state WHERE id=1').run();
    const error = await thrown(() => env.DB.prepare(family[plan.event]).run());
    const after = (await env.DB.prepare(`SELECT * FROM ${plan.table} ORDER BY rowid`).all()).results;
    observe('atomic tracked write', { error, before, after });
  }),
  check: (_plan, trace, expected) => {
    for (const entry of trace) if (entry.checkpoint === 'atomic tracked write') {
      const value = entry.value as { error: unknown; before: unknown; after: unknown };
      const bad = differs(entry.checkpoint, 'atomic tracked write', Boolean(value.error), expected.rejected) ?? differs(entry.checkpoint, 'atomic tracked write', value.after, value.before); if (bad) return bad;
    }
    return complete(trace) ? differs('history complete', 'atomic tracked write', values(trace, 'atomic tracked write').length, expected.writes) ?? pass : pass;
  },
  calibrations: [{ name: 'source commits after rejected write', law: 'atomic tracked write', history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'atomic tracked write' ? { ...entry, value: { ...(entry.value as object), after: ['committed despite missing state'] } } : entry) }],
});

// Schema columns are environment inputs to the guard obligation. The model
// reads only that input, not the produced trigger definition. One formula
// predicts the required null-safe guard for every current column.
oracleProperty({
  id: 'polling-cache-schema', owns: ['src/changes.ts'],
  law: { statement: 'For every current column of a tracked source table, its UPDATE trigger includes an OLD IS NOT NEW guard so an unchanged value is distinguished from a changed value, including NULL.', authority: 'docs/d1-polling-cache-design.md R1; existing current-column guard oracle', limits: 'SQL guard declaration plus receiving effects; does not independently prove all SQLite parser semantics.' },
  histories: triggerFamilies.map(family => family.table),
  model: (_table, trace) => (values(trace, 'input source columns')[0] as string[] | undefined ?? []).map(column => `OLD."${column}" IS NOT NEW."${column}"`),
  driver: async (table, observe) => {
    const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    observe('input source columns', columns.results.map(column => column.name));
    const trigger = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").bind(`change_${table}_update`).first<{ sql: string }>();
    observe('source update guard', trigger?.sql ?? null); observe('history complete', true);
  },
  check: (_table, trace, expected) => {
    const guards = values(trace, 'source update guard');
    for (const guard of guards) {
      const text = typeof guard === 'string' ? guard : '';
      const missing = expected.filter(term => !text.includes(term));
      const bad = differs('source update guard', 'null-safe source guards', { present: Boolean(guard), missing }, { present: true, missing: [] }); if (bad) return bad;
    }
    return complete(trace) ? differs('history complete', 'null-safe source guards', guards.length, 1) ?? pass : pass;
  },
  calibrations: [{ name: 'column guard omitted', law: 'null-safe source guards', history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'source update guard' ? { ...entry, value: '' } : entry) }],
});

// These are source actions, rather than case identifiers. The model maps each
// action to its response dependencies. SQL stays exclusively in the driver.
type SourceAction = 'draft-change' | 'draft-noop' | 'autosave' | 'subscribe' | 'poll-diagnostics' | 'etag-set' | 'etag-clear' | 'rename-source' | 'import-old' | 'repair-import-html' | 'retype-import' | 'delete-import' | 'rollback' | 'update-checked' | 'setting-rename-away' | 'setting-rename-back' | 'security-counter' | 'withdraw';
const sourceActions: SourceAction[] = ['draft-change', 'draft-noop', 'autosave', 'subscribe', 'poll-diagnostics', 'etag-set', 'etag-clear', 'rename-source', 'import-old', 'repair-import-html', 'retype-import', 'delete-import', 'rollback', 'update-checked', 'setting-rename-away', 'setting-rename-back', 'security-counter', 'withdraw'];
function sourceDomains(action: SourceAction): string[] {
  switch (action) {
    case 'draft-change': case 'autosave': return ['items'];
    case 'subscribe': case 'rename-source': return ['subscriptions', 'reading', 'hoppers', 'feed'].sort();
    case 'poll-diagnostics': case 'etag-set': case 'etag-clear': return ['subscriptions'];
    case 'import-old': case 'retype-import': case 'delete-import': return ['reading', 'hoppers', 'feed'].sort();
    case 'repair-import-html': return ['reading', 'hoppers'].sort();
    case 'update-checked': return ['settings'];
    case 'setting-rename-away': case 'setting-rename-back': return ['settings', 'feed'].sort();
    case 'withdraw': return ['items', 'reading', 'feed'].sort();
    default: return [];
  }
}
const sourceSql: Record<SourceAction, string> = {
  'draft-change': "UPDATE items SET content_md='draft changed' WHERE id='cache-item'", 'draft-noop': "UPDATE items SET content_md=content_md WHERE id='cache-item'", autosave: "UPDATE items SET content_md='typing',updated='later' WHERE id='draft-autosave'",
  subscribe: "INSERT INTO subscriptions(id,kind,origin,feed_url,created) VALUES('s','blyg','https://source/','https://source/feed.xml','old')", 'poll-diagnostics': "UPDATE subscriptions SET last_poll_at='later',fail_count=1 WHERE id='s'", 'etag-set': "UPDATE subscriptions SET etag='x' WHERE id='s'", 'etag-clear': "UPDATE subscriptions SET etag=NULL WHERE id='s'", 'rename-source': "UPDATE subscriptions SET title='renamed' WHERE id='s'",
  'import-old': "INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,updated,observed_at) VALUES('s','old','fragment','current',1,'1990-01-01','now')", 'repair-import-html': "UPDATE imported_items SET content_html='repaired' WHERE remote_id='old'", 'retype-import': "UPDATE imported_items SET kind='thread',page='/t/old' WHERE remote_id='old'", 'delete-import': "DELETE FROM imported_items WHERE remote_id='old'", rollback: '',
  'update-checked': "INSERT INTO settings(key,value) VALUES('update_checked_at','t')", 'setting-rename-away': "UPDATE settings SET key='other' WHERE key='site_title'", 'setting-rename-back': "UPDATE settings SET key='site_title' WHERE key='other'", 'security-counter': "INSERT INTO security_budgets(key,window,used) VALUES('probe',1,1)", withdraw: "UPDATE items SET status='withdrawn',kind='withdrawn',version=2 WHERE id='cache-item'",
};
oracleProperty({
  id: 'polling-cache-source-history', owns: ['src/changes.ts'],
  law: { statement: 'For every direct source history, changed public dependencies advance their domains despite old timestamps; no-op, diagnostic-only, untracked and rolled-back work preserve all unrelated counters and rollback preserves source content.', authority: 'docs/d1-polling-cache-design.md P2/P3/R1 and original direct-write receiving history', limits: 'Original draft/import/diagnostic/key-rename/withdrawal/rollback history; no complete future dependency matrix claim.' },
  histories: [sourceActions], model: history => history.map(action => ({ action, domains: sourceDomains(action), sameEpoch: true })),
  driver: async (history, observe) => stored(observe, async () => {
    const cookie = await login(); await seed();
    for (const action of history) {
      if (action === 'autosave') await env.DB.prepare("INSERT INTO items(id,created,updated) VALUES('draft-autosave','t','t')").run();
      const before = await changes(cookie, observe);
      if (action === 'rollback') {
        const error = await thrown(() => env.DB.batch([env.DB.prepare("UPDATE subscriptions SET title='rollback' WHERE id='s'"), env.DB.prepare('INSERT INTO missing_table VALUES(1)')]));
        observe('source rollback', { error, title: (await env.DB.prepare("SELECT title FROM subscriptions WHERE id='s'").first<{ title: string }>())?.title });
      } else await env.DB.prepare(sourceSql[action]).run();
      observe('source history effect', { action, ...domainDelta(before, await changes(cookie, observe)) });
    }
  }),
  check: (_history, trace, expected) => {
    const law = 'direct source history'; const invalid = common(trace, law); if (invalid) return invalid;
    const rows = trace.filter(entry => entry.checkpoint === 'source history effect');
    for (let index = 0; index < rows.length; index++) {
      const entry = rows[index], row = entry.value as { action: SourceAction } & ReturnType<typeof domainDelta>, wanted = expected[index];
      const bad = differs(entry.checkpoint, law, { action: row.action, domains: row.domains, sameEpoch: row.sameEpoch }, wanted) ?? differs(entry.checkpoint, law, row.advances, wanted?.domains); if (bad) return bad;
    }
    for (const value of values(trace, 'source rollback') as { error: unknown; title: unknown }[]) { const bad = differs('source rollback', law, { rejected: Boolean(value.error), title: value.title }, { rejected: true, title: 'renamed' }); if (bad) return bad; }
    return complete(trace) ? differs('history complete', law, rows.length, expected.length) ?? differs('history complete', law, values(trace, 'source rollback').length, expected.filter(row => row.action === 'rollback').length) ?? pass : pass;
  },
  calibrations: [{ name: 'old timestamp import not tracked', law: 'direct source history', history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'source history effect' && (entry.value as { action: SourceAction }).action === 'import-old' ? { ...entry, value: { ...(entry.value as object), domains: [] } } : entry) }],
});

type CounterPlan = { rows: number; missingItem: string; content: string };
oracleProperty({
  id: 'polling-cache-counted-work', owns: ['src/changes.ts'],
  law: { statement: 'For every original bulk-import witness, each relevant row increments Reading once and adds one tracking write relative to the same untracked provider batch; trigger bookkeeping preserves zero/nonzero source change results.', authority: 'docs/d1-polling-cache-design.md M6/R1 and original 100-import receiving comparison', limits: 'Matched local D1 batches cancel provider overhead; this is not billed D1 rows or deployed latency.' },
  histories: [{ rows: 100, missingItem: 'absent-review-item', content: 'review-body' } satisfies CounterPlan],
  model: plan => ({ rows: plan.rows, absentChanged: false, existingChanged: true }),
  driver: async (plan, observe) => stored(observe, async () => {
    await seed();
    const absent = await env.DB.prepare('DELETE FROM items WHERE id=?').bind(plan.missingItem).run();
    const changed = await env.DB.prepare("UPDATE items SET content_md=? WHERE id='cache-item'").bind(plan.content).run();
    observe('source changes result', { absent: Boolean(absent.meta.changes), existing: Boolean(changed.meta.changes) });
    // L0 rows stay outside FTS, isolating polling-cache tracking from segment writes.
    const cookie = await login(), before = await changes(cookie, observe);
    const start = await env.DB.prepare('SELECT total_changes() AS value').first<{ value: number }>();
    await env.DB.batch(Array.from({ length: plan.rows }, (_, index) => env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,l0) VALUES('bulk',?,'fragment','current',1,'now',1)").bind(`r${index}`)));
    const end = await env.DB.prepare('SELECT total_changes() AS value').first<{ value: number }>(), after = await changes(cookie, observe);
    await env.DB.prepare('DROP TRIGGER change_imported_items_insert').run();
    const controlStart = await env.DB.prepare('SELECT total_changes() AS value').first<{ value: number }>();
    await env.DB.batch(Array.from({ length: plan.rows }, (_, index) => env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,l0) VALUES('control',?,'fragment','current',1,'now',1)").bind(`r${index}`)));
    const controlEnd = await env.DB.prepare('SELECT total_changes() AS value').first<{ value: number }>();
    observe('trigger source and tracking writes', { reading: after.domains.reading - before.domains.reading, writes: (end!.value - start!.value) - (controlEnd!.value - controlStart!.value), controlDelta: domainDelta(after, await changes(cookie, observe)) });
  }),
  check: (_plan, trace, expected) => {
    const law = 'counted trigger work'; const invalid = common(trace, law); if (invalid) return invalid;
    for (const value of values(trace, 'source changes result')) { const bad = differs('source changes result', law, value, { absent: expected.absentChanged, existing: expected.existingChanged }); if (bad) return bad; }
    const rows = values(trace, 'trigger source and tracking writes') as { reading: number; writes: number; controlDelta: ReturnType<typeof domainDelta> }[];
    for (const row of rows) { const bad = differs('trigger source and tracking writes', law, row, { reading: expected.rows, writes: expected.rows, controlDelta: { domains: [], advances: [], sameEpoch: true } }); if (bad) return bad; }
    return complete(trace) ? differs('history complete', law, rows.length, 1) ?? differs('history complete', law, values(trace, 'source changes result').length, 1) ?? pass : pass;
  },
  calibrations: [{ name: 'bulk import skips one tracked row', law: 'counted trigger work', history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'trigger source and tracking writes' ? { ...entry, value: { ...(entry.value as object), reading: 99 } } : entry) }],
});

type ReadAction = { event: 'mark'; version: number; readAt?: string } | { event: 'clear' };
const readActions: ReadAction[] = [{ event: 'mark', version: 2 }, { event: 'mark', version: 1 }, { event: 'clear' }, { event: 'mark', version: 2, readAt: '2000-01-01T00:00:00Z' }];
oracleProperty({
  id: 'polling-cache-reading-effects', owns: ['src/changes.ts'],
  law: { statement: 'For every read-mark history, a newer applied read or clear changes the Reading response and its domain; older replay and pre-clear reads change neither.', authority: 'docs/d1-polling-cache-design.md P2/R1 and migration0026 read-state tombstone contract', limits: 'Original received two-version mark/replay/clear/old-timestamp sequence, not concurrent writers.' },
  histories: [readActions],
  model: history => {
    let version = 0, cleared = false;
    return history.map(action => {
      const changed = action.event === 'clear' ? version > 0 : !(cleared && action.readAt) && action.version > version;
      if (changed) { version = action.event === 'clear' ? 0 : action.version; cleared = action.event === 'clear'; }
      return { changed, domains: changed ? ['reading'] : [] };
    });
  },
  driver: async (history, observe) => stored(observe, async () => {
    const cookie = await login();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES('read-source','blyg','https://source/','https://source/feed.xml','Source','2026-01-01')"),
      env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_html) VALUES('read-source','r','fragment','current',2,'2026-01-01T00:00:00Z','<p>Body</p>')"),
    ]);
    async function call(method: string, path: string, body?: unknown) {
      const ctx = createExecutionContext(), response = await app.fetch(new Request(BASE + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json', origin: BASE } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
      observe('receiving response status', response.status); const data = await response.text(); await waitOnExecutionContext(ctx); return data;
    }
    let before = await call('GET', '/blyg/api/reading'), counters = await changes(cookie, observe);
    for (const action of history) {
      await call(action.event === 'clear' ? 'DELETE' : 'PUT', '/blyg/api/reading/read-source/r/read', action.event === 'mark' ? { version: action.version, ...(action.readAt ? { readAt: action.readAt } : {}) } : undefined);
      const after = await call('GET', '/blyg/api/reading'), changed = await changes(cookie, observe);
      observe('Reading receiving effect', { changed: after !== before, delta: domainDelta(counters, changed) });
      before = after; counters = changed;
    }
  }),
  check: (_history, trace, expected) => {
    const law = 'Reading receiving effect'; const invalid = common(trace, law); if (invalid) return invalid;
    const rows = values(trace, law) as { changed: boolean; delta: ReturnType<typeof domainDelta> }[];
    for (let index = 0; index < rows.length; index++) {
      const wanted = expected[index];
      const bad = differs(law, law, rows[index], wanted ? { changed: wanted.changed, delta: { domains: wanted.domains, advances: wanted.domains, sameEpoch: true } } : undefined); if (bad) return bad;
    }
    return complete(trace) ? differs('history complete', law, rows.length, expected.length) ?? pass : pass;
  },
  calibrations: [{ name: 'replayed older mark changes Reading', law: 'Reading receiving effect', history: { enumerated: 0 }, corrupt: trace => { let index = 0; return trace.map(entry => entry.checkpoint === 'Reading receiving effect' && ++index === 2 ? { ...entry, value: { ...(entry.value as object), changed: true } } : entry); } }],
});
oracleProperty({
  id: 'polling-cache-imported-dependencies', owns: ['src/changes.ts'],
  law: { statement: 'For every imported HTML repair visible in Reading and hopper memberships, both fresh DTOs change and both invalidation domains advance.', authority: 'docs/d1-polling-cache-design.md P2/R1 dependency relation and original fresh DTO second formulation', limits: 'Original imported HTML fixture and two real HTTP receivers, not independent rendering semantics.' },
  histories: [{ source: 'dependency-source', hopper: 'dependency-hopper', remote: 'r', initial: '<p>Before</p>', replacement: '<p>After</p>' }],
  model: plan => ({ changed: plan.initial !== plan.replacement, domains: ['reading', 'hoppers'] }),
  driver: async (plan, observe) => stored(observe, async () => {
    const cookie = await login();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES(?,'blyg','https://source/','https://source/feed.xml','Before','2026-01-01')").bind(plan.source),
      env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_html) VALUES(?,?,'fragment','current',1,'2026-01-01T00:00:00Z',?)").bind(plan.source, plan.remote, plan.initial),
      env.DB.prepare("INSERT INTO hoppers(id,name,created) VALUES(?,'Hopper','2026-01-01')").bind(plan.hopper),
      env.DB.prepare("INSERT INTO hopper_items(hopper_id,subscription_id,remote_id,added_at) VALUES(?,?,?,'2026-01-01')").bind(plan.hopper, plan.source, plan.remote),
    ]);
    async function read(path: string) { const ctx = createExecutionContext(), response = await app.fetch(new Request(BASE + path, { headers: { cookie } }), env, ctx); observe('receiving response status', response.status); const data = await response.text(); await waitOnExecutionContext(ctx); return data; }
    const paths = ['/blyg/api/reading', `/blyg/api/hoppers/${plan.hopper}/memberships`], before = await Promise.all(paths.map(read)), counters = await changes(cookie, observe);
    await env.DB.prepare('UPDATE imported_items SET content_html=? WHERE subscription_id=?').bind(plan.replacement, plan.source).run();
    const after = await Promise.all(paths.map(read)), changed = await changes(cookie, observe);
    observe('fresh DTO dependencies', { changed: after.map((value, index) => value !== before[index]), advances: ['reading', 'hoppers'].filter(domain => changed.domains[domain as OracleDomain] > counters.domains[domain as OracleDomain]) });
  }),
  check: (_plan, trace, expected) => {
    const law = 'fresh DTO dependencies', invalid = common(trace, law); if (invalid) return invalid;
    const rows = values(trace, law);
    for (const row of rows) { const bad = differs(law, law, row, { changed: [expected.changed, expected.changed], advances: expected.domains }); if (bad) return bad; }
    return complete(trace) ? differs('history complete', law, rows.length, 1) ?? pass : pass;
  },
  calibrations: [{ name: 'hopper counter misses imported HTML', law: 'fresh DTO dependencies', history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'fresh DTO dependencies' ? { ...entry, value: { ...(entry.value as object), advances: ['reading'] } } : entry) }],
});

type MentionAction = { event: 'claim' | 'fail' | 'verify' | 'hide' | 'reclaim' | 'withdraw' | 'show' | 'prune' | 'failed-insert' | 'failed-prune'; attempt?: number };
const mentionActions: MentionAction[] = [{ event: 'claim' }, { event: 'fail' }, { event: 'reclaim', attempt: 1 }, { event: 'verify' }, { event: 'hide' }, { event: 'reclaim', attempt: 2 }, { event: 'verify' }, { event: 'withdraw' }, { event: 'reclaim', attempt: 3 }, { event: 'show' }, { event: 'verify' }, { event: 'prune' }, { event: 'failed-insert' }, { event: 'failed-prune' }];
function mentionModel(history: MentionAction[]) {
  let state = '', hidden = false;
  const listed = () => state === 'verified' || state === 'gone', publicRow = () => state === 'verified' && !hidden;
  return history.map(action => {
    const beforeListed = listed(), beforePublic = publicRow();
    switch (action.event) {
      case 'claim': case 'reclaim': state = 'pending'; break;
      case 'fail': state = 'failed'; break;
      case 'verify': state = 'verified'; break;
      case 'hide': hidden = true; break;
      case 'show': hidden = false; break;
      case 'withdraw': state = 'gone'; break;
      case 'prune': state = ''; break;
    }
    const domains: string[] = [];
    if (beforeListed || listed()) domains.push('mentions');
    if (beforePublic || publicRow()) domains.push('responses');
    return domains;
  });
}
oracleProperty({
  id: 'polling-cache-mention-effects', owns: ['src/changes.ts'],
  law: { statement: 'For every inbound claim lifecycle, exactly the domains whose Studio list or public response section changes advance; pending and failed invisible claims do not create visible effects.', authority: 'docs/d1-polling-cache-design.md P2/R1 and original status-dependent mentions/responses receiving history', limits: 'Original verification, hiding, withdrawal, retry and prune schedule with real Studio and public-page receivers.' },
  histories: [mentionActions], model: mentionModel,
  driver: async (history, observe) => stored(observe, async () => {
    const cookie = await login(); await seed(); await env.DB.prepare("UPDATE items SET responses_override=1 WHERE id='cache-item'").run();
    async function read(path: string, headers: HeadersInit = { cookie }) { const ctx = createExecutionContext(), response = await app.fetch(new Request(BASE + path, { headers }), env, ctx); observe('receiving response status', response.status); const body = await response.text(); await waitOnExecutionContext(ctx); return body; }
    const studio = () => read('/blyg/api/mentions?direction=inbound'), page = async () => (await read('/blyg/f/cache-item/', {})).match(/<section[^>]*responses[\s\S]*?<\/section>/)?.[0] ?? '';
    const verify = "status='verified',relation='stub',source_origin='https://responder.example/',source_id='r',source_kind='thread',source_version=1,source_page='t/r/',source_author_json='{\"name\":\"Witness\"}',verified_at='2026-10-18T00:00:00Z'";
    for (const action of history) {
      const before = { studio: await studio(), page: await page(), changes: await changes(cookie, observe) };
      switch (action.event) {
        case 'claim': await env.DB.prepare("INSERT INTO mentions_in(id,source,target,target_item_id,status,first_seen,last_seen) VALUES('w','https://responder.example/t/r/','https://us/f/cache-item/','cache-item','pending','t','t')").run(); break;
        case 'fail': await env.DB.prepare("UPDATE mentions_in SET status='failed',error='no link' WHERE id='w'").run(); break;
        case 'reclaim': await env.DB.prepare(`UPDATE mentions_in SET status='pending',${action.attempt === 1 ? 'error=NULL,' : ''}attempts=?,last_seen=? WHERE id='w'`).bind(action.attempt, `t${(action.attempt ?? 0) + 1}`).run(); break;
        case 'verify': await env.DB.prepare(`UPDATE mentions_in SET ${verify} WHERE id='w'`).run(); break;
        case 'hide': case 'show': await env.DB.prepare("UPDATE mentions_in SET hidden=? WHERE id='w'").bind(action.event === 'hide' ? 1 : 0).run(); break;
        case 'withdraw': await env.DB.prepare("UPDATE mentions_in SET status='gone',error='withdrawn' WHERE id='w'").run(); break;
        case 'prune': await env.DB.prepare("DELETE FROM mentions_in WHERE id='w'").run(); break;
        case 'failed-insert': await env.DB.prepare("INSERT INTO mentions_in(id,source,target,target_item_id,status,first_seen,last_seen) VALUES('f','https://spam.example/','https://us/f/cache-item/','cache-item','failed','t','t')").run(); break;
        case 'failed-prune': await env.DB.prepare("DELETE FROM mentions_in WHERE id='f'").run(); break;
      }
      const after = { studio: await studio(), page: await page(), changes: await changes(cookie, observe) };
      observe('mention response dependencies', { publicDomains: [...(before.studio !== after.studio ? ['mentions'] : []), ...(before.page !== after.page ? ['responses'] : [])], delta: domainDelta(before.changes, after.changes).domains });
    }
    observe('remaining public responses', await page());
  }),
  check: (_history, trace, expected) => {
    const law = 'mention response dependencies'; const invalid = common(trace, law); if (invalid) return invalid;
    const rows = trace.filter(entry => entry.checkpoint === law);
    for (let index = 0; index < rows.length; index++) { const entry = rows[index], bad = differs(entry.checkpoint, law, entry.value, { publicDomains: expected[index], delta: expected[index] }); if (bad) return bad; }
    const bad = values(trace, 'remaining public responses').map(value => differs('remaining public responses', law, value, '')).find(Boolean); if (bad) return bad;
    return complete(trace) ? differs('history complete', law, rows.length, expected.length) ?? differs('history complete', law, values(trace, 'remaining public responses').length, 1) ?? pass : pass;
  },
  calibrations: [{ name: 'public verification omits responses counter', law: 'mention response dependencies', history: { enumerated: 0 }, corrupt: trace => { let index = 0; return trace.map(entry => entry.checkpoint === 'mention response dependencies' && ++index === 4 ? { ...entry, value: { ...(entry.value as object), delta: ['mentions'] } } : entry); } }],
});

const day = 24 * 60 * 60 * 1000;
oracleProperty({
  id: 'polling-cache-timed-read', owns: ['src/changes.ts'],
  law: { statement: 'For every update-state read around its daily deadline, time alone leaves the change token unchanged until the due read records the current check timestamp and advances Settings.', authority: 'docs/d1-polling-cache-design.md P8/R2 and original exact daily-deadline receiving witness', limits: 'Original one-millisecond-before and exact-deadline reads with controlled Date, not a timer wakeup guarantee.' },
  histories: [{ start: Date.parse('2026-10-01T12:00:00Z'), offsets: [day - 1, day] }],
  model: plan => plan.offsets.map(offset => ({ due: offset >= day, checkedAt: new Date(plan.start + (offset >= day ? offset : 0)).toISOString() })),
  driver: async (plan, observe) => stored(observe, async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(plan.start);
    try {
      const cookie = await login();
      await env.DB.batch([env.DB.prepare("INSERT INTO settings(key,value) VALUES('update_check','on')"), env.DB.prepare("INSERT INTO settings(key,value) VALUES('update_checked_at',?)").bind(new Date(plan.start).toISOString())]);
      const baseline = await changes(cookie, observe);
      for (const offset of plan.offsets) {
        vi.setSystemTime(plan.start + offset);
        const before = await changes(cookie, observe), ctx = createExecutionContext();
        const response = await app.fetch(new Request(`${BASE}/blyg/api/update-state`, { headers: { cookie } }), env, ctx);
        observe('receiving response status', response.status); await response.text(); await waitOnExecutionContext(ctx);
        const after = await changes(cookie, observe), checkedAt = (await env.DB.prepare("SELECT value FROM settings WHERE key='update_checked_at'").first<{ value: string }>())?.value;
        observe('timed update-state effect', { beforeSame: JSON.stringify(before) === JSON.stringify(baseline), afterSame: JSON.stringify(after) === JSON.stringify(baseline), settingsAdvanced: after.domains.settings > baseline.domains.settings, checkedAt });
      }
    } finally { vi.useRealTimers(); }
  }),
  check: (_plan, trace, expected) => {
    const law = 'timed update-state effect'; const invalid = common(trace, law); if (invalid) return invalid;
    const rows = values(trace, law);
    for (let index = 0; index < rows.length; index++) { const wanted = expected[index]; const bad = differs(law, law, rows[index], wanted ? { beforeSame: true, afterSame: !wanted.due, settingsAdvanced: wanted.due, checkedAt: wanted.checkedAt } : undefined); if (bad) return bad; }
    return complete(trace) ? differs('history complete', law, rows.length, expected.length) ?? pass : pass;
  },
  calibrations: [{ name: 'deadline read does not advance settings', law: 'timed update-state effect', history: { enumerated: 0 }, corrupt: trace => { let index = 0; return trace.map(entry => entry.checkpoint === 'timed update-state effect' && ++index === 2 ? { ...entry, value: { ...(entry.value as object), settingsAdvanced: false } } : entry); } }],
});
oracleProperty({
  id: 'polling-cache-state-readers', owns: ['src/changes.ts'],
  law: { statement: 'For every change-state reader, a native SQLite blob epoch is rejected as unavailable; the removed private /changes endpoint has no authenticated compatibility alias.', authority: 'docs/d1-polling-cache-design.md R1/P8 and original native-blob receiving witnesses; Kyle Mathews, 2026-11-18: delete /changes with no compatibility alias', limits: 'Native D1 blob epoch and real authenticated removed-endpoint request only.' },
  histories: [{ receiver: 'private' }, { receiver: 'feed' }, { receiver: 'http' }],
  model: plan => plan.receiver === 'http' ? { status: 404 } : { message: plan.receiver === 'private' ? 'change state unavailable' : 'feed revision unavailable' },
  driver: async (plan, observe) => stored(observe, async () => {
    if (plan.receiver === 'http') {
      const cookie = await login(), ctx = createExecutionContext(), response = await app.fetch(new Request(`${BASE}/blyg/api/changes`, { headers: { cookie } }), env, ctx); observe('change reader result', { status: response.status }); await waitOnExecutionContext(ctx);
    } else {
      await env.DB.prepare('UPDATE change_state SET epoch=? WHERE id=1').bind(new Uint8Array([1, 2])).run();
      observe('change reader result', await thrown(() => plan.receiver === 'private' ? readChanges(env.DB) : readFeedRevision(env.DB)));
    }
  }),
  check: (_plan, trace, expected) => {
    const law = 'change reader result', rows = values(trace, law);
    for (const row of rows) {
      const actual = row as { message?: string; status?: number; cache?: string } | undefined;
      const bad = 'message' in expected ? differs(law, law, actual?.message?.includes(expected.message!), true) : differs(law, law, actual, expected); if (bad) return bad;
    }
    return complete(trace) ? differs('history complete', law, rows.length, 1) ?? pass : pass;
  },
  calibrations: [{ name: 'blob epoch accepted', law: 'change reader result', history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'change reader result' ? { ...entry, value: undefined } : entry) }],
});

// The publication model keeps source, saved artifact and pending attempt
// separate. Repetition distinguishes source identity from visible bytes;
// held PUTs distinguish an attempt's target from the current source. A held
// settings read instead forces validation to retry against the new source.
type Generation = { epoch: number; revision: number };
type Boundary = 'put' | 'settings' | 'churn';
type FeedAction =
  | { op: 'write'; value: string }
  | { op: 'fetch'; label: string; method?: 'HEAD'; conditional?: string; fault?: 'read' | 'put'; track?: string; builder?: 'independent' }
  | { op: 'begin'; label: string; boundary: Boundary; track?: string }
  | { op: 'finish' }
  | { op: 'artifact'; label: string }
  | { op: 'restore'; epoch?: string; absent?: boolean }
  | { op: 'corrupt-artifact' }
  | { op: 'site'; enabled: boolean }
  | { op: 'tick'; label: string; fault?: 'put'; track?: string }
  | { op: 'join-tick'; track: string }
  | { op: 'work'; track: string };
type FeedPlan = { name: string; actions: FeedAction[] };
const feedPlans: FeedPlan[] = [
  { name: 'same-valued generations cannot hide a stored revision regression', actions: [{ op: 'fetch', label: 'cold' }, { op: 'write', value: 'B' }, { op: 'begin', label: 'old', boundary: 'put' }, { op: 'write', value: 'A' }, { op: 'write', value: 'B' }, { op: 'fetch', label: 'winner' }, { op: 'finish' }, { op: 'artifact', label: 'winner' }] },
  { name: 'epoch changes with reused counters replace cached source identity', actions: [{ op: 'fetch', label: 'cold' }, { op: 'write', value: 'B' }, { op: 'restore', epoch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { op: 'fetch', label: 'refresh' }, { op: 'artifact', label: 'restored' }] },
  { name: 'an old-epoch builder loses after the restored generation is installed', actions: [{ op: 'fetch', label: 'cold' }, { op: 'write', value: 'B' }, { op: 'begin', label: 'old', boundary: 'put' }, { op: 'write', value: 'C' }, { op: 'restore' }, { op: 'fetch', label: 'restored' }, { op: 'finish' }, { op: 'artifact', label: 'restored' }] },
  { name: 'source-read failure preserves the saved artifact and remains retryable', actions: [{ op: 'fetch', label: 'cold' }, { op: 'artifact', label: 'initial' }, { op: 'write', value: 'B' }, { op: 'fetch', label: 'failure', fault: 'read' }, { op: 'artifact', label: 'after failure' }, { op: 'fetch', label: 'retry' }, { op: 'artifact', label: 'after retry' }] },
  { name: 'serves saved legal XML and 304/HEAD while unchanged checks perform no render', actions: [{ op: 'fetch', label: 'cold' }, { op: 'fetch', label: 'unchanged', conditional: 'cold', track: 'warm' }, { op: 'work', track: 'warm' }, { op: 'fetch', label: 'head', method: 'HEAD', track: 'warm' }, { op: 'work', track: 'warm' }] },
  { name: 'revalidates even when the stale representation produces a 304', actions: [{ op: 'fetch', label: 'cold' }, { op: 'write', value: 'B' }, { op: 'fetch', label: 'stale', conditional: 'cold' }, { op: 'fetch', label: 'fresh' }] },
  { name: 'old builders cannot overwrite a newer generation with repeated visible bytes', actions: [{ op: 'fetch', label: 'cold' }, { op: 'write', value: 'B' }, { op: 'begin', label: 'old', boundary: 'put', track: 'old' }, { op: 'write', value: 'A' }, { op: 'fetch', label: 'newer' }, { op: 'finish' }, { op: 'fetch', label: 'winner' }, { op: 'work', track: 'old' }, { op: 'artifact', label: 'winner' }] },
  { name: 'discards a render interrupted between settings and content reads', actions: [{ op: 'fetch', label: 'cold' }, { op: 'write', value: 'B' }, { op: 'begin', label: 'interrupted', boundary: 'settings' }, { op: 'write', value: 'C' }, { op: 'finish' }, { op: 'fetch', label: 'fresh' }, { op: 'artifact', label: 'fresh' }] },
  { name: 'failed background publication keeps last good XML and a later request retries', actions: [{ op: 'fetch', label: 'cold' }, { op: 'artifact', label: 'initial' }, { op: 'write', value: 'B' }, { op: 'fetch', label: 'failed', fault: 'put' }, { op: 'artifact', label: 'after failure' }, { op: 'fetch', label: 'retry' }, { op: 'fetch', label: 'fresh' }] },
  { name: 'cold competing creators return the conditional winner, not an old overwrite', actions: [{ op: 'begin', label: 'old', boundary: 'put' }, { op: 'write', value: 'B' }, { op: 'fetch', label: 'winner' }, { op: 'finish' }] },
  { name: 'cold validation exhaustion reuses a valid concurrent saved artifact', actions: [{ op: 'begin', label: 'churning', boundary: 'churn' }, { op: 'fetch', label: 'winner', builder: 'independent' }, { op: 'finish' }, { op: 'artifact', label: 'concurrent winner' }] },
  { name: 'cold validation exhaustion rejects a winner whose generation metadata is invalid', actions: [{ op: 'begin', label: 'churning', boundary: 'churn' }, { op: 'fetch', label: 'winner', builder: 'independent' }, { op: 'corrupt-artifact' }, { op: 'finish' }] },
  { name: 'cron builds cold XML and changed XML before any feed reader arrives', actions: [{ op: 'site', enabled: true }, { op: 'tick', label: 'cold tick' }, { op: 'artifact', label: 'cold tick' }, { op: 'write', value: 'B' }, { op: 'tick', label: 'changed tick' }, { op: 'artifact', label: 'scheduled feed changed XML' }, { op: 'fetch', label: 'first reader' }] },
  { name: 'an unchanged minute tick makes only two small D1 reads and no render or put', actions: [{ op: 'site', enabled: true }, { op: 'tick', label: 'cold tick' }, { op: 'tick', label: 'unchanged tick', track: 'warm tick' }, { op: 'work', track: 'warm tick' }] },
  { name: 'a site without a canonical URL keeps request-driven rebuilding', actions: [{ op: 'site', enabled: false }, { op: 'tick', label: 'unconfigured', track: 'unconfigured' }, { op: 'work', track: 'unconfigured' }, { op: 'fetch', label: 'reader' }] },
  { name: 'cron joins pending SWR work and receives later writes on the next tick', actions: [{ op: 'site', enabled: true }, { op: 'tick', label: 'cold tick' }, { op: 'write', value: 'B' }, { op: 'begin', label: 'old', boundary: 'put', track: 'joined' }, { op: 'write', value: 'C' }, { op: 'join-tick', track: 'joined' }, { op: 'finish' }, { op: 'artifact', label: 'joined old render' }, { op: 'tick', label: 'next tick', track: 'joined' }, { op: 'artifact', label: 'scheduled feed next-tick retry' }, { op: 'work', track: 'joined' }] },
  { name: 'cron failure preserves legal saved XML and a later tick retries', actions: [{ op: 'site', enabled: true }, { op: 'tick', label: 'cold tick' }, { op: 'write', value: 'B' }, { op: 'tick', label: 'failed tick', fault: 'put' }, { op: 'artifact', label: 'after failure' }, { op: 'tick', label: 'retry tick' }, { op: 'artifact', label: 'after retry' }] },
];
type FeedVersion = { value: string; generation: Generation; serial: number };
type FeedExpected = { checkpoint: string; label: string; status?: number; facts?: FeedFacts; generation?: Generation; serial?: number; empty?: boolean; sql?: string[]; puts?: number; objects?: number };
function feedModel(plan: FeedPlan, trace: readonly Observation[]): FeedExpected[] {
  const inputs = new Map((values(trace, 'input feed source') as { step: number; generation: Generation }[]).map(value => [value.step, value.generation]));
  let source: FeedVersion = { value: 'A', generation: inputs.get(-1) ?? { epoch: -1, revision: -1 }, serial: 0 }, artifact: FeedVersion | undefined, pending: { target: FeedVersion; response?: FeedVersion; label: string; boundary: Boundary } | undefined;
  let serial = 0, configured = false, invalidArtifact = false;
  const reference = new FeedReference();
  const commit = () => reference.commit(expectedFacts(source.value), { epoch: String(source.generation.epoch), revision: source.generation.revision });
  const predicted = (version: FeedVersion) => reference.at({ epoch: String(version.generation.epoch), revision: version.generation.revision })!;
  commit();
  const expected: FeedExpected[] = [], trackPuts = new Map<string, number>(), trackSql = new Map<string, string[]>();
  const publish = (target: FeedVersion, track?: string) => {
    if (!artifact || target.generation.epoch === source.generation.epoch && (artifact.generation.epoch !== target.generation.epoch || target.generation.revision >= artifact.generation.revision)) {
      if (!artifact || artifact.generation.epoch !== target.generation.epoch || artifact.generation.revision !== target.generation.revision) { artifact = { ...target, serial: ++serial }; if (track) trackPuts.set(track, (trackPuts.get(track) ?? 0) + 1); }
    }
  };
  for (let step = 0; step < plan.actions.length; step++) {
    const action = plan.actions[step];
    switch (action.op) {
      case 'write': source = { value: action.value, generation: inputs.get(step) ?? source.generation, serial: 0 }; commit(); break;
      case 'restore': source = { ...source, generation: inputs.get(step) ?? source.generation }; commit(); break;
      case 'site': configured = action.enabled; source = { ...source, generation: inputs.get(step) ?? source.generation }; commit(); break;
      case 'corrupt-artifact': invalidArtifact = true; break;
      case 'begin': {
        if (action.boundary === 'churn') { source = { value: '1', generation: inputs.get(step) ?? source.generation, serial: 0 }; commit(); }
        pending = { target: { ...source }, response: artifact && { ...artifact }, label: action.label, boundary: action.boundary };
        if (artifact) expected.push({ checkpoint: 'feed response', label: action.label, status: 200, facts: predicted(artifact), generation: artifact.generation, serial: artifact.serial });
        if (action.track) trackPuts.set(action.track, (trackPuts.get(action.track) ?? 0) + 1);
        break;
      }
      case 'finish': {
        if (!pending) break;
        if (pending.boundary !== 'churn') publish(pending.boundary === 'settings' ? source : pending.target);
        if (!pending.response) expected.push({ checkpoint: 'feed response', label: pending.label, status: invalidArtifact ? 500 : 200, ...(!invalidArtifact && artifact ? { facts: predicted(artifact), generation: artifact.generation, serial: artifact.serial } : {}) });
        pending = undefined; break;
      }
      case 'fetch': {
        const before = artifact;
        if (!before) publish(source, action.track);
        const served = before ?? artifact!;
        expected.push({ checkpoint: 'feed response', label: action.label, status: action.conditional ? 304 : 200, ...(action.method || action.conditional ? { empty: true } : { facts: predicted(served), generation: served.generation, serial: served.serial }) });
        if (!action.fault) publish(source, before ? action.track : undefined);
        if (action.track) trackSql.set(action.track, [...(trackSql.get(action.track) ?? []), 'SELECT epoch, feed FROM change_state WHERE id = 1']);
        break;
      }
      case 'tick': {
        if (action.track) trackSql.set(action.track, [...(trackSql.get(action.track) ?? []), "SELECT value FROM settings WHERE key = 'site_url'", ...(configured ? ['SELECT epoch, feed FROM change_state WHERE id = 1'] : [])]);
        if (configured && !action.fault) publish(source, action.track);
        break;
      }
      case 'join-tick': break;
      case 'artifact': expected.push({ checkpoint: 'feed artifact', label: action.label, ...(artifact ? { facts: predicted(artifact), generation: artifact.generation, serial: artifact.serial } : {}), objects: artifact ? 1 : 0 }); break;
      case 'work': expected.push({ checkpoint: 'feed counted work', label: action.track, puts: trackPuts.get(action.track) ?? 0, ...(action.track === 'warm' || action.track === 'warm tick' || action.track === 'unconfigured' ? { sql: trackSql.get(action.track) ?? [] } : {}), ...(action.track === 'unconfigured' ? { objects: 0 } : {}) }); break;
    }
  }
  return expected;
}
const expectedFacts = (value: string): FeedFacts => ({ title: value, bio: `bio-${value}`, body: `<p>body-${value}</p>` });

async function feedDriver(plan: FeedPlan, observe: Observe) {
  await stored(observe, async () => {
    const ids = identities(); await seed();
    const sourceInput = async (step: number) => { const value = await generation(); observe('input feed source', { step, generation: { epoch: ids.epoch(value.epoch), revision: value.revision } }); };
    await sourceInput(-1);
    const tags = new Map<string, string>(), tracks = new Map<string, { db: ReturnType<typeof observedDB>; bucket: ReturnType<typeof observedBucket> }>();
    const tracking = (label: string) => { let value = tracks.get(label); if (!value) { value = { db: observedDB(), bucket: observedBucket() }; tracks.set(label, value); } return value; };
    type FeedRequest = Awaited<ReturnType<typeof request>>;
    let pending: { promise: Promise<FeedRequest>; response?: FeedRequest; label: string; release: ReturnType<typeof deferred> } | undefined, joined: Promise<void> | undefined;
    async function response(value: FeedRequest, label: string) {
      const xml = await value.response.text(), tag = value.response.headers.get('etag');
      if (tag) tags.set(label, tag);
      const body: { facts?: FeedFacts; generation?: Generation; empty?: boolean; bytes?: string } = {};
      if (xml && value.response.status === 200) {
        body.facts = facts(xml, observe);
        body.bytes = xml.replace(/<!-- cache-generation:[a-f0-9]+ -->/, '<!-- generation separately observed -->');
        const comment = xml.match(/^<\?xml[^>]*\?>\n<!-- cache-generation:([a-f0-9]+) -->/);
        if (comment) {
          const bytes = Uint8Array.from(comment[1].match(/../g)!, pair => parseInt(pair, 16));
          const decoded = JSON.parse(new TextDecoder().decode(bytes)) as [string, string, number];
          body.generation = { epoch: ids.epoch(decoded[1]), revision: decoded[2] };
        }
      } else if (!xml) body.empty = true;
      observe('feed response', { label, status: value.response.status, ...body, tag: tag ? ids.tag(tag) : undefined, tagPresent: Boolean(tag) });
    }
    async function tick(bindings: Env = env) { const ctx = createExecutionContext(); await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now(), noRetry() {} }, bindings, ctx); await waitOnExecutionContext(ctx); }
    await withOracleCleanup(async () => {
      for (let step = 0; step < plan.actions.length; step++) {
        const action = plan.actions[step];
        switch (action.op) {
          case 'write': await setFacts(action.value); await sourceInput(step); break;
          case 'site': {
            if (action.enabled) await env.DB.prepare("INSERT INTO settings(key,value) VALUES('site_url',?)").bind(`${BASE}/blyg/`).run();
            else await env.DB.prepare("DELETE FROM settings WHERE key='site_url'").run();
            // Configuring the canonical URL is itself a tracked feed input.
            // Record its token before a scheduled renderer receives that input.
            await sourceInput(step); break;
          }
          case 'restore': {
            if (action.absent) await env.DB.prepare('DELETE FROM change_state WHERE id=1').run();
            if (action.epoch) await env.DB.prepare('UPDATE change_state SET epoch=?,feed=0 WHERE id=1').bind(action.epoch).run();
            else await env.DB.prepare(resetEpochSql).run();
            await sourceInput(step); break;
          }
          case 'corrupt-artifact': {
            const object = (await env.MEDIA.list({ prefix: '__cache/feed/' })).objects[0];
            if (!object) throw new Error('Concurrent winner missing before corruption control');
            await env.MEDIA.put(object.key, '<broken', { customMetadata: {} }); break;
          }
          case 'fetch': {
            let failed = false;
            const track = action.track ? tracking(action.track) : undefined;
            const db = action.fault === 'read' ? observedDB(async sql => { if (!failed && /FROM versions/.test(sql)) { failed = true; throw new Error('controlled content read failure'); } }) : track?.db;
            // A concurrent builder gets a distinct transparent bucket identity,
            // as in the original separate-isolate schedule. Sharing the held
            // builder's identity would join its pending work and deadlock.
            const bucket = action.fault === 'put' ? observedBucket(async () => { throw new Error('controlled R2 interruption'); }) : track?.bucket ?? (action.builder === 'independent' ? observedBucket() : undefined);
            const bindings = { ...env, ...(db ? { DB: db.db } : {}), ...(bucket ? { MEDIA: bucket.bucket } : {}) };
            const headers: HeadersInit = action.conditional ? { 'If-None-Match': `"other", W/${tags.get(action.conditional)}` } : {};
            const value = await request(bindings, headers, action.method); await response(value, action.label); await value.finish(); break;
          }
          case 'begin': {
            const entered = deferred(), release = deferred(); let held = false, writes = 0;
            const track = action.track ? tracking(action.track) : undefined;
            const bucket = action.boundary === 'put' ? observedBucket(async () => { if (!held) { held = true; entered.resolve(); await release.promise; } }) : undefined;
            if (track && bucket) track.bucket = bucket;
            const db = action.boundary === 'put' ? undefined : observedDB(async sql => {
              if (!/SELECT key, value FROM settings/.test(sql)) return;
              if (action.boundary === 'churn') { await setFacts(String(++writes)); if (writes === 1) await sourceInput(step); }
              if (!held) { held = true; entered.resolve(); await release.promise; }
            });
            const bindings = { ...env, ...(bucket ? { MEDIA: bucket.bucket } : {}), ...(db ? { DB: db.db } : {}) };
            const promise = request(bindings);
            pending = { promise, label: action.label, release };
            // Warm responses return before their background gate; cold requests
            // wait for the same gate before their HTTP response can complete.
            const objects = await env.MEDIA.list({ prefix: '__cache/feed/' });
            if (objects.objects.length) { pending.response = await promise; await response(pending.response, action.label); }
            await entered.promise; break;
          }
          case 'finish': {
            if (!pending) throw new Error('Feed plan finishes no pending attempt');
            const work = pending; work.release.resolve();
            if (work.response) await work.response.finish();
            else { const value = await work.promise; await value.finish(); await response(value, work.label); }
            await joined; joined = undefined; pending = undefined; break;
          }
          case 'artifact': {
            const value = await saved(observe, ids);
            if (value) observe('feed artifact', { label: action.label, facts: value.facts, generation: { epoch: value.epoch, revision: value.revision }, bytes: value.bytes, tag: value.etag });
            break;
          }
          case 'tick': {
            const track = action.track ? tracking(action.track) : undefined, bucket = action.fault ? observedBucket(async () => { throw new Error('controlled scheduled put failure'); }) : track?.bucket;
            await tick({ ...env, ...(track ? { DB: track.db.db } : {}), ...(bucket ? { MEDIA: bucket.bucket } : {}) }); break;
          }
          case 'join-tick': {
            const entered = deferred(), track = tracking(action.track); let accesses = 0;
            const bindings = new Proxy({ ...env, MEDIA: track.bucket.bucket }, { get(target, property) { if (property === 'MEDIA' && ++accesses === 2) entered.resolve(); return Reflect.get(target, property); } });
            joined = tick(bindings); await entered.promise; break;
          }
          case 'work': {
            const track = tracking(action.track), objects = await env.MEDIA.list({ prefix: '__cache/feed/' });
            observe('feed counted work', { label: action.track, puts: track.bucket.puts(), sql: track.db.statements, objects: objects.objects.length }); break;
          }
        }
      }
    }, [async () => {
      if (pending) { pending.release.resolve(); const value = pending.response ?? await pending.promise; await value.finish(); }
    }, async () => { await joined; }]);
  });
}
// A semantic comparison belongs to the event that supplied its value.
// Only the post-cleanup completion marker can establish a missing tail; a
// correct partial prefix must leave a later driver/cleanup error primary.
function feedCheck(_plan: FeedPlan, trace: readonly Observation[], expected: FeedExpected[]): Verdict {
  const law = 'feed publication', invalid = common(trace, law); if (invalid) return invalid;
  const rows = trace.filter(entry => ['feed response', 'feed artifact', 'feed counted work'].includes(entry.checkpoint));
  const serialArtifacts = new Map<number, { bytes: unknown; tag: unknown }>(), generationTags = new Map<string, unknown>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], wanted = expected[index], value = row.value as Record<string, unknown>;
    if (!wanted) return differs(row.checkpoint, law, value, undefined)!;
    const projected: Record<string, unknown> = { checkpoint: row.checkpoint, label: value.label };
    const required: Record<string, unknown> = { checkpoint: wanted.checkpoint, label: wanted.label };
    for (const key of ['status', 'facts', 'generation', 'empty', 'sql', 'puts', 'objects'] as const) if (key in wanted) {
      // Artifact cardinality is checked at its R2 list checkpoint by common().
      if (row.checkpoint === 'feed artifact' && key === 'objects') continue;
      projected[key] = value[key]; required[key] = wanted[key];
    }
    const bad = differs(row.checkpoint, law, projected, required); if (bad) return bad;
    if (wanted.facts && row.checkpoint === 'feed response') {
      const missingTag = differs(row.checkpoint, law, value.tagPresent, true, 'the feed response is missing its validator'); if (missingTag) return missingTag;
    }
    if (wanted.generation && value.tag !== undefined) {
      const key = `${wanted.generation.epoch}:${wanted.generation.revision}`;
      if (generationTags.has(key)) { const changed = differs(row.checkpoint, law, value.tag, generationTags.get(key), 'one feed generation has different ETags'); if (changed) return changed; }
      for (const [other, tag] of generationTags) if (other !== key && tag === value.tag) return differs(row.checkpoint, law, key, other, 'different feed generations share one ETag')!;
      generationTags.set(key, value.tag);
    }
    if (wanted.serial !== undefined) {
      const previous = serialArtifacts.get(wanted.serial), actual = { bytes: value.bytes, tag: value.tag };
      if (previous) { const drift = differs(row.checkpoint, law, actual, previous, 'one saved publication has different bytes or ETags'); if (drift) return drift; }
      serialArtifacts.set(wanted.serial, actual);
    }
  }
  return values(trace, 'history complete').length ? differs('history complete', law, rows.length, expected.length) ?? pass : pass;
}
oracleProperty({
  id: 'polling-cache-feed-publication', owns: ['src/feed-cache.ts'],
  law: { statement: 'For every controlled feed history, responses serve a complete legal saved source rendering, generation-bearing bytes prevent stale builders replacing newer publications, failures preserve saved bytes and permit retry, and unchanged request or minute checks perform only their declared cheap reads.', authority: 'docs/d1-polling-cache-design.md P5–P9/R4–R9 and original independent FeedReference receiving schedules', limits: 'All original local D1/R2 controlled PUT/read/cold/cron schedules; no bounded stale age, deployed provider/proxy or global single-flight guarantee.' },
  histories: feedPlans, label: plan => plan.name, model: feedModel, driver: feedDriver, check: feedCheck,
  calibrations: [
    { name: 'mixed source values', law: 'feed publication', history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'feed artifact' ? { ...entry, value: { ...(entry.value as object), facts: { title: 'B', bio: 'bio-B', body: '<p>body-A</p>' } } } : entry) },
    { name: 'same-valued artifact carries old revision', law: 'feed publication', history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'feed artifact' ? { ...entry, value: { ...(entry.value as object), generation: { epoch: 0, revision: -1 } } } : entry) },
  ],
});

// Restore is a lifecycle input: counters may return to zero only under a fresh
// epoch. The second reset deliberately starts without the singleton row.
oracleProperty({
  id: 'polling-cache-restore-epoch', owns: ['src/changes.ts'],
  law: { statement: 'For every restore/reset in the original lifecycle history, reset creates a fresh epoch and zero feed revision, including when the singleton is missing.', authority: 'docs/d1-polling-cache-design.md P9/R9 and scripts/reset-change-epoch.sql lifecycle contract', limits: 'The actual local restore SQL, not proof that every deployment invokes it.' },
  histories: [{ resets: [false, true] }], model: plan => plan.resets.map(() => ({ changed: true, revision: 0 })),
  driver: async (plan, observe) => stored(observe, async () => {
    let before = await generation();
    for (const absent of plan.resets) {
      if (absent) await env.DB.prepare('DELETE FROM change_state WHERE id=1').run();
      await env.DB.prepare(resetEpochSql).run(); const after = await generation();
      observe('restore identity', { changed: after.epoch !== before.epoch, revision: after.revision }); before = after;
    }
  }),
  check: (_plan, trace, expected) => {
    const rows = values(trace, 'restore identity');
    for (let index = 0; index < rows.length; index++) { const bad = differs('restore identity', 'fresh restore epoch', rows[index], expected[index]); if (bad) return bad; }
    return complete(trace) ? differs('history complete', 'fresh restore epoch', rows.length, expected.length) ?? pass : pass;
  },
  calibrations: [{ name: 'reset reuses epoch', law: 'fresh restore epoch', history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'restore identity' ? { ...entry, value: { ...(entry.value as object), changed: false } } : entry) }],
});

type MaintenancePlan = { cron: string; at: number; origin: string; html: string };
const maintenanceBase = { origin: 'https://old.example/blyg/', html: '<img src="media/old.png"><a href="/blyg/f/old/">old</a>' };
const maintenancePlans: MaintenancePlan[] = [
  { ...maintenanceBase, cron: '*/15 * * * *', at: Date.UTC(2026, 9, 6, 12, 0) },
  { ...maintenanceBase, cron: '*/15 * * * *', at: Date.UTC(2026, 9, 7, 0, 0) },
  { ...maintenanceBase, cron: '0 0 * * *', at: Date.UTC(2026, 9, 6, 12, 0) },
];
oracleProperty({
  id: 'polling-cache-maintenance', owns: ['src/feed-cache.ts', 'src/changes.ts'],
  law: { statement: 'For every original scheduled maintenance history, quarter-hour polling leaves URL repair and claim pruning to daily work; midnight performs daily maintenance even with only quarter-hour configuration, and the dedicated daily cron performs neither subscription polling nor feed work.', authority: 'docs/d1-polling-cache-design.md R4 cron separation and original daily/quarter-hour receiving witnesses', limits: 'Local scheduled entrypoint with paused legacy import; no deployed timer delivery guarantee.' },
  histories: maintenancePlans,
  model: plan => {
    const dailyOnly = plan.cron === '0 0 * * *', time = new Date(plan.at), daily = dailyOnly || time.getUTCHours() === 0 && time.getUTCMinutes() === 0;
    const html = daily ? plan.html.replace('media/old.png', new URL('media/old.png', plan.origin).href).replace('/blyg/f/old/', new URL('/blyg/f/old/', plan.origin).href) : plan.html;
    return { html, daily, dailyOnly };
  },
  driver: async (plan, observe) => stored(observe, async () => {
    await env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,status,created) VALUES('legacy-cron','blyg',?,?,'Old','paused','now')").bind(plan.origin, new URL('feed.xml', plan.origin).href).run();
    await env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,content_html,observed_at) VALUES('legacy-cron','old','fragment','current',1,?,'now')").bind(plan.html).run();
    const db = observedDB(), ctx = createExecutionContext();
    await worker.scheduled({ cron: plan.cron, scheduledTime: plan.at, noRetry() {} }, { ...env, DB: db.db }, ctx); await waitOnExecutionContext(ctx);
    const value = await env.DB.prepare("SELECT content_html FROM imported_items WHERE subscription_id='legacy-cron' AND remote_id='old'").first<{ content_html: string }>();
    observe('maintenance effects', { html: value?.content_html, repairRead: db.statements.some(sql => sql.includes('content_html GLOB')), prunes: db.statements.some(sql => /DELETE FROM mentions_in/.test(sql)), polls: db.statements.some(sql => /SELECT \* FROM subscriptions/.test(sql)), feedReads: db.statements.some(sql => sql.includes('FROM change_state')) });
  }),
  check: (_plan, trace, expected) => {
    const rows = values(trace, 'maintenance effects') as { html: string; repairRead: boolean; prunes: boolean; polls: boolean; feedReads: boolean }[];
    for (const row of rows) {
      const bad = differs('maintenance effects', 'scheduled work separation', { html: row.html, prunes: row.prunes, ...(!expected.daily ? { repairRead: row.repairRead } : {}), ...(expected.dailyOnly ? { polls: row.polls, feedReads: row.feedReads } : {}) }, { html: expected.html, prunes: expected.daily, ...(!expected.daily ? { repairRead: false } : {}), ...(expected.dailyOnly ? { polls: false, feedReads: false } : {}) }); if (bad) return bad;
    }
    return complete(trace) ? differs('history complete', 'scheduled work separation', rows.length, 1) ?? pass : pass;
  },
  calibrations: [{ name: 'quarter-hour poll performs daily prune', law: 'scheduled work separation', history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'maintenance effects' ? { ...entry, value: { ...(entry.value as object), prunes: true } } : entry) }],
});

oracleProperty({
  id: 'polling-cache', owns: ['src/feed-cache.ts'],
  law: { statement: 'After each settled source write and refresh, a fresh RSS response contains the exact independently predicted title, biography and body.', authority: 'docs/d1-polling-cache-design.md; original polling-cache campaign', limits: 'One to eight writes chosen from the original three-value grammar; settled sequential refreshes.' },
  histories: {
    arbitrary: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 8 }), runs: 8, fixedSeeds: [20261001], states: ['source changes', 'settled fresh read', 'repeated visible value'],
    constructed: [
      { name: 'all source values', enters: ['source changes', 'settled fresh read'], build: () => [0, 1, 2] },
      { name: 'repeated visible value', enters: ['source changes', 'settled fresh read', 'repeated visible value'], build: () => [0, 1, 0] },
    ],
  },
  model: (history: number[]) => history.map(value => expected(String(value))),
  reached: (history, trace) => {
    const states: string[] = [], source = ['A', ...history.map(String)];
    if (source.some((value, index) => index > 0 && value !== source[index - 1]) && values(trace, 'feed settled values').length) states.push('source changes');
    if (values(trace, 'feed settled values').length === history.length && history.length) states.push('settled fresh read');
    if (history.some((value, index) => history.slice(0, index).includes(value)) && values(trace, 'feed settled values').length === history.length) states.push('repeated visible value');
    return states;
  },
  driver: async (history, observe) => {
    await stored(observe, async () => {
      await seed(); await clearArtifacts(); const initial = await request(); await initial.response.text(); await initial.finish();
      for (const value of history) {
        await setFacts(String(value)); const stale = await request(); await stale.response.text(); await stale.finish();
        const fresh = await request(), xml = await fresh.response.text(); await fresh.finish(); observe('feed settled values', facts(xml, observe));
      }
    });
    },
  check: (_history, trace, expected) => {
    const invalid = common(trace, 'feed settled values'); if (invalid) return invalid;
    const rows = values(trace, 'feed settled values');
    for (let index = 0; index < rows.length; index++) { const bad = differs('feed settled values', 'feed settled values', rows[index], expected[index]); if (bad) return bad; }
    return values(trace, 'history complete').length ? differs('history complete', 'feed settled values', rows.length, expected.length) ?? pass : pass;
  },
  calibrations: [{ name: 'mixed source values', law: 'feed settled values', history: { constructed: 'all source values' }, corrupt: trace => trace.map(entry => entry.checkpoint === 'feed settled values' ? { ...entry, value: { ...(entry.value as FeedFacts), body: 'stale body' } } : entry) }],
});
