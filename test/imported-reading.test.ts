// GET /reading/imported (studio#11 item 2): every imported item, keyset-paged on
// (observed_at, subscription_id, remote_id), with the fields a client authors
// from. A desktop reader syncs from it, so what is pinned here is what it
// depends on: the row shape, a walk that neither drops nor repeats rows when
// a poll lands between two pages, a refused forged cursor, the read-state join
// (a clear reads null), the origin's lineage verbatim, and owner:read.
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createOwnerApi } from "../src/owner-api.ts";
import { encodeReadingCursor } from "../src/imported-reading.ts";
import { BASE, apiJson, login } from "./helpers.ts";

const db = () => env.DB;
// Newer than any other file's fixtures, so these rows lead the feed.
const T = (s: number) => `2031-01-01T00:00:0${s}.000Z`;

async function seedSub(id: string, title: string) {
  await db()
    .prepare("INSERT INTO subscriptions (id, kind, origin, feed_url, title, created) VALUES (?, 'blyg', ?, ?, ?, '2026-01-01T00:00:00.000Z')")
    .bind(id, `https://${id}.example/`, `https://${id}.example/feed.xml`, title)
    .run();
}

async function seedItem(sub: string, remote: string, observedAt: string, extra: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    kind: "fragment", state: "current", version: 1, created: "2026-01-01T00:00:00.000Z", updated: "2026-01-02T00:00:00.000Z",
    content_md: `md ${remote}`, content_html: `<p>html ${remote}</p>`, author_json: null, page: null,
    transclusions_json: null, stub_of_json: null, forked_from_json: null, pinned_version_retained: null, ...extra,
  };
  const cols = Object.keys(row);
  await db()
    .prepare(`INSERT INTO imported_items (subscription_id, remote_id, observed_at, ${cols.join(", ")}) VALUES (?, ?, ?, ${cols.map(() => "?").join(", ")})`)
    .bind(sub, remote, observedAt, ...cols.map((c) => row[c]))
    .run();
}

async function walk(cookie: string, limit: number, between?: (page: number) => Promise<void>) {
  const seen: string[] = [], sizes: number[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const r: { status: number; json: any } = await apiJson(cookie, "GET", `/api/reading/imported?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(r.status).toBe(200);
    sizes.push(r.json.items.length);
    seen.push(...r.json.items.map((x: any) => `${x.subscriptionId}/${x.remoteId}`));
    cursor = r.json.next;
    if (!cursor) break;
    await between?.(page);
  }
  return { seen, sizes };
}

const mine = (keys: string[]) => keys.filter((k) => k.startsWith("irA/") || k.startsWith("irB/"));
const ORDER = ["irB/b9", "irB/gone", "irB/t5", "irB/t4", "irB/t3", "irA/t2", "irA/t1", "irA/a2", "irA/a1"];

describe("GET /reading/imported", () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = await login();
    await seedSub("irA", "Alpha");
    await seedSub("irB", "Beta");
    await seedItem("irA", "a1", T(1), {
      kind: "thread",
      author_json: JSON.stringify({ name: "Ann", url: "https://irA.example/ann", extra: 1 }),
      page: "posts/a1/",
      transclusions_json: JSON.stringify([{ id: "x", version: 2, origin: "https://other.example/", cited: { source: "Other", url: "https://other.example/f/x/", retrieved: "2026-01-01T00:00:00Z" }, future: true }]),
      stub_of_json: JSON.stringify({ origin: "https://other.example/", id: "x", version: 2, future: "kept" }),
      forked_from_json: JSON.stringify({ origin: "https://third.example/", id: "y", version: 1 }),
    });
    await seedItem("irA", "a2", T(2), { author_json: "not json", transclusions_json: "{broken", stub_of_json: "[1]", forked_from_json: "\"str\"" });
    // A five-way tie across both subscriptions, the shape one poll run leaves.
    for (const [s, r] of [["irA", "t1"], ["irA", "t2"], ["irB", "t3"], ["irB", "t4"], ["irB", "t5"]]) await seedItem(s, r, T(3));
    await seedItem("irB", "gone", T(4), { state: "tombstone", content_md: "", content_html: "", kind: "thread", version: 3, pinned_version_retained: 2 });
    await seedItem("irB", "b9", T(5), { content_html: `<p onclick="x()">b9<script>alert(1)</script></p>` });
    await db().prepare("INSERT INTO signals (subscription_id, remote_id, thumb, at) VALUES ('irA','a1',1,'x'), ('irA','a2',-1,'x')").run();
    await db().prepare("INSERT INTO hoppers (id, name, slug, public, created) VALUES ('irh2','Two',NULL,0,'2026-01-02'), ('irh1','One','ir-one',1,'2026-01-01')").run();
    await db().prepare("INSERT INTO hopper_items (hopper_id, subscription_id, remote_id, added_at) VALUES ('irh2','irA','a1','x'), ('irh1','irA','a1','x'), ('irh1','irB','b9','x')").run();
  });

  it("requires owner auth", async () => {
    expect((await apiJson("", "GET", "/api/reading/imported")).status).toBe(401);
  });

  it("returns every imported item newest observed first, with the authoring fields", async () => {
    const { status, json } = await apiJson(cookie, "GET", "/api/reading/imported?limit=100");
    expect(status).toBe(200);
    expect(json.limit).toBe(100);
    expect(mine(json.items.map((x: any) => `${x.subscriptionId}/${x.remoteId}`))).toEqual(ORDER);
    const by = new Map<string, any>(json.items.map((x: any) => [x.remoteId, x]));
    expect(by.get("a1")).toEqual({
      subscriptionId: "irA", subscriptionTitle: "Alpha", origin: "https://irA.example/", remoteId: "a1",
      kind: "thread", withdrawn: false, l0: false, version: 1, readVersion: null,
      created: "2026-01-01T00:00:00.000Z", updated: "2026-01-02T00:00:00.000Z", observedAt: T(1),
      contentMd: "md a1", contentHtml: "<p>html a1</p>",
      author: { name: "Ann", url: "https://irA.example/ann" },
      page: "posts/a1/", sourceUrl: "https://irA.example/posts/a1/", pinnedVersionRetained: null,
      thumb: 1, hoppers: ["irh1", "irh2"],
      // The origin's data verbatim, unknown members included.
      transclusions: [{ id: "x", version: 2, origin: "https://other.example/", cited: { source: "Other", url: "https://other.example/f/x/", retrieved: "2026-01-01T00:00:00Z" }, future: true }],
      stubOf: { origin: "https://other.example/", id: "x", version: 2, future: "kept" },
      forkedFrom: { origin: "https://third.example/", id: "y", version: 1 },
    });
    // Malformed or wrong-kind stored JSON reads as null and never fails the page.
    expect(by.get("a2")).toMatchObject({ author: null, thumb: -1, hoppers: [], page: null, transclusions: null, stubOf: null, forkedFrom: null });
    expect(by.get("t1")).toMatchObject({ author: null, thumb: null, hoppers: [], transclusions: null, stubOf: null, forkedFrom: null });
    expect(by.get("gone")).toMatchObject({ withdrawn: true, kind: "thread", version: 3, contentMd: "", contentHtml: "", pinnedVersionRetained: 2 });
    expect(by.get("b9")).toMatchObject({ hoppers: ["irh1"], subscriptionTitle: "Beta" });
    // Owner DTOs carry sanitized HTML, like GET /reading.
    expect(by.get("b9").contentHtml).not.toMatch(/script|onclick/);
  });

  it("joins read state: a read shows its version, a cleared row reads null", async () => {
    expect((await apiJson(cookie, "PUT", "/api/reading/irA/t1/read", { version: 1 })).status).toBe(200);
    expect((await apiJson(cookie, "PUT", "/api/reading/irA/t2/read", { version: 1 })).status).toBe(200);
    expect((await apiJson(cookie, "DELETE", "/api/reading/irA/t2/read")).status).toBe(200);
    const stored = await db().prepare("SELECT read_version, unread_at FROM read_state WHERE subscription_id = 'irA' AND remote_id = 't2'").first<{ read_version: number | null; unread_at: string | null }>();
    expect(stored?.read_version).toBeNull();
    expect(stored?.unread_at).not.toBeNull();
    const { json } = await apiJson(cookie, "GET", "/api/reading/imported?limit=100");
    const by = new Map<string, any>(json.items.map((x: any) => [x.remoteId, x]));
    expect(by.get("t1").readVersion).toBe(1);
    expect(by.get("t2").readVersion).toBeNull();
    expect(by.get("t3").readVersion).toBeNull();
  });

  it("pages stay within the limit and split ties with no drops or repeats", async () => {
    const { seen, sizes } = await walk(cookie, 2);
    expect(new Set(seen).size).toBe(seen.length);
    expect(mine(seen)).toEqual(ORDER);
    expect(sizes.every((n) => n <= 2)).toBe(true);
    expect(sizes.slice(0, 4)).toEqual([2, 2, 2, 2]);
    // An exact final page says so: no cursor to an empty page.
    const last = await apiJson(cookie, "GET", `/api/reading/imported?limit=1&cursor=${encodeReadingCursor({ observedAt: T(1), sub: "irA", remoteId: "a2" })}`);
    expect(last.json.items.map((x: any) => x.remoteId)[0]).toBe("a1");
  });

  it("a poll landing between pages neither shifts nor repeats the walk", async () => {
    await seedSub("irC", "Gamma");
    const before = mine((await walk(cookie, 100)).seen);
    const { seen } = await walk(cookie, 2, async (page) => {
      // A newer poll run, and a row inside the tie the walk is crossing.
      await seedItem("irC", `late${page}`, `2032-01-01T00:00:0${page % 10}.000Z`);
      if (page === 1) await seedItem("irA", "t0", T(3));
    });
    expect(new Set(seen).size).toBe(seen.length);
    // Every row present when the walk began is returned once, in order.
    expect(mine(seen).filter((k) => before.includes(k))).toEqual(before);
    // Rows observed later land ahead of the cursor and are left to the next walk.
    expect(seen.some((k) => k.startsWith("irC/"))).toBe(false);
    await db().prepare("DELETE FROM imported_items WHERE remote_id = 't0' OR subscription_id = 'irC'").run();
  });

  it("refuses a malformed cursor and an out-of-range limit with 400", async () => {
    const forged = [
      "not a cursor!", "garbage", btoa("[1,2,3]"), btoa(JSON.stringify(["a", "b"])), btoa(JSON.stringify(["a", "", "c"])),
      btoa(JSON.stringify({ observedAt: "x", sub: "y", remoteId: "z" })), "A".repeat(3000), "%FF", btoa("\xff\xfe[]"),
    ];
    for (const bad of forged) {
      const r = await apiJson(cookie, "GET", `/api/reading/imported?cursor=${encodeURIComponent(bad)}`);
      expect(r.status, bad.slice(0, 40)).toBe(400);
      expect(r.json.error).toMatch(/cursor/);
    }
    for (const limit of ["0", "-3", "101", "x"]) expect((await apiJson(cookie, "GET", `/api/reading/imported?limit=${limit}`)).status, limit).toBe(400);
  });

  it("defaults to 50 rows and accepts at most 100", async () => {
    await seedSub("irBulk", "Bulk");
    const stmt = db().prepare("INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at) VALUES ('irBulk', ?, 'fragment', 'current', 1, '2030-06-01T00:00:00.000Z')");
    await db().batch(Array.from({ length: 120 }, (_, i) => stmt.bind(`bulk${String(i).padStart(3, "0")}`)));
    const dflt = await apiJson(cookie, "GET", "/api/reading/imported");
    expect(dflt.json.items).toHaveLength(50);
    expect(dflt.json.limit).toBe(50);
    expect(typeof dflt.json.next).toBe("string");
    expect((await apiJson(cookie, "GET", "/api/reading/imported?limit=100")).json.items).toHaveLength(100);
    await db().prepare("DELETE FROM imported_items WHERE subscription_id = 'irBulk'").run();
  });

  it("needs owner:read; reading:state and the write scopes are refused", async () => {
    async function delegated(scope: string[]) {
      const app = new Hono().route("/api", createOwnerApi({ scope, clientId: "imported-reading", userId: "owner" }));
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`${BASE}/api/reading/imported?limit=1`), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    }
    for (const scope of [[], ["reading:state"], ["owner:draft", "owner:publish", "owner:manage", "reading:state"]]) {
      const res = await delegated(scope);
      expect(res.status, scope.join(" ")).toBe(403);
      expect(res.headers.get("www-authenticate")).toContain("insufficient_scope");
    }
    expect((await delegated(["owner:read"])).status).toBe(200);
  });

  it("leaves GET /reading and the read-state routes as they were", async () => {
    const reading = await apiJson(cookie, "GET", "/api/reading?limit=50");
    expect(reading.status).toBe(200);
    expect(reading.json).toHaveProperty("counts");
    // A subscription named "imported" still routes to the read-state write.
    expect((await apiJson(cookie, "PUT", "/api/reading/imported/x/read", { version: 1 })).json).toEqual({ ok: true, stored: false, read_version: null });
  });
});
