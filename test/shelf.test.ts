// #135: the shelf, an owner-ordered list of own items synced across clients.
// Studio-private: nothing about it reaches the wire. Scopes for getShelf and
// putShelf are covered with every other operation by rest-permissions.oracle
// and mcp.oracle.
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const SHELF = "/blyg/api/shelf";
let cookie: string;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM shelf").run();
  cookie = await login();
});

async function draft(contentMd = "a draft") {
  const created = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd });
  expect(created.status).toBe(201);
  return created.json.id as string;
}
const get = () => apiJson(cookie, "GET", SHELF);
const put = (body: unknown) => apiJson(cookie, "PUT", SHELF, body);
const changes = async () => (await apiJson(cookie, "GET", "/blyg/api/changes")).json.domains as Record<string, number>;

describe("GET/PUT /shelf", () => {
  it("stores the owner's order and replaces the whole list", async () => {
    const a = await createAndPublish(cookie, "now page");
    const b = await draft();
    const c = await createAndPublish(cookie, "reading log");
    const first = await put({ itemIds: [c, a, b] });
    expect(first.status).toBe(200);
    expect(first.json.itemIds).toEqual([c, a, b]);
    expect((await get()).json).toEqual(first.json);

    const second = await put({ itemIds: [b, c] });
    expect(second.json.itemIds).toEqual([b, c]);
    expect(second.json.revision).toBe(first.json.revision + 1);
    expect((await get()).json.itemIds).toEqual([b, c]);

    expect((await put({ itemIds: [] })).json.itemIds).toEqual([]);
  });

  it("accepts drafts, and drops unknown ids and duplicates quietly", async () => {
    const a = await draft();
    const b = await createAndPublish(cookie, "published");
    const res = await put({ itemIds: [a, "no-such-item", b, a] });
    expect(res.status).toBe(200);
    expect(res.json.itemIds).toEqual([a, b]);
  });

  it("omits withdrawn items on GET and drops them on PUT", async () => {
    const a = await createAndPublish(cookie, "will withdraw");
    const b = await createAndPublish(cookie, "stays");
    await put({ itemIds: [a, b] });
    const before = await changes();
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${a}/withdraw`, {})).status).toBe(200);
    expect((await changes()).shelf).toBeGreaterThan(before.shelf);
    expect((await get()).json.itemIds).toEqual([b]);
    expect((await put({ itemIds: [a, b] })).json.itemIds).toEqual([b]);
  });

  it("drops a discarded draft", async () => {
    const a = await draft();
    const b = await draft("another");
    await put({ itemIds: [a, b] });
    const before = await changes();
    expect((await apiJson(cookie, "DELETE", `/blyg/api/items/${a}`)).status).toBe(200);
    expect((await changes()).shelf).toBeGreaterThan(before.shelf);
    expect((await get()).json.itemIds).toEqual([b]);
    expect(await env.DB.prepare("SELECT 1 FROM shelf WHERE item_id = ?").bind(a).first()).toBeNull();
  });

  it("rejects malformed input and lists over the cap", async () => {
    const a = await draft();
    for (const body of [{}, { itemIds: "x" }, { itemIds: [1] }, { itemIds: [""] }, { itemIds: [a], extra: true }, { itemIds: [a], expectedRevision: -1 }]) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.code).toBe("invalid-input");
    }
    const over = await put({ itemIds: Array.from({ length: 51 }, (_, i) => `id-${i}`) });
    expect(over.status).toBe(400);
    expect((await put({ itemIds: Array.from({ length: 50 }, () => a) })).status).toBe(200);
  });

  it("replaces conditionally on expectedRevision and returns the current list on conflict", async () => {
    const a = await draft();
    const b = await draft("b");
    const { revision } = (await get()).json;
    const ok = await put({ itemIds: [a], expectedRevision: revision });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ itemIds: [a], revision: revision + 1 });

    const stale = await put({ itemIds: [b], expectedRevision: revision });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("revision-conflict");
    expect(stale.json.details.current).toEqual({ itemIds: [a], revision: revision + 1 });
    expect((await get()).json.itemIds).toEqual([a]);

    // Without expectedRevision the replace is unconditional, and still bumps.
    const forced = await put({ itemIds: [b] });
    expect(forced.json).toEqual({ itemIds: [b], revision: revision + 2 });
  });

  it("moves the shelf domain, and only the shelf domain, on PUT", async () => {
    const a = await draft();
    const before = await changes();
    await put({ itemIds: [a] });
    const after = await changes();
    for (const [domain, value] of Object.entries(after))
      if (domain === "shelf") expect(value).toBeGreaterThan(before.shelf);
      else expect(value, domain).toBe(before[domain]);
  });

  it("needs the owner", async () => {
    expect((await SELF.fetch("https://example.com/blyg/api/shelf")).status).toBe(401);
    expect((await SELF.fetch("https://example.com/blyg/api/shelf", { method: "PUT", headers: { "content-type": "application/json" }, body: '{"itemIds":[]}' })).status).toBe(401);
  });

  it("never reaches the wire", async () => {
    const id = await createAndPublish(cookie, "a living thread");
    await put({ itemIds: [id] });
    const surfaces = [`/blyg/items/${id}.json`, "/blyg/feed.xml", "/blyg/blyg.json", `/blyg/f/${id}/`, "/blyg/"];
    for (const path of surfaces) {
      const res = await getPublic(path);
      expect(res.status, path).toBe(200);
      expect((await res.text()).toLowerCase(), path).not.toContain("shelf");
    }
  });
});
