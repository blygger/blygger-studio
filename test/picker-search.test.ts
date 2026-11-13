// The picker's search (0.29): every word anywhere in an item's text, a source
// filter (mine / imported / one subscription), and newest or oldest first.
// Unique nonsense words keep these
// assertions independent of whatever else the shared fixture holds.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { apiJson, createAndPublish, login } from "./helpers.ts";
import { readOperations } from "../src/read-api.ts";

let cookie = "";
let mine = "";
const search = async (query: string) => (await apiJson(cookie, "GET", `/blyg/api/search?${query}`)).json as { items: { id: string; source: string; kind: string; sourceTitle: string | null; subscriptionId: string | null; excerpt: string }[]; page: { limit: number; nextCursor: string | null } };

beforeAll(async () => {
  cookie = await login();
  // The match word sits far past the 70-character excerpt the old search saw.
  mine = await createAndPublish(cookie, "An opening paragraph that runs on long enough to push everything after it out of any excerpt at all.\n\nLater: zorbleflux quintessence.");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO subscriptions (id, kind, origin, feed_url, title, created) VALUES ('pick-a', 'blyg', 'https://a.example/', 'https://a.example/feed.xml', 'Alpha Blyg', '2026-10-01')"),
    env.DB.prepare("INSERT INTO subscriptions (id, kind, origin, feed_url, title, created) VALUES ('pick-b', 'blyg', 'https://b.example/', 'https://b.example/feed.xml', '', '2026-10-01')"),
    env.DB.prepare("INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html, l0) VALUES ('pick-a', 'pickaold00000000000000000a', 'thread', 'current', 3, '2026-01-01T00:00:00Z', 'zorbleflux from alpha, older', '<p>zorbleflux from alpha, older</p>', 0)"),
    env.DB.prepare("INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html, l0) VALUES ('pick-b', 'pickbnew00000000000000000b', 'fragment', 'current', 1, '2026-09-30T00:00:00Z', 'zorbleflux quintessence from beta', '<p>zorbleflux quintessence from beta</p>', 0)"),
    // Never offered: an L0 row, and a tombstone with no retained pin (resolveTarget refuses both).
    env.DB.prepare("INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html, l0) VALUES ('pick-a', 'pickl0000000000000000000l0', 'fragment', 'current', 1, '2026-09-30T00:00:00Z', 'zorbleflux legacy', '<p>zorbleflux legacy</p>', 1)"),
    env.DB.prepare("INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html, l0) VALUES ('pick-a', 'picktomb00000000000000000t', 'fragment', 'tombstone', 2, '2026-09-30T00:00:00Z', 'zorbleflux gone', '', 0)"),
  ]);
});

describe("GET /api/search for the picker", () => {
  it("matches a word anywhere in the text, not just the excerpt", async () => {
    const r = await search("q=zorbleflux");
    expect(r.items.map((i) => i.id).sort()).toEqual([mine, "pickaold00000000000000000a", "pickbnew00000000000000000b"].sort());
    expect(r.items).toHaveLength(3); expect(r.page.nextCursor).toBeNull();
  });

  it("needs every word, in any order, case-insensitively", async () => {
    const r = await search("q=" + encodeURIComponent("QUINTESSENCE Zorbleflux"));
    expect(r.items.map((i) => i.id).sort()).toEqual([mine, "pickbnew00000000000000000b"].sort());
  });

  it("filters by source and by one subscription, labelling each row", async () => {
    expect((await search("q=zorbleflux&source=mine")).items).toEqual([expect.objectContaining({ id: mine, source: "mine", sourceTitle: null, subscriptionId: null })]);
    const imported = await search("q=zorbleflux&source=imported");
    expect(imported.items.map((i) => i.source)).toEqual(["imported", "imported"]);
    // A subscription with no title is named by its host.
    expect(imported.items.find((i) => i.subscriptionId === "pick-b")?.sourceTitle).toBe("b.example");
    const one = await search("q=zorbleflux&sub=pick-a");
    expect(one.items).toEqual([expect.objectContaining({ id: "pickaold00000000000000000a", kind: "thread", sourceTitle: "Alpha Blyg" })]);
  });

  it("sorts newest or oldest first, and follows its continuation", async () => {
    const newest = await search("q=zorbleflux&source=imported");
    expect(newest.items.map((i) => i.id)).toEqual(["pickbnew00000000000000000b", "pickaold00000000000000000a"]);
    const oldest = await search("q=zorbleflux&source=imported&sort=oldest");
    expect(oldest.items.map((i) => i.id)).toEqual(["pickaold00000000000000000a", "pickbnew00000000000000000b"]);
    const first = await search("q=zorbleflux&limit=1&sort=oldest&source=imported");
    const page = await search("q=zorbleflux&limit=1&sort=oldest&source=imported&cursor=" + encodeURIComponent(first.page.nextCursor!));
    expect(page).toMatchObject({ items: [{ id: "pickbnew00000000000000000b" }], page: { nextCursor: null } });
  });

  it("treats LIKE wildcards in the query as literal text", async () => {
    expect((await search("q=" + encodeURIComponent("zorble%flux"))).items).toEqual([]);
    expect((await search("q=_orbleflux")).items).toEqual([]);
  });

  it("keeps substring matches across the id and body, with short terms filtering the hits", async () => {
    const ids = async (q: string) => (await search(new URLSearchParams({ q, sub: 'pick-a' }).toString())).items.map(item => item.id);
    expect(await ids('PICKA ORBLEF ld')).toEqual(['pickaold00000000000000000a']);
    expect(await ids('PICKA ORBLEF xx')).toEqual([]);
    expect(await ids('ld')).toEqual([]);
    expect(await ids('')).toEqual(['pickaold00000000000000000a']);
  });

  it("updates the index when an import changes, retains a pin, or is deleted", async () => {
    const insert = env.DB.prepare("INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md) VALUES ('pick-a', 'index-lifecycle', 'fragment', 'current', 1, '2026-10-01', ?)");
    const find = async (q: string) => (await search(new URLSearchParams({ q, sub: 'pick-a' }).toString())).items.map(item => item.id);
    const url = 'https://example.com/a/very/long/literal-path-that-was-too-long-for-sql-like';
    await insert.bind(`first-index-body ${url} x"y`).run();
    expect(await find(url)).toEqual(['index-lifecycle']);
    expect(await find('x"y')).toEqual(['index-lifecycle']);
    expect(await find('x"z')).toEqual([]);
    await env.DB.prepare("UPDATE imported_items SET state='tombstone', pinned_version_retained=1, content_md='pinned-index-body' WHERE remote_id='index-lifecycle'").run();
    expect(await find('first-index-body')).toEqual([]);
    expect(await find('pinned-index-body')).toEqual(['index-lifecycle']);
    await env.DB.prepare("DELETE FROM imported_items WHERE remote_id='index-lifecycle'").run();
    expect(await find('pinned-index-body')).toEqual([]);
  });

  it("reads indexed hits without scanning unrelated source rows on either cursor page", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO subscriptions (id, kind, origin, feed_url, created) VALUES ('pick-aa', 'blyg', 'https://aa.example/', 'https://aa.example/feed.xml', '2026-10-01')"),
      env.DB.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n < 1000)
        INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md)
        SELECT CASE WHEN n <= 500 THEN 'pick-a' ELSE 'pick-aa' END, 'unrelated-' || n, 'fragment', 'current', 1, '2026-10-01',
          CASE WHEN n <= 500 THEN 'unrelated body' ELSE 'common-in-other-subscription' END FROM numbers`),
      env.DB.prepare("INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md) VALUES ('pick-a', 'one-scoped-match', 'fragment', 'current', 1, '2026-10-01', 'common-in-other-subscription')"),
    ]);
    const reads: number[] = [];
    const lookupCounts: number[] = [];
    const db = new Proxy(env.DB, {
      get(target, key, receiver) {
        if (key !== 'prepare') return Reflect.get(target, key, receiver);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes('cursor_source')) return stmt;
          return { bind: (...values: unknown[]) => ({ all: async () => {
            const result = await stmt.bind(...values).all();
            reads.push(result.meta.rows_read);
            const plan = await target.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all<{ detail: string }>();
            lookupCounts.push(plan.results.filter(row => row.detail.includes('SCAN f VIRTUAL TABLE INDEX')).length);
            return result;
          } }) };
        };
      },
    });
    const context = { env: { ...env, DB: db }, url: 'https://example.com/blyg/api/search', access: null, extensions: [], defer() {} };
    const query = { q: 'zorbleflux', limit: '1' };
    const first = await readOperations.search(context, { path: {}, query });
    if (!first.ok || !first.value.page.nextCursor) throw new Error('missing search cursor');
    const next = await readOperations.search(context, { path: {}, query: { ...query, cursor: first.value.page.nextCursor } });
    expect(next).toMatchObject({ ok: true, value: { items: [{ id: 'pickbnew00000000000000000b' }] } });
    const scoped = await readOperations.search(context, { path: {}, query: { q: 'common-in-other-subscription', sub: 'pick-a' } });
    expect(scoped).toMatchObject({ ok: true, value: { items: [{ id: 'one-scoped-match' }], page: { nextCursor: null } } });
    const oldestQuery = { ...query, source: 'imported', sort: 'oldest' };
    const oldest = await readOperations.search(context, { path: {}, query: oldestQuery });
    expect(oldest).toMatchObject({ ok: true, value: { items: [{ id: 'pickaold00000000000000000a' }] } });
    if (!oldest.ok || !oldest.value.page.nextCursor) throw new Error('missing oldest-first search cursor');
    const oldestNext = await readOperations.search(context, { path: {}, query: { ...oldestQuery, cursor: oldest.value.page.nextCursor } });
    expect(oldestNext).toMatchObject({ ok: true, value: { items: [{ id: 'pickbnew00000000000000000b' }], page: { nextCursor: null } } });
    expect(lookupCounts).toEqual([2, 2, 1, 1, 1]);
    expect(reads).toHaveLength(5);
    for (const count of reads) expect(count).toBeLessThan(100);
  });
});
