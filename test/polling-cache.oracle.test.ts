/**
 * Contract: design v3 P1–P10/R1–R9 and minute feed/daily maintenance jobs.
 * Reference: polling-cache-oracle-model.ts.
 * Driver: real D1/R2 bindings, real makeApp feed/change HTTP routes, and direct
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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import worker, { makeApp } from '../src/index.ts';
import { readChanges, readFeedRevision } from '../src/changes.ts';
import type { Env } from '../src/types.ts';
import { BASE, login } from './helpers.ts';
import { atCheckpoint, campaign } from './oracle-campaign.ts';
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
  await env.DB.prepare("UPDATE change_state SET epoch=lower(hex(randomblob(16))),items=0,reading=0,subscriptions=0,hoppers=0,signals=0,settings=0,feed=0,mentions=0,responses=0 WHERE id=1").run();
  await env.DB.batch(['versions','media','items','settings','hopper_items','signals','read_state','imported_items','subscriptions','hoppers','mentions_in','mentions_out'].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  await clearArtifacts();
});
afterEach(() => vi.useRealTimers());
async function request(bindings: Env = env, headers: HeadersInit = {}, method = 'GET') {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`${BASE}/blyg/feed.xml`, { headers, method }), bindings, ctx);
  return { response, finish: () => waitOnExecutionContext(ctx) };
}
async function changes(cookie: string): Promise<OracleToken> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`${BASE}/blyg/api/changes`, { headers: { cookie } }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
  return response.json();
}
function facts(xml: string): FeedFacts {
  expect(XMLValidator.validate(xml)).toBe(true);
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
async function saved() {
  const objects = await env.MEDIA.list({ prefix: '__cache/feed/' }); expect(objects.objects).toHaveLength(1);
  const object = await env.MEDIA.get(objects.objects[0].key); if (!object) throw new Error('oracle saved artifact missing');
  const xml = await object.text(), epoch = object.customMetadata!.epoch, revision = Number(object.customMetadata!.revision);
  const comment = xml.match(/^<\?xml[^>]*\?>\n<!-- cache-generation:([a-f0-9]+) -->/);
  atCheckpoint('feed generation bytes', () => expect(comment).toBeTruthy());
  const bytes = Uint8Array.from(comment![1].match(/../g)!, pair => parseInt(pair, 16));
  atCheckpoint('feed generation bytes', () => expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual([object.customMetadata!.renderer, epoch, revision]));
  return { xml, epoch, revision, etag: object.httpEtag };
}

describe('trigger revision oracle', () => {
  for (const fixture of triggerFields) it(`tracks ${triggerFamilies[fixture.family].table}.${fixture.field} independently`, async () => {
    const family = triggerFamilies[fixture.family], cookie = await login();
    await env.DB.prepare(family.insert).run();
    if (family.table === 'items') await env.DB.prepare(family.update).run();
    const before = await changes(cookie);
    await env.DB.prepare(`UPDATE ${family.table} SET ${fixture.field}=?`).bind(fixture.value).run();
    const after = await changes(cookie);
    atCheckpoint('trigger exact domain effects', () => expect(changedDomains(before, after).sort()).toEqual([...fixture.domains].sort()));
  });
  it('fresh Reading and hopper DTO changes require their own invalidation domains', async () => {
    const cookie = await login();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES('dependency-source','blyg','https://source/','https://source/feed.xml','Before','2026-01-01')"),
      env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_html) VALUES('dependency-source','r','fragment','current',1,'2026-01-01T00:00:00Z','<p>Before</p>')"),
      env.DB.prepare("INSERT INTO hoppers(id,name,created) VALUES('dependency-hopper','Hopper','2026-01-01')"),
      env.DB.prepare("INSERT INTO hopper_items(hopper_id,subscription_id,remote_id,added_at) VALUES('dependency-hopper','dependency-source','r','2026-01-01')"),
    ]);
    async function read(path: string) {
      const ctx = createExecutionContext(); const response = await app.fetch(new Request(BASE + path, { headers: { cookie } }), env, ctx);
      expect(response.status).toBe(200); const data = await response.json(); await waitOnExecutionContext(ctx); return data;
    }
    const paths = ['/blyg/api/reading', '/blyg/api/hoppers/dependency-hopper'];
    const before = await Promise.all(paths.map(read)), counters = await changes(cookie);
    await env.DB.prepare("UPDATE imported_items SET content_html='<p>After</p>' WHERE subscription_id='dependency-source'").run();
    const after = await Promise.all(paths.map(read)), changed = await changes(cookie);
    // This second formulation observes actual response differences instead of
    // copying the production's table-to-domain classifier. Fresh renderers are
    // the trusted receiver; separate content oracles own their HTML semantics.
    expect(after[0]).not.toEqual(before[0]); expect(after[1]).not.toEqual(before[1]);
    expect(changed.domains.reading).toBeGreaterThan(counters.domains.reading); expect(changed.domains.hoppers).toBeGreaterThan(counters.domains.hoppers);
  });
  it('a read mark changes the Reading DTO and its domain, and a replay changes neither', async () => {
    const cookie = await login();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES('read-source','blyg','https://source/','https://source/feed.xml','Source','2026-01-01')"),
      env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_html) VALUES('read-source','r','fragment','current',2,'2026-01-01T00:00:00Z','<p>Body</p>')"),
    ]);
    async function call(method: string, path: string, body?: unknown) {
      const ctx = createExecutionContext();
      const response = await app.fetch(new Request(BASE + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json', origin: BASE } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
      expect(response.status).toBe(200); const data = await response.json(); await waitOnExecutionContext(ctx); return data;
    }
    const before = await call('GET', '/blyg/api/reading'), counters = await changes(cookie);
    await call('PUT', '/blyg/api/reading/read-source/r/read', { version: 2 });
    const after = await call('GET', '/blyg/api/reading'), changed = await changes(cookie);
    // Observed through the fresh response, not the production classifier.
    expect(after).not.toEqual(before);
    atCheckpoint('trigger exact domain effects', () => expect(changedDomains(counters, changed)).toEqual(['reading']));
    await call('PUT', '/blyg/api/reading/read-source/r/read', { version: 1 });
    expect(await call('GET', '/blyg/api/reading')).toEqual(after);
    expect(await changes(cookie)).toEqual(changed);
    // Clearing (0026) changes the DTO and its domain; a read from before the
    // clear is refused by the tombstone and changes neither.
    await call('DELETE', '/blyg/api/reading/read-source/r/read');
    const cleared = await call('GET', '/blyg/api/reading'), clearedChanges = await changes(cookie);
    expect(cleared).not.toEqual(after);
    atCheckpoint('trigger exact domain effects', () => expect(changedDomains(changed, clearedChanges)).toEqual(['reading']));
    await call('PUT', '/blyg/api/reading/read-source/r/read', { version: 2, readAt: '2000-01-01T00:00:00Z' });
    expect(await call('GET', '/blyg/api/reading')).toEqual(cleared);
    expect(await changes(cookie)).toEqual(clearedChanges);
  });
  it('mention status transitions move exactly the domains whose responses they change', async () => {
    const cookie = await login(); await seed();
    await env.DB.prepare("UPDATE items SET responses_override=1 WHERE id='cache-item'").run();
    async function read(path: string, headers: HeadersInit = { cookie }) {
      const ctx = createExecutionContext(); const response = await app.fetch(new Request(BASE + path, { headers }), env, ctx);
      expect(response.status).toBe(200); const body = await response.text(); await waitOnExecutionContext(ctx); return body;
    }
    // The Studio's inbound list, and the public page's responses section as a reader receives it.
    const studio = () => read('/blyg/api/mentions?direction=inbound');
    const page = async () => (await read('/blyg/f/cache-item/', {})).match(/<section[^>]*responses[\s\S]*?<\/section>/)?.[0] ?? '';
    const verify = "status='verified',relation='stub',source_origin='https://responder.example/',source_id='r',source_kind='thread',source_version=1,source_page='t/r/',source_author_json='{\"name\":\"Witness\"}',verified_at='2026-10-18T00:00:00Z'";
    // Receiver writes, in the order a claim's life takes them. Expected domains
    // follow from the observed responses below, not from the trigger text.
    const steps: [string, string, OracleDomain[]][] = [
      ['claim', "INSERT INTO mentions_in(id,source,target,target_item_id,status,first_seen,last_seen) VALUES('w','https://responder.example/t/r/','https://us/f/cache-item/','cache-item','pending','t','t')", []],
      ['verification fails', "UPDATE mentions_in SET status='failed',error='no link' WHERE id='w'", []],
      ['claimed again', "UPDATE mentions_in SET status='pending',error=NULL,attempts=1,last_seen='t2' WHERE id='w'", []],
      ['verified', `UPDATE mentions_in SET ${verify} WHERE id='w'`, ['mentions', 'responses']],
      ['hidden', "UPDATE mentions_in SET hidden=1 WHERE id='w'", ['mentions', 'responses']],
      ['hidden, claimed again', "UPDATE mentions_in SET status='pending',attempts=2,last_seen='t3' WHERE id='w'", ['mentions']],
      ['hidden, verified', `UPDATE mentions_in SET ${verify} WHERE id='w'`, ['mentions']],
      ['hidden, withdrawn at source', "UPDATE mentions_in SET status='gone',error='withdrawn' WHERE id='w'", ['mentions']],
      ['gone, claimed again', "UPDATE mentions_in SET status='pending',attempts=3,last_seen='t4' WHERE id='w'", ['mentions']],
      ['shown while pending', "UPDATE mentions_in SET hidden=0 WHERE id='w'", []],
      ['shown, verified', `UPDATE mentions_in SET ${verify} WHERE id='w'`, ['mentions', 'responses']],
      ['pruned', "DELETE FROM mentions_in WHERE id='w'", ['mentions', 'responses']],
      ['failed claim pruned', "INSERT INTO mentions_in(id,source,target,target_item_id,status,first_seen,last_seen) VALUES('f','https://spam.example/','https://us/f/cache-item/','cache-item','failed','t','t')", []],
      ['failed claim pruned', "DELETE FROM mentions_in WHERE id='f'", []],
    ];
    for (const [name, sql, domains] of steps) {
      const before = { studio: await studio(), page: await page(), changes: await changes(cookie) };
      await env.DB.prepare(sql).run();
      const after = { studio: await studio(), page: await page(), changes: await changes(cookie) };
      const observed: OracleDomain[] = [];
      if (after.studio !== before.studio) observed.push('mentions');
      if (after.page !== before.page) observed.push('responses');
      // A step with no observable change must not have been written as one.
      expect(observed, name).toEqual(domains);
      atCheckpoint('trigger exact domain effects', () => expect(changedDomains(before.changes, after.changes), name).toEqual(domains));
    }
    expect(await page()).toBe('');
  });
  it('the timed update-state read crosses its exact daily deadline without source changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); const start = Date.parse('2026-10-01T12:00:00Z'); vi.setSystemTime(start);
    const cookie = await login();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO settings(key,value) VALUES('update_check','on')"),
      env.DB.prepare("INSERT INTO settings(key,value) VALUES('update_checked_at',?)").bind(new Date(start).toISOString()),
    ]);
    const baseline = await changes(cookie);
    async function readUpdate() {
      const ctx = createExecutionContext(); const response = await app.fetch(new Request(`${BASE}/blyg/api/update-state`, { headers: { cookie } }), env, ctx);
      expect(response.status).toBe(200); await response.text(); await waitOnExecutionContext(ctx);
    }
    vi.setSystemTime(start + 24 * 60 * 60 * 1000 - 1); await readUpdate(); expect(await changes(cookie)).toEqual(baseline);
    vi.setSystemTime(start + 24 * 60 * 60 * 1000); expect(await changes(cookie)).toEqual(baseline); await readUpdate();
    expect((await env.DB.prepare("SELECT value FROM settings WHERE key='update_checked_at'").first<{ value: string }>())!.value).toBe(new Date(Date.now()).toISOString());
    expect((await changes(cookie)).domains.settings).toBeGreaterThan(baseline.domains.settings);
  });
  for (const fixture of triggerFamilies) for (const event of ['insert', 'update', 'remove'] as const) it(`${fixture.table}: missing state rejects ${event}`, async () => {
    if (event !== 'insert') await env.DB.prepare(fixture.insert).run();
    const before = await env.DB.prepare(`SELECT * FROM ${fixture.table} ORDER BY rowid`).all();
    await env.DB.prepare('DELETE FROM change_state WHERE id=1').run();
    await expect(env.DB.prepare(fixture[event]).run()).rejects.toThrow();
    expect((await env.DB.prepare(`SELECT * FROM ${fixture.table} ORDER BY rowid`).all()).results).toEqual(before.results);
  });
  it('every current column participates in its update changed-value guard', async () => {
    for (const fixture of triggerFamilies) {
      const columns = await env.DB.prepare(`PRAGMA table_info(${fixture.table})`).all<{ name: string }>();
      const trigger = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").bind(`change_${fixture.table}_update`).first<{ sql: string }>();
      expect(trigger).toBeTruthy();
      for (const column of columns.results) expect(trigger!.sql).toContain(`OLD."${column.name}" IS NOT NEW."${column.name}"`);
    }
  });
  for (const fixture of triggerFamilies) it(`${fixture.table}: direct insert/update/delete effect family`, async () => {
    const cookie = await login();
    for (const sql of [fixture.insert, fixture.update, fixture.remove]) {
      const before = await changes(cookie); await env.DB.prepare(sql).run(); const after = await changes(cookie);
      atCheckpoint('trigger exact domain effects', () => {
        expect(changedDomains(before, after).sort()).toEqual([...fixture.domains].sort());
        for (const domain of fixture.domains) expect(after.domains[domain]).toBeGreaterThan(before.domains[domain]);
      });
    }
  });
  it('trigger bookkeeping preserves the zero/nonzero meaning of D1 changes', async () => {
    await seed();
    const absent = await env.DB.prepare("DELETE FROM items WHERE id='absent-review-item'").run();
    const changed = await env.DB.prepare("UPDATE items SET content_md='review-body' WHERE id='cache-item'").run();
    expect(Boolean(absent.meta.changes)).toBe(false);
    expect(Boolean(changed.meta.changes)).toBe(true);
  });
  it('receives the prototype write-amplification witness without calling it deployed billing', async () => {
    const cookie = await login(), before = await changes(cookie);
    const start = await env.DB.prepare('SELECT total_changes() AS value').first<{ value: number }>();
    await env.DB.batch(Array.from({ length: 100 }, (_, i) => env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at) VALUES('bulk',?,'fragment','current',1,'now')").bind(`r${i}`)));
    const end = await env.DB.prepare('SELECT total_changes() AS value').first<{ value: number }>();
    const after = await changes(cookie); expect(after.domains.reading - before.domains.reading).toBe(100);
    // Native D1 adds bookkeeping changes beyond the source+trigger rows counted
    // by plain SQLite. Compare the same receiving batch with tracking removed;
    // that cancels provider overhead instead of labelling it application work.
    await env.DB.prepare('DROP TRIGGER change_imported_items_insert').run();
    const controlStart = await env.DB.prepare('SELECT total_changes() AS value').first<{ value: number }>();
    await env.DB.batch(Array.from({ length: 100 }, (_, i) => env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at) VALUES('control',?,'fragment','current',1,'now')").bind(`r${i}`)));
    const controlEnd = await env.DB.prepare('SELECT total_changes() AS value').first<{ value: number }>();
    atCheckpoint('trigger source and tracking writes', () => expect((end!.value - start!.value) - (controlEnd!.value - controlStart!.value)).toBe(100));
    expect((await changes(cookie)).domains).toEqual(after.domains);
  });
  it('the actual missing-delete trigger control fails at the domain checkpoint', async () => {
    const cookie = await login(); await seed();
    await env.DB.exec('DROP TRIGGER change_items_delete');
    const before = await changes(cookie); await env.DB.prepare("DELETE FROM items WHERE id='cache-item'").run(); const after = await changes(cookie);
    expect(() => atCheckpoint('trigger exact domain effects', () => expect(changedDomains(before, after).sort()).toEqual(['feed', 'items', 'reading']))).toThrow('trigger exact domain effects');
  });
  it('denies unauthenticated change reads', async () => {
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(`${BASE}/blyg/api/changes`), env, ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await waitOnExecutionContext(ctx);
  });
  it('tracks direct writes, old timestamps, deletes, diagnostics and rollback', async () => {
    const cookie = await login(); await seed();
    async function effect(sql: string, domains: OracleDomain[]) {
      const before = await changes(cookie); await env.DB.prepare(sql).run(); const after = await changes(cookie);
      atCheckpoint('trigger exact domain effects', () => {
        expect(changedDomains(before, after).sort()).toEqual([...domains].sort());
        expect(after.epoch).toBe(before.epoch);
        for (const domain of domains) expect(after.domains[domain]).toBeGreaterThan(before.domains[domain]);
      });
    }
    await effect("UPDATE items SET content_md='draft changed' WHERE id='cache-item'", ['items']);
    await effect("UPDATE items SET content_md=content_md WHERE id='cache-item'", []);
    await env.DB.prepare("INSERT INTO items(id,created,updated) VALUES('draft-autosave','t','t')").run();
    await effect("UPDATE items SET content_md='typing',updated='later' WHERE id='draft-autosave'", ['items']);
    await effect("INSERT INTO subscriptions(id,kind,origin,feed_url,created) VALUES('s','blyg','https://source/','https://source/feed.xml','old')", ['subscriptions', 'reading', 'hoppers', 'feed']);
    await effect("UPDATE subscriptions SET last_poll_at='later',fail_count=1 WHERE id='s'", ['subscriptions']);
    await effect("UPDATE subscriptions SET etag='x' WHERE id='s'", ['subscriptions']);
    await effect("UPDATE subscriptions SET etag=NULL WHERE id='s'", ['subscriptions']);
    await effect("UPDATE subscriptions SET title='renamed' WHERE id='s'", ['subscriptions', 'reading', 'hoppers', 'feed']);
    await effect("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,updated,observed_at) VALUES('s','old','fragment','current',1,'1990-01-01','now')", ['reading', 'hoppers', 'feed']);
    await effect("UPDATE imported_items SET content_html='repaired' WHERE remote_id='old'", ['reading', 'hoppers']);
    await effect("UPDATE imported_items SET kind='thread',page='/t/old' WHERE remote_id='old'", ['reading', 'hoppers', 'feed']);
    await effect("DELETE FROM imported_items WHERE remote_id='old'", ['reading', 'hoppers', 'feed']);
    const before = await changes(cookie);
    await expect(env.DB.batch([env.DB.prepare("UPDATE subscriptions SET title='rollback' WHERE id='s'"), env.DB.prepare('INSERT INTO missing_table VALUES(1)')])).rejects.toThrow();
    expect(await changes(cookie)).toEqual(before);
    expect((await env.DB.prepare("SELECT title FROM subscriptions WHERE id='s'").first<{ title: string }>())!.title).toBe('renamed');
    await effect("INSERT INTO settings(key,value) VALUES('update_checked_at','t')", ['settings']);
    await effect("UPDATE settings SET key='other' WHERE key='site_title'", ['settings', 'feed']);
    await effect("UPDATE settings SET key='site_title' WHERE key='other'", ['settings', 'feed']);
    await effect("INSERT INTO security_budgets(key,window,used) VALUES('probe',1,1)", []);
    await effect("UPDATE items SET status='withdrawn',kind='withdrawn',version=2 WHERE id='cache-item'", ['items', 'reading', 'feed']);
  });
  it('rejects missing state and counter overflow rather than committing untracked changes', async () => {
    await seed();
    await env.DB.prepare('UPDATE change_state SET items=9007199254740991 WHERE id=1').run();
    await expect(env.DB.prepare("UPDATE items SET content_md='overflow' WHERE id='cache-item'").run()).rejects.toThrow();
    expect((await env.DB.prepare("SELECT content_md FROM items WHERE id='cache-item'").first<{ content_md: string }>())!.content_md).toBe('body-A');
    await env.DB.prepare('DELETE FROM change_state WHERE id=1').run();
    await expect(env.DB.prepare("UPDATE settings SET value='lost' WHERE key='site_title'").run()).rejects.toThrow();
    expect((await env.DB.prepare("SELECT value FROM settings WHERE key='site_title'").first<{ value: string }>())!.value).toBe('A');
  });
  it('rejects missing, extra and stale domain answers at the public checkpoint', () => {
    const baseline: OracleToken = { epoch: 'e', domains: { items: 0, reading: 0, subscriptions: 0, hoppers: 0, signals: 0, settings: 0, feed: 0, mentions: 0, responses: 0 } };
    for (const wrong of [[], ['subscriptions', 'feed'], ['reading']]) {
      expect(() => atCheckpoint('trigger exact domain effects', () => expect(wrong).toEqual(changedDomains(baseline, { ...baseline, domains: { ...baseline.domains, subscriptions: 1 } })))).toThrow('trigger exact domain effects');
    }
  });
});

describe('R2 feed oracle', () => {
  it('same-valued generations cannot hide a stored revision regression', async () => {
    await seed(); const cold = await request(); await cold.response.text(); await cold.finish(); await setFacts('B');
    const entered = deferred(), release = deferred(); let held = false;
    const bucket = observedBucket(async () => { if (!held) { held = true; entered.resolve(); await release.promise; } });
    const old = await request({ ...env, MEDIA: bucket.bucket }); await old.response.text();
    try {
      await entered.promise; await setFacts('A'); await setFacts('B');
      const target = await generation(); const winner = await request({ ...env, MEDIA: observedBucket().bucket }); await winner.response.text(); await winner.finish();
      release.resolve(); await old.finish(); const artifact = await saved();
      atCheckpoint('feed stored generation', () => expect({ epoch: artifact.epoch, revision: artifact.revision }).toEqual(target));
      expect(facts(artifact.xml)).toEqual(expected('B'));
    } finally { release.resolve(); }
  });
  it('epoch changes with reused counters replace cached source identity', async () => {
    await seed(); const first = await request(); await first.response.text(); await first.finish();
    await setFacts('B'); await env.DB.prepare("UPDATE change_state SET epoch='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',feed=0 WHERE id=1").run();
    const refresh = await request(); await refresh.response.text(); await refresh.finish();
    const artifact = await saved(); expect(facts(artifact.xml)).toEqual(expected('B')); expect(artifact.epoch).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'); expect(artifact.revision).toBe(0);
  });
  it('the restore SQL creates a fresh epoch and repairs a missing singleton', async () => {
    const before = await generation(); await env.DB.prepare(resetEpochSql).run(); const after = await generation();
    expect(after.epoch).not.toBe(before.epoch); expect(after.revision).toBe(0);
    await env.DB.prepare('DELETE FROM change_state WHERE id=1').run(); await env.DB.prepare(resetEpochSql).run(); const repaired = await generation();
    expect(repaired.epoch).not.toBe(after.epoch); expect(repaired.revision).toBe(0);
  });
  it('an old-epoch builder loses after the restored generation is installed', async () => {
    await seed(); const cold = await request(); await cold.response.text(); await cold.finish(); await setFacts('B');
    const entered = deferred(), release = deferred(); let held = false;
    const bucket = observedBucket(async () => { if (!held) { held = true; entered.resolve(); await release.promise; } });
    const old = await request({ ...env, MEDIA: bucket.bucket }); await old.response.text();
    try {
      await entered.promise; await setFacts('C'); await env.DB.prepare(resetEpochSql).run(); const target = await generation();
      const restored = await request({ ...env, MEDIA: observedBucket().bucket }); await restored.response.text(); await restored.finish();
      release.resolve(); await old.finish(); const artifact = await saved();
      atCheckpoint('feed restored generation', () => { expect(artifact.epoch).toBe(target.epoch); expect(artifact.revision).toBe(0); expect(facts(artifact.xml)).toEqual(expected('C')); });
    } finally { release.resolve(); }
  });
  it('source-read failure preserves the saved artifact and remains retryable', async () => {
    await seed(); const first = await request(); await first.response.text(); await first.finish(); const initial = await saved(); await setFacts('B');
    let failed = false;
    const recorder = observedDB(async sql => { if (!failed && /FROM versions/.test(sql)) { failed = true; throw new Error('controlled content read failure'); } });
    const refresh = await request({ ...env, DB: recorder.db }); await refresh.response.text(); await refresh.finish();
    expect(await saved()).toEqual(initial);
    const retry = await request(); await retry.response.text(); await retry.finish(); expect(facts((await saved()).xml)).toEqual(expected('B'));
  });
  it('serves saved legal XML and 304/HEAD while unchanged checks perform no render', async () => {
    await seed(); const cold = await request(); const xml = await cold.response.text(); await cold.finish();
    atCheckpoint('feed legal snapshot', () => expect(facts(xml)).toEqual(expected('A')));
    const tag = cold.response.headers.get('etag'); expect(tag).toBeTruthy();
    const recorder = observedDB(), bucket = observedBucket(); const bindings = { ...env, DB: recorder.db, MEDIA: bucket.bucket };
    const warm = await request(bindings, { 'If-None-Match': `"other", W/${tag}` });
    expect(warm.response.status).toBe(304); expect(await warm.response.text()).toBe(''); await warm.finish();
    atCheckpoint('feed unchanged work', () => { expect(recorder.statements).toEqual(['SELECT epoch, feed FROM change_state WHERE id = 1']); expect(bucket.puts()).toBe(0); });
    const head = await request(bindings, {}, 'HEAD'); expect(head.response.status).toBe(200); expect(await head.response.text()).toBe(''); await head.finish();
  });
  it('revalidates even when the stale representation produces a 304', async () => {
    await seed(); const cold = await request(); await cold.response.text(); await cold.finish();
    await setFacts('B');
    const stale = await request(env, { 'If-None-Match': cold.response.headers.get('etag')! });
    expect(stale.response.status).toBe(304); await stale.finish();
    const fresh = await request(); expect(facts(await fresh.response.text())).toEqual(expected('B')); await fresh.finish();
  });
  it('old builders cannot overwrite a newer generation with repeated visible bytes', async () => {
    await seed(); const cold = await request(); await cold.response.text(); await cold.finish();
    await setFacts('B');
    const entered = deferred(), release = deferred(); let first = true;
    const oldBucket = observedBucket(async () => { if (first) { first = false; entered.resolve(); await release.promise; } });
    const old = await request({ ...env, MEDIA: oldBucket.bucket }); await old.response.text();
    try {
      await entered.promise; await setFacts('A');
      const newerBucket = observedBucket(); const newer = await request({ ...env, MEDIA: newerBucket.bucket }); await newer.response.text(); await newer.finish(); const winnerGeneration = await generation();
      release.resolve(); await old.finish();
      const winner = await request(); const body = await winner.response.text();
      atCheckpoint('feed generation non-regression', () => { expect(facts(body)).toEqual(expected('A')); expect(winner.response.headers.get('etag')).not.toBe(cold.response.headers.get('etag')); expect(oldBucket.puts()).toBe(1); });
      const artifact = await saved(); atCheckpoint('feed stored generation', () => expect({ epoch: artifact.epoch, revision: artifact.revision }).toEqual(winnerGeneration));
      await winner.finish();
    } finally { release.resolve(); }
  });
  it('discards a render interrupted between settings and content reads', async () => {
    await seed(); const cold = await request(); await cold.response.text(); await cold.finish(); await setFacts('B');
    const entered = deferred(), release = deferred(); let held = false;
    const recorder = observedDB(async sql => { if (!held && /SELECT key, value FROM settings/.test(sql)) { held = true; entered.resolve(); await release.promise; } });
    const reference = new FeedReference(); reference.commit(expected('B'), await generation());
    const pending = await request({ ...env, DB: recorder.db }); await pending.response.text();
    try {
      await entered.promise; await setFacts('C'); reference.commit(expected('C'), await generation()); release.resolve(); await pending.finish();
      const fresh = await request(); const value = facts(await fresh.response.text());
      atCheckpoint('feed legal snapshot', () => expect(reference.legal(value)).toBe(true));
      expect(value).toEqual(expected('C')); await fresh.finish();
      const artifact = await saved(); atCheckpoint('feed payload generation binding', () => expect(facts(artifact.xml)).toEqual(reference.at(artifact)));
    } finally { release.resolve(); }
  });
  it('failed background publication keeps last good XML and a later request retries', async () => {
    await seed(); const cold = await request(); const initial = await cold.response.text(); await cold.finish(); await setFacts('B');
    const bucket = observedBucket(async () => { throw new Error('controlled R2 interruption'); });
    const failed = await request({ ...env, MEDIA: bucket.bucket }); expect(await failed.response.text()).toBe(initial); await failed.finish();
    expect((await saved()).xml).toBe(initial);
    const retry = await request(); await retry.response.text(); await retry.finish();
    const fresh = await request(); expect(facts(await fresh.response.text())).toEqual(expected('B')); await fresh.finish();
  });
  it('cold competing creators return the conditional winner, not an old overwrite', async () => {
    await seed(); await clearArtifacts();
    const entered = deferred(), release = deferred(); let held = false;
    const bucket = observedBucket(async () => { if (!held) { held = true; entered.resolve(); await release.promise; } });
    const old = request({ ...env, MEDIA: bucket.bucket });
    try {
      await entered.promise; await setFacts('B');
      const winner = await request({ ...env, MEDIA: observedBucket().bucket }); expect(facts(await winner.response.text())).toEqual(expected('B')); await winner.finish();
      release.resolve(); const loser = await old;
      const value = facts(await loser.response.text()); atCheckpoint('feed cold winner', () => expect(value).toEqual(expected('B'))); await loser.finish();
    } finally { release.resolve(); }
  });
  it('rejects mixed values independently of production rendering', () => {
    const reference = new FeedReference(); reference.commit(expected('A')); reference.commit(expected('B'));
    expect(() => atCheckpoint('feed legal snapshot', () => expect(reference.legal({ ...expected('A'), body: expected('B').body })).toBe(true))).toThrow('feed legal snapshot');
  });
  campaign('polling-cache', fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 8 }), async history => {
    await seed(); await clearArtifacts();
    const initial = await request(); await initial.response.text(); await initial.finish();
    for (const n of history) {
      const value = String(n); await setFacts(value);
      const stale = await request(); await stale.response.text(); await stale.finish();
      const fresh = await request(); const parsed = facts(await fresh.response.text()); await fresh.finish();
      atCheckpoint('feed settled values', () => expect(parsed).toEqual(expected(value)));
    }
  });

  it('cold validation exhaustion reuses a valid concurrent saved artifact', async () => {
    await seed(); const entered = deferred(), release = deferred(); let changes = 0;
    const recorder = observedDB(async sql => {
      if (/SELECT key, value FROM settings/.test(sql)) {
        changes++; await setFacts(String(changes));
        if (changes === 1) { entered.resolve(); await release.promise; }
      }
    });
    const cold = request({ ...env, DB: recorder.db });
    try {
      await entered.promise;
      const winner = await request({ ...env, MEDIA: observedBucket().bucket });
      expect(winner.response.status).toBe(200); await winner.response.text(); await winner.finish();
      release.resolve(); const loser = await cold; await loser.finish();
      // This is the review's proposed availability law: saved legal bytes exist.
      expect((await env.MEDIA.list({ prefix: '__cache/feed/' })).objects).toHaveLength(1);
      expect(loser.response.status).toBe(200); expect(facts(await loser.response.text())).toEqual(expected('1'));
    } finally { release.resolve(); }
  });

  it('both change readers reject a native blob epoch', async () => {
    await env.DB.prepare('UPDATE change_state SET epoch=? WHERE id=1').bind(new Uint8Array([1,2])).run();
    await expect(readChanges(env.DB)).rejects.toThrow('change state unavailable');
    // Native SQLite TEXT affinity still permits blobs, so this is a receiving case.
    await expect(readFeedRevision(env.DB)).rejects.toThrow('feed revision unavailable');
  });

  it('cold validation exhaustion rejects a winner whose generation metadata is invalid', async () => {
    await seed(); const entered = deferred(), release = deferred(); let changes = 0;
    const recorder = observedDB(async sql => {
      if (/SELECT key, value FROM settings/.test(sql)) {
        changes++; await setFacts(String(changes));
        if (changes === 1) { entered.resolve(); await release.promise; }
      }
    });
    const cold = request({ ...env, DB: recorder.db });
    try {
      await entered.promise;
      const winner = await request({ ...env, MEDIA: observedBucket().bucket });
      expect(winner.response.status).toBe(200); await winner.response.text(); await winner.finish();
      const key = (await env.MEDIA.list({ prefix: '__cache/feed/' })).objects[0].key;
      await env.MEDIA.put(key, '<broken', { customMetadata: {} });
      release.resolve(); const loser = await cold; await loser.finish();
      expect(loser.response.status).toBe(500);
    } finally { release.resolve(); }
  });
});


describe('feed-only scheduled rebuilds', () => {
  async function configureSite() {
    await env.DB.prepare("INSERT INTO settings(key,value) VALUES('site_url',?)").bind(`${BASE}/blyg/`).run();
  }
  async function tick(bindings: Env = env) {
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now(), noRetry() {} }, bindings, ctx);
    await waitOnExecutionContext(ctx);
  }
  it('cron builds cold XML and changed XML before any feed reader arrives', async () => {
    await seed(); await configureSite();
    await tick(); expect(facts((await saved()).xml)).toEqual(expected('A'));
    await setFacts('B'); await tick();
    const changed = await saved();
    atCheckpoint('scheduled feed changed XML', () => expect(facts(changed.xml)).toEqual(expected('B')));
    const firstReader = await request();
    expect(facts(await firstReader.response.text())).toEqual(expected('B')); await firstReader.finish();
  });
  it('an unchanged minute tick makes only two small D1 reads and no render or put', async () => {
    await seed(); await configureSite(); await tick();
    const db = observedDB(), bucket = observedBucket();
    await tick({ ...env, DB: db.db, MEDIA: bucket.bucket });
    expect(db.statements).toEqual([
      "SELECT value FROM settings WHERE key = 'site_url'",
      'SELECT epoch, feed FROM change_state WHERE id = 1',
    ]);
    expect(bucket.puts()).toBe(0);
  });
  it('a site without a canonical URL keeps request-driven rebuilding', async () => {
    await seed(); const db = observedDB(), bucket = observedBucket();
    await tick({ ...env, DB: db.db, MEDIA: bucket.bucket });
    expect(db.statements).toEqual(["SELECT value FROM settings WHERE key = 'site_url'"]);
    expect(bucket.puts()).toBe(0);
    expect((await env.MEDIA.list({ prefix: '__cache/feed/' })).objects).toHaveLength(0);
    const reader = await request(); expect(facts(await reader.response.text())).toEqual(expected('A')); await reader.finish();
  });
  it('cron joins pending SWR work and receives later writes on the next tick', async () => {
    await seed(); await configureSite(); await tick(); await setFacts('B');
    const entered = deferred(), release = deferred(); let puts = 0;
    const bucket = observedBucket(async () => { if (++puts === 1) { entered.resolve(); await release.promise; } });
    const old = await request({ ...env, MEDIA: bucket.bucket }); await old.response.text();
    let next: Promise<void> | undefined;
    try {
      await entered.promise; await setFacts('C');
      const tickEntered = deferred(); let accesses = 0;
      const bindings = new Proxy({ ...env, MEDIA: bucket.bucket }, {
        get(target, property) {
          if (property === 'MEDIA' && ++accesses === 2) tickEntered.resolve();
          return Reflect.get(target, property);
        },
      });
      next = tick(bindings);
      // The real binding lookup marks the tick's pending-job handoff. Hold the
      // old PUT until that handoff, rather than relying on elapsed time.
      await tickEntered.promise;
      release.resolve(); await old.finish(); await next;
      // HEAD joined the older legal render; its source token remains dirty.
      expect(facts((await saved()).xml)).toEqual(expected('B'));
      await tick({ ...env, MEDIA: bucket.bucket }); const artifact = await saved(), source = await generation();
      atCheckpoint('scheduled feed next-tick retry', () => {
        expect(facts(artifact.xml)).toEqual(expected('C'));
        expect({ epoch: artifact.epoch, revision: artifact.revision }).toEqual(source);
      });
      expect(bucket.puts()).toBe(2);
    } finally { release.resolve(); await old.finish(); await next; }
  });
  it('cron failure preserves legal saved XML and a later tick retries', async () => {
    await seed(); await configureSite(); await tick(); await setFacts('B');
    const broken = observedBucket(async () => { throw new Error('controlled scheduled put failure'); });
    await tick({ ...env, MEDIA: broken.bucket });
    expect(facts((await saved()).xml)).toEqual(expected('A'));
    await tick(); expect(facts((await saved()).xml)).toEqual(expected('B'));
  });
});


describe('daily maintenance dispatch', () => {
  async function legacyImport() {
    await env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,status,created) VALUES('legacy-cron','blyg','https://old.example/blyg/','https://old.example/blyg/feed.xml','Old','paused','now')").run();
    await env.DB.prepare(`INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,content_html,observed_at)
      VALUES('legacy-cron','old','fragment','current',1,'<img src="media/old.png"><a href="/blyg/f/old/">old</a>','now')`).run();
  }
  async function html() {
    return (await env.DB.prepare("SELECT content_html FROM imported_items WHERE subscription_id='legacy-cron' AND remote_id='old'").first<{ content_html: string }>())!.content_html;
  }
  // Noon UTC unless given: the quarter-hour tick at 00:00 UTC runs daily work too.
  async function scheduled(cron: string, bindings: Env, scheduledTime = Date.UTC(2026, 9, 6, 12, 0)) {
    const ctx = createExecutionContext();
    await worker.scheduled({ cron, scheduledTime, noRetry() {} }, bindings, ctx);
    await waitOnExecutionContext(ctx);
  }
  it('the quarter-hour subscription poll leaves legacy repair to daily maintenance', async () => {
    await legacyImport(); const before = await html(), db = observedDB();
    await scheduled('*/15 * * * *', { ...env, DB: db.db });
    expect(await html()).toBe(before);
    expect(db.statements.some(sql => sql.includes('content_html GLOB'))).toBe(false);
    expect(db.statements.some(sql => /DELETE FROM mentions_in/.test(sql))).toBe(false);
  });
  it('a config listing only the quarter-hour cron still gets daily maintenance at 00:00 UTC', async () => {
    await legacyImport(); const db = observedDB();
    await scheduled('*/15 * * * *', { ...env, DB: db.db }, Date.UTC(2026, 9, 7, 0, 0));
    expect(await html()).toBe('<img src="https://old.example/blyg/media/old.png"><a href="https://old.example/blyg/f/old/">old</a>');
    expect(db.statements.some(sql => /DELETE FROM mentions_in/.test(sql))).toBe(true);
  });
  it('daily maintenance repairs old URLs and prunes claims without polling subscriptions', async () => {
    await legacyImport(); const db = observedDB();
    await scheduled('0 0 * * *', { ...env, DB: db.db });
    expect(await html()).toBe('<img src="https://old.example/blyg/media/old.png"><a href="https://old.example/blyg/f/old/">old</a>');
    expect(db.statements.some(sql => /SELECT \* FROM subscriptions/.test(sql))).toBe(false);
    expect(db.statements.some(sql => /DELETE FROM mentions_in/.test(sql))).toBe(true);
    expect(db.statements.some(sql => sql.includes('FROM change_state'))).toBe(false);
  });
});
