import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BlyggerApi, unwrap, BlyggerApiError, createBlyggerClient } from "../sdk/dist/browser.js";
import { itemDetail } from "../src/item-data.ts";
import { readingData } from "../src/reading-data.ts";
import { routes } from "../src/contract/routes.ts";
import { login, BASE, apiJson } from "./helpers.ts";
import { createSubscription, upsertL0Item } from "../src/importer/store.ts";
import { ReadingEntrySchema } from "../src/contract/routes.ts";

const clientFor = (cookie = "") => createBlyggerClient({ baseUrl: BASE, headers: { cookie }, fetch: (input, init) => SELF.fetch(input instanceof Request ? input : new Request(input, init)) });

describe("generated SDK against the real Worker", () => {
  it("creates, reads, edits, publishes, pins, restores and withdraws through named methods", async () => {
    const client = clientFor(await login());
    const created = await BlyggerApi.createItem({ client, body: { content_md: "SDK draft" }, throwOnError: true });
    expect(created.response.status).toBe(201);
    const id = created.data.id;
    await unwrap(BlyggerApi.updateItem({ client: client, path: { id }, body: { content_md: "SDK saved" } }));
    expect((await unwrap(BlyggerApi.getItem({ client: client, path: { id } }))).content_md).toBe("SDK saved");
    await unwrap(BlyggerApi.publishItem({ client: client, path: { id } }));
    await unwrap(BlyggerApi.pinItem({ client: client, path: { id, version: 1 } }));
    await unwrap(BlyggerApi.updateItem({ client: client, path: { id }, body: { content_md: "changed" } }));
    await unwrap(BlyggerApi.restoreItem({ client: client, path: { id }, body: { version: 1 } }));
    expect((await unwrap(BlyggerApi.getItem({ client: client, path: { id } }))).content_md).toBe("SDK saved");
    await unwrap(BlyggerApi.withdrawItem({ client: client, path: { id } }));
    expect((await unwrap(BlyggerApi.getItem({ client: client, path: { id } }))).status).toBe("withdrawn");
  });
  it("preserves structured validation and authorization failures", async () => {
    await expect(unwrap(BlyggerApi.getSettings({ client: clientFor() }))).rejects.toMatchObject({ statusCode: 401, body: { error: "unauthorized" } });
    await expect(unwrap(BlyggerApi.generateItem({ client: clientFor(await login()), path: { id: "unknown" }, body: { scope: -1 } }))).rejects.toBeInstanceOf(BlyggerApiError);
    const response = await SELF.fetch(`${BASE}/api/items`, { method: "POST", headers: { cookie: await login(), "content-type": "application/json" }, body: '{"content_md":42}' });
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toContain("content_md");
  });
  it("uploads a File and retains its MIME type through the SDK", async () => {
    const cookie = await login(), client = clientFor(cookie);
    const media = await unwrap(BlyggerApi.uploadMedia({ client: client, body: { file: new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" }), alt: "sdk image" } }));
    expect(media.mime).toBe("image/png");
    expect((await SELF.fetch(`${BASE}/blyg/${media.url}`)).status).toBe(404);
    const response = await SELF.fetch(`${BASE}/blyg/${media.url}`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("previews drafts and exposes missing-item errors through named SDK methods", async () => {
    const client = clientFor(await login());
    expect(await unwrap(BlyggerApi.preview({ client, body: { content_md: 'preview', kind: 'thread' } }))).toMatchObject({ html: '<p>preview</p>\n', scopes: [] });
    await expect(unwrap(BlyggerApi.getItem({ client, path: { id: 'no-such-item' } }))).rejects.toMatchObject({ statusCode: 404 });
  });
  it("never retries a write after a lost or failed response", async () => {
    let calls = 0;
    const client = createBlyggerClient({ baseUrl: BASE, fetch: async () => { calls++; return Response.json({ error: "unavailable" }, { status: 502 }); } });
    await expect(unwrap(BlyggerApi.createItem({ client: client }))).rejects.toMatchObject({ statusCode: 502 });
    expect(calls).toBe(1);
  });
  it("does not retry when the Worker commits a creation but its response is lost", async () => {
    const cookie = await login(), ordinary = clientFor(cookie);
    const before = await unwrap(BlyggerApi.listItems({ client: ordinary }));
    let calls = 0, committedId = "";
    const lost = createBlyggerClient({ baseUrl: BASE, headers: { cookie }, fetch: async (input, init) => {
      calls++;
      const response = await SELF.fetch(input instanceof Request ? input : new Request(input, init));
      expect(response.status).toBe(201);
      committedId = (await response.json<{ id: string }>()).id;
      throw new TypeError("Connection lost after commit");
    } });
    await expect(unwrap(BlyggerApi.createItem({ client: lost, body: { content_md: "committed without acknowledgement" } }))).rejects.toThrow("Connection lost after commit");
    expect(calls).toBe(1);
    expect(committedId).not.toBe("");
    expect((await unwrap(BlyggerApi.getItem({ client: ordinary, path: { id: committedId } }))).content_md).toBe("committed without acknowledgement");
    expect((await unwrap(BlyggerApi.listItems({ client: ordinary }))).total).toBe(before.total + 1);
    // A caller retry is a new creation; this test makes no idempotency promise.
  });
  it("matches declared response schemas for private reads and write commands", async () => {
    const cookie = await login();
    const client = clientFor(cookie), draft = await unwrap(BlyggerApi.createItem({ client: client }));
    const hopper = await unwrap(BlyggerApi.createHopper({ client: client, body: { name: "SDK contract" } }));
    const cases: [keyof typeof routes, string, string, unknown?][] = [
      ["listItems", "GET", "/api/items"], ["getItem", "GET", `/api/items/${draft.id}`],
      ["getSettings", "GET", "/api/settings"], ["listSubscriptions", "GET", "/api/subscriptions"],
      ["listHoppers", "GET", "/api/hoppers"], ["getHopper", "GET", `/api/hoppers/${hopper.id}`],
      ["listSignals", "GET", "/api/signals"], ["listMentions", "GET", "/api/mentions"],
      ["listReading", "GET", "/api/reading"], ["preview", "POST", "/api/preview", { content_md: "contract" }],
      ["search", "GET", "/api/search"], ["publishItem", "POST", `/api/items/${draft.id}/publish`, {}],
    ];
    for (const [operation, method, path, body] of cases) {
      const response = await apiJson(cookie, method, path, body);
      const definition = routes[operation].responses[response.status];
      const media = definition && "content" in definition ? definition.content?.["application/json"] : undefined;
      const schema = media && "schema" in media ? media.schema : undefined;
      expect(schema, operation).toBeDefined();
      expect(schema && "safeParse" in schema && schema.safeParse(response.json).success, `${operation}: ${JSON.stringify(response.json)}`).toBe(true);
    }
  });
  it("polling reads see new imports with distinct keys and sanitized HTML", async () => {
    const client = clientFor(await login());
    const initial = await unwrap(BlyggerApi.listReading({ client: client }));
    const subIds: string[] = [];
    for (const origin of ["https://a.example/feed", "https://b.example/feed"]) {
      const sub = await createSubscription(env.DB, { kind: "rss", origin, feedUrl: origin, title: origin });
      subIds.push(sub.id);
      await upsertL0Item(env.DB, sub.id, "same-id", { version: 1, contentMd: "safe", contentHash: "hash", observedAt: "2026-09-30T01:00:00Z", contentHtml: '<p onclick="bad()">safe</p><script>bad()</script>', created: "2026-09-30T00:00:00Z", updated: "2026-09-30T00:00:00Z" });
    }
    const response = await unwrap(BlyggerApi.listReading({ client: client }));
    const imported = response.items.filter((e) => e.imported && subIds.includes(e.imported.subscriptionId));
    expect(imported).toHaveLength(2);
    expect(new Set(imported.map((e) => e.key)).size).toBe(2);
    for (const entry of imported) {
      expect(ReadingEntrySchema.safeParse(entry).success).toBe(true);
      expect(entry.contentHtml).not.toMatch(/onclick|script|bad\(\)/);
    }
    expect(response.counts.all).toBe(initial.counts.all + 2);
  });
  it("returns JSON errors for malformed JSON and unsupported media types", async () => {
    const cookie = await login();
    for (const [type, body, status] of [["application/json", "{", 400], ["text/plain", "hello", 415]] as const) {
      const res = await SELF.fetch(`${BASE}/api/items`, { method: "POST", headers: { cookie, "content-type": type }, body });
      expect(res.status).toBe(status);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ error: expect.any(String) });
    }
  });
  it("keeps empty command bodies compatible with default JSON headers", async () => {
    const cookie = await login();
    const command = (path: string, body?: string) => SELF.fetch(`${BASE}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body });
    const created = await command("/api/items", "");
    expect(created.status).toBe(201);
    const { id } = await created.json<{ id: string }>();
    await unwrap(BlyggerApi.updateItem({ client: clientFor(cookie), path: { id }, body: { content_md: "empty-body commands" } }));
    expect((await command(`/api/items/${id}/publish`)).status).toBe(200);
    expect((await command(`/api/items/${id}/withdraw`, "")).status).toBe(200);
    expect((await command("/api/items", "{")).status).toBe(400);
  });
  it("documents the upload file as required and rejects missing or non-file values", async () => {
    const cookie = await login();
    const spec = await (await SELF.fetch(`${BASE}/api/openapi.json`, { headers: { cookie } })).json<any>();
    expect(spec.paths["/api/media"].post.requestBody.content["multipart/form-data"].schema.required).toContain("file");
    for (const field of [null, "not a file"]) {
      const body = new FormData();
      if (field) body.set("file", field);
      const res = await SELF.fetch(`${BASE}/api/media`, { method: "POST", headers: { cookie }, body });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.any(String) });
    }
  });
  // Asserts a query count, not a speed: it seeds a full page first, which took
  // 5.05 s on a slow CI runner against the 5 s default (run 38097466156).
  it("loads a full own reading page within the Free-plan D1 query budget", async () => {
    const client = clientFor(await login());
    const ids: string[] = [];
    for (let i = 0; i < 26; i++) {
      const item = await unwrap(BlyggerApi.createItem({ client: client, body: { content_md: `budget ${i}` } }));
      await unwrap(BlyggerApi.publishItem({ client: client, path: { id: item.id } }));
      ids.push(item.id);
    }
    let queries = 0;
    const counted = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const page = await readingData(counted, 0, 25, "own");
    expect(page.items.map((row) => row.own?.id)).toEqual(ids.slice(1).reverse());
    expect(page.items[0].contentHtml).toContain("budget 25");
    // Leave room for the SSR page's settings, hoppers and signals reads.
    expect(queries).toBeLessThanOrEqual(5);
    queries = 0;
    for (const id of ids) {
      const detail = await itemDetail(counted, id);
      expect(detail?.versions.map((v) => v.version)).toEqual([1]);
      expect(detail?.published?.content_md).toMatch(/^budget /);
      expect(detail?.media).toEqual([]);
    }
    expect(queries).toBeLessThanOrEqual(ids.length);
  }, 30_000);

});
