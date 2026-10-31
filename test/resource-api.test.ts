import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ownerApi } from "../src/owner-api.ts";
import { getItem, publish } from "../src/model.ts";
import { BlyggerApi, createBlyggerClient, unwrap } from "../sdk/dist/browser.js";
import { routes } from "../src/contract/routes.ts";
import { createSubscription } from "../src/importer/store.ts";
import { apiJson, BASE, login } from "./helpers.ts";
import type { Env } from "../src/types.ts";

const clientFor = (cookie: string) => createBlyggerClient({ baseUrl: BASE + '/blyg/api', headers: { cookie }, fetch: (input, init) => SELF_FETCH(input, init) });
import { SELF } from "cloudflare:test";
const SELF_FETCH = (input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input instanceof Request ? input : new Request(input, init));

describe("resource API contract", () => {
  it("creates each recipe through the same SDK method and retains fork lineage", async () => {
    const client = clientFor(await login());
    const blank = await BlyggerApi.createItem({ client, body: { mode: "blank", content_md: "original" } });
    expect(blank.response!.headers.get("location")).toBe(`/blyg/api/items/${blank.data!.id}`);
    const id = blank.data!.id;
    await unwrap(BlyggerApi.publishItem({ client, path: { id } }));
    await unwrap(BlyggerApi.pinItem({ client, path: { id, version: 1 } }));
    const fork = await unwrap(BlyggerApi.createItem({ client, body: { mode: "fork", source: { origin: BASE + "/blyg/", id, version: 1 } } }));
    expect(fork).toMatchObject({ content_md: "original", dirty: true, responses: "default", forked_from: { id, version: 1 } });
    expect(fork).not.toHaveProperty("tk_provenance_json");
    const invalid = await BlyggerApi.updateItem({ client, path: { id: fork.id }, body: { forked_from: null } as never });
    expect(invalid.response!.status).toBe(400);
    expect((await unwrap(BlyggerApi.getItem({ client, path: { id: fork.id } }))).forked_from).toEqual(fork.forked_from);
  });

  it("does not apply valid fields when another requested change fails", async () => {
    const cookie = await login();
    const draft = await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "keep me" });
    const id = draft.json.id;
    const invalid = await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { kind: "thread", content_md: "discard this", stub_of: { url: "bad URL" } });
    expect(invalid.status).toBe(400);
    expect((await getItem(env.DB, id))).toMatchObject({ kind: "fragment", content_md: "keep me", stub_of: null });
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`);
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { kind: "thread", content_md: "discard this", responses: "hide" })).status).toBe(409);
    expect((await getItem(env.DB, id))).toMatchObject({ kind: "fragment", content_md: "keep me", responses_override: null });
  });

  it("clears a citation and changes draft kind together without publishing", async () => {
    const cookie = await login();
    const draft = await apiJson(cookie, "POST", "/blyg/api/items", { kind: "thread", content_md: "keep text", stub_of: { url: "https://example.org/post" } });
    const result = await apiJson(cookie, "PATCH", `/blyg/api/items/${draft.json.id}`, { stub_of: null, kind: "fragment", responses: "hide" });
    expect(result.json).toMatchObject({ kind: "fragment", content_md: "keep text", stub_of: null, version: 0, responses: "hide" });
  });

  it("guards a draft-kind edit against a concurrent first publication", async () => {
    const cookie = await login();
    const { json: draft } = await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "original" });
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!sql.startsWith("UPDATE items SET")) return stmt;
        return { bind: (...args: Parameters<D1PreparedStatement["bind"]>) => {
          const bound = stmt.bind(...args);
          return { first: async () => {
            await publish(env.DB, (await getItem(env.DB, draft.id))!, null, BASE + "/blyg/");
            return bound.first();
          } };
        } } as D1PreparedStatement;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const ctx = createExecutionContext();
    const response = await ownerApi.fetch(new Request(`${BASE}/items/${draft.id}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ kind: "thread", content_md: "must not apply" }) }), { ...env, DB: db } as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(409);
    expect(await getItem(env.DB, draft.id)).toMatchObject({ kind: "fragment", content_md: "original", version: 1 });
  });

  it("patches subscription preferences together and keeps transport cache fields private", async () => {
    const cookie = await login();
    const sub = await createSubscription(env.DB, { kind: "rss", origin: "https://source.example/", feedUrl: "https://source.example/feed", title: "Before" });
    const result = await apiJson(cookie, "PATCH", `/blyg/api/subscriptions/${sub.id}`, { title: "After", paused: true, in_blogroll: true });
    expect(result.json).toMatchObject({ title: "After", status: "paused", in_blogroll: true, flags: [] });
    expect(result.json).not.toHaveProperty("etag");
    expect((await apiJson(cookie, "PATCH", `/blyg/api/subscriptions/${sub.id}`, { title: "Bad", paused: false, in_blogroll: "yes" })).status).toBe(400);
    expect((await apiJson(cookie, "GET", `/blyg/api/subscriptions/${sub.id}`)).json).toMatchObject({ title: "After", status: "paused" });
  });

  it("paginates collections consistently and rejects invalid pagination", async () => {
    const cookie = await login(), client = clientFor(cookie);
    for (const name of ["one", "two", "three"]) await unwrap(BlyggerApi.createHopper({ client, body: { name } }));
    const first = await unwrap(BlyggerApi.listHoppers({ client, query: { offset: 0, limit: 2 } }));
    const second = await unwrap(BlyggerApi.listHoppers({ client, query: { offset: 2, limit: 2 } }));
    expect(first.items).toHaveLength(2); expect(second.items).toHaveLength(1);
    expect(first.total).toBe(3); expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    expect((await apiJson(cookie, "GET", "/blyg/api/reading?limit=51")).status).toBe(400);
    expect((await apiJson(cookie, "GET", "/blyg/api/search?offset=abc")).status).toBe(400);
    expect(await unwrap(BlyggerApi.listReading({ client }))).toMatchObject({ items: expect.any(Array), offset: 0, limit: 25 });
  });

  it("removes old write routes and returns documented JSON for wrong methods", async () => {
    const cookie = await login();
    for (const path of ["/blyg/api/fork", "/blyg/api/stubs", "/blyg/api/items/old/responses", "/blyg/api/subscriptions/old/pause", "/blyg/api/subscriptions/old/resume", "/blyg/api/mentions/old/hidden", "/blyg/api/items/old/pin"]) {
      const response = await SELF.fetch(BASE + path, { method: "POST", headers: { cookie } });
      expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: "not found" });
    }
    const oldPut = await SELF.fetch(BASE + "/blyg/api/items/old", { method: "PUT", headers: { cookie } });
    expect(oldPut.status).toBe(405); expect(oldPut.headers.get("allow")).toContain("PATCH");
    expect(Object.values(routes).some((route) => String(route.path) === "/commands")).toBe(false);
  });
});
