import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { contractApp, readJson } from "../src/contract/app.ts";
import { routes } from "../src/contract/routes.ts";
import { itemResource } from "../src/contract/resources.ts";
import { itemShowsResponses, getSettings } from "../src/model.ts";
import { apiJson, BASE, STUDIO, login } from "./helpers.ts";
import { createDraft, publish, getItem } from "../src/model.ts";
import { BlyggerApi, createBlyggerClient } from "../sdk/dist/browser.js";
import { makeApp } from "../src/index.ts";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createSubscription, createHopper, addHopperItem, upsertL0Item } from "../src/importer/store.ts";
import type { Env } from "../src/types.ts";

const request = (cookie: string, path: string) => SELF.fetch(BASE + path, { headers: { cookie } });

describe("external review regressions", () => {
  it("R01 links an empty pinned thread to a live thread snapshot", async () => {
    const cookie = await login();
    const { json: item } = await apiJson(cookie, "POST", "/blyg/api/items", { kind: "thread", content_md: "No quotes" });
    await apiJson(cookie, "POST", `/blyg/api/items/${item.id}/publish`);
    await apiJson(cookie, "PUT", `/blyg/api/items/${item.id}/versions/1/pin`);
    const resource = await apiJson(cookie, 'GET', `/blyg/api/items/${item.id}`);
    expect(resource.json.versions[0]).toMatchObject({ kind: 'thread', pinned: true, transclusions: [] });
    expect((await request(cookie, `/blyg/t/${item.id}/v1/`)).status).toBe(200);
    const listed = await apiJson(cookie, 'GET', '/blyg/api/items');
    expect(listed.json.items.find((row: { id: string }) => row.id === item.id).pins).toEqual([{ version: 1, kind: 'thread' }]);
  });

  it("R02 reads histories larger than the D1 row limit without aggregation", async () => {
    const cookie = await login();
    const draft = await createDraft(env.DB, "History", "thread");
    await publish(env.DB, draft, null, BASE + "/blyg/");
    const content = "x".repeat(60_000);
    await env.DB.batch(Array.from({ length: 24 }, (_, i) => env.DB.prepare("INSERT INTO versions (item_id, version, content_md, content_html, content_hash, published_at, pinned) VALUES (?, ?, ?, ?, 'hash', '2026-09-30T00:00:00Z', 0)").bind(draft.id, i + 2, content, content)));
    expect((await request(cookie, STUDIO)).status).toBe(200);
    const response = await request(cookie, `/blyg/api/items/${draft.id}`);
    expect(response.status).toBe(200);
    expect((await response.json<any>()).versions).toHaveLength(25);
  });

  it("R02 does not inflate a valid large version with SQL JSON escaping", async () => {
    const cookie = await login(), draft = await createDraft(env.DB, "Large version", "thread");
    await publish(env.DB, draft, null, BASE + "/blyg/");
    const quoted = '"'.repeat(600_000);
    await env.DB.prepare("INSERT INTO versions (item_id, version, content_md, content_html, content_hash, published_at, pinned) VALUES (?, 2, ?, ?, 'hash', '2026-09-30T00:00:00Z', 0)").bind(draft.id, quoted, quoted).run();
    const response = await request(cookie, `/blyg/api/items/${draft.id}`);
    expect(response.status).toBe(200);
    expect((await response.json<any>()).versions[1].content_md).toBe(quoted);
  });

  it("R04 pages past both historical mention caps", async () => {
    const cookie = await login();
    await env.DB.batch(Array.from({ length: 205 }, (_, i) => env.DB.prepare("INSERT INTO mentions_in (id, source, source_origin, source_id, source_kind, target, target_item_id, status, first_seen, last_seen, verified_at, hidden) VALUES (?, ?, 'https://source.example/', ?, 'fragment', 'target', 'target-id', 'verified', 'now', 'now', 'now', 0)").bind(`review-in-${i}`, `https://source.example/${i}`, String(i))));
    await env.DB.batch(Array.from({ length: 105 }, (_, i) => env.DB.prepare("INSERT INTO mentions_out (id, item_id, version, target, status, attempts, created) VALUES (?, ?, 1, ?, 'pending', 0, 'now')").bind(`review-out-${i}`, String(i), `https://target.example/${i}`)));
    const inbound = await apiJson(cookie, "GET", "/blyg/api/mentions?direction=inbound&offset=200&limit=10");
    expect(inbound.json.total).toBeGreaterThanOrEqual(205); expect(inbound.json.items.length).toBeGreaterThanOrEqual(5);
    const outbound = await apiJson(cookie, "GET", "/blyg/api/mentions?direction=outbound&offset=100&limit=10");
    expect(outbound.json.total).toBeGreaterThanOrEqual(105); expect(outbound.json.items.length).toBeGreaterThanOrEqual(5);
  });

  it("R05 isolates malformed stored JSON without weakening scalar validation", async () => {
    const cookie = await login(), draft = await createDraft(env.DB, "Readable");
    await env.DB.prepare("UPDATE items SET tk_provenance_json = '{', stub_of = '{', forked_from = '{', fork_cite = '{' WHERE id = ?").bind(draft.id).run();
    const list = await request(cookie, "/blyg/api/items");
    expect(list.status).toBe(200);
    expect((await list.json<any>()).items.find((row: any) => row.id === draft.id)).toMatchObject({ provenance: [], stub_of: null, forked_from: null, fork_cite: null });
    expect((await request(cookie, STUDIO)).status).toBe(200);
    expect((await getItem(env.DB, draft.id))!.tk_provenance_json).toBe("{");
  });

  it("R06 distinguishes assigning a citation from switching a cited draft to fragment", async () => {
    const cookie = await login(), draft = await createDraft(env.DB, "Fragment");
    const result = await apiJson(cookie, "PATCH", `/blyg/api/items/${draft.id}`, { stub_of: { url: "https://example.org/post" } });
    expect(result.status).toBe(400); expect(result.json.error).toBe("only threads can be stubs");
  });

  it("R07/R08 rejects invalid pagination and old write forms by the approved contract", async () => {
    const cookie = await login();
    for (const offset of ["-5", "abc"]) expect((await request(cookie, `/blyg/api/search?offset=${offset}`)).status).toBe(400);
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { accept_mentions: "off" })).status).toBe(400);
    const response = await SELF.fetch(BASE + "/blyg/api/items", { method: "POST", headers: { cookie, "content-type": "text/plain" }, body: "{}" });
    expect(response.status).toBe(415);
  });

  it("R10 preserves response headers and unknown query parameters", async () => {
    let seen = "";
    const client = createBlyggerClient({ baseUrl: BASE + '/blyg/api', fetch: async (input) => {
      seen = input instanceof Request ? input.url : String(input);
      return Response.json({ items: [], total: 0, offset: 0, limit: 100 }, { headers: { "cache-control": "no-store", "x-review": "preserved" } });
    } });
    const { response } = await BlyggerApi.listItems({ client, throwOnError: true, query: { limit: 100, ...{ future: "value" } } });
    expect(new URL(seen).searchParams.get("future")).toBe("value");
    expect(response.headers.get("x-review")).toBe("preserved");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });



  it("R09 preserves provenance extensions and the effective response policy", async () => {
    const row = await createDraft(env.DB, "Resource");
    row.tk_provenance_json = JSON.stringify([{ sources: [], model: "test", extension: { future: true } }]);
    row.show_responses = 1;
    const mapped = itemResource(row);
    expect(mapped.provenance[0]?.extension).toEqual({ future: true });
    const settings = await getSettings(env.DB);
    expect(mapped.responses === "default" ? settings.show_responses_default : mapped.responses === "show").toBe(itemShowsResponses(row, settings));
    expect(() => itemResource({ ...row, id: 42 } as never)).toThrow();
  });

  it("R13 OpenAPI Hono rejects non-JSON without our duplicate gate", async () => {
    const app = contractApp();
    app.openapi({ ...routes.createItem, middleware: undefined }, async (c) => c.json({ validated: await readJson(c) }));
    const response = await app.request("/items", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "Unsupported Media Type" });
  });

  it("R11 loads only three imported bodies for a hopper index preview", async () => {
    const cookie = await login();
    const sub = await createSubscription(env.DB, { kind: "rss", origin: "https://review.example/", feedUrl: "https://review.example/feed", title: "Review" });
    const hopper = await createHopper(env.DB, "Review", "review");
    for (let i = 0; i < 8; i++) {
      await upsertL0Item(env.DB, sub.id, String(i), { version: 1, contentMd: "Preview", contentHash: "hash", observedAt: "2026-09-30T00:00:00Z", contentHtml: "<p>Preview</p>", created: "2026-09-30T00:00:00Z", updated: "2026-09-30T00:00:00Z" });
      await addHopperItem(env.DB, hopper.id, sub.id, String(i));
    }
    let fetched = 0;
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt, { get(statement, method) {
          if (method === "bind") return (...args: Parameters<D1PreparedStatement["bind"]>) => wrap(statement.bind(...args));
          if (method === "all") return async () => { const result = await statement.all(); if (/SELECT ii\.\* FROM hopper_items/i.test(sql)) fetched += result.results.length; return result; };
          const value = Reflect.get(statement, method); return typeof value === "function" ? value.bind(statement) : value;
        } });
        return wrap(target.prepare(sql));
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const ctx = createExecutionContext();
    const response = await makeApp("/blyg").fetch(new Request(BASE + `/blyg/api/hoppers/${hopper.id}?preview=true`, { headers: { cookie } }), { ...env, DB: db } as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const page = await response.json<any>(); expect(page.total).toBe(8); expect(page.items).toHaveLength(3);
    expect(fetched).toBe(3);
  });

  it("R12 returns only the requested signal slice from D1", async () => {
    const cookie = await login();
    const app = makeApp("/blyg");
    let signalsFetched = 0, rowsRead = 0;
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt, { get(statement, method) {
          if (method === "bind") return (...args: Parameters<D1PreparedStatement["bind"]>) => wrap(statement.bind(...args));
          if (method === "all") return async () => { const result = await statement.all(); if (/SELECT \* FROM signals/i.test(sql)) { signalsFetched += result.results.length; rowsRead += result.meta.rows_read; } return result; };
          const value = Reflect.get(statement, method); return typeof value === "function" ? value.bind(statement) : value;
        } });
        return wrap(target.prepare(sql));
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await env.DB.batch(Array.from({ length: 5000 }, (_, i) => env.DB.prepare("INSERT INTO signals (subscription_id, remote_id, thumb, at) VALUES ('review', ?, 1, 'now')").bind(String(i))));
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(BASE + "/blyg/api/signals?offset=100&limit=10", { headers: { cookie } }), { ...env, DB: db } as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200); expect(signalsFetched).toBe(10);
    // The unindexed query scanned at least 5,000 rows for this ten-row page.
    expect(rowsRead).toBeGreaterThan(0);
    expect(rowsRead).toBeLessThanOrEqual(500);
  });
});
