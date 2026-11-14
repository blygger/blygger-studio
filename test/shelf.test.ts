// #135: the shelf, an owner-ordered list of { sub, remoteId } entries (own
// items under "~own", imported items under their subscription), synced across clients.
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

const SUB = "shelf-sub";
async function importedFixture() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM imported_items WHERE subscription_id = ?").bind(SUB),
    env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(SUB),
    env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES (?,'blyg','https://shelf.example/','https://shelf.example/feed.xml','Shelf source','2026-11-13')").bind(SUB),
    ...[["r1", "current", null], ["r2", "current", null], ["gone", "tombstone", null], ["kept", "tombstone", 1]].map(([id, state, pin]) =>
      env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_md,content_html,pinned_version_retained) VALUES (?,?,'fragment',?,1,'2026-11-13','text','<p>text</p>',?)").bind(SUB, id, state, pin)),
  ]);
}

async function draft(contentMd = "a draft") {
  const created = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd });
  expect(created.status).toBe(201);
  return created.json.id as string;
}
const get = () => apiJson(cookie, "GET", SHELF);
const raw = (body: unknown) => apiJson(cookie, "PUT", SHELF, body);
// Every client reads before it writes (expectedRevision is required); so do these tests.
const put = async (body: { entries: unknown; expectedRevision?: number; [key: string]: unknown }) =>
  raw("expectedRevision" in body ? body : { ...body, expectedRevision: (await get()).json.revision });
const own = (ids: string[]) => ids.map(remoteId => ({ sub: "~own", remoteId }));
const changes = async () => (await apiJson(cookie, "GET", "/blyg/api/changes")).json.domains as Record<string, number>;

describe("GET/PUT /shelf", () => {
  it("stores the owner's order and replaces the whole list", async () => {
    const a = await createAndPublish(cookie, "now page");
    const b = await draft();
    const c = await createAndPublish(cookie, "reading log");
    const first = await put({ entries: own([c, a, b]) });
    expect(first.status).toBe(200);
    expect(first.json.entries).toEqual(own([c, a, b]));
    expect((await get()).json).toEqual(first.json);

    const second = await put({ entries: own([b, c]) });
    expect(second.json.entries).toEqual(own([b, c]));
    expect(second.json.revision).toBe(first.json.revision + 1);
    expect((await get()).json.entries).toEqual(own([b, c]));

    expect((await put({ entries: own([]) })).json.entries).toEqual(own([]));
  });

  it("accepts drafts, and drops unknown ids and duplicates quietly", async () => {
    const a = await draft();
    const b = await createAndPublish(cookie, "published");
    const res = await put({ entries: own([a, "no-such-item", b, a]) });
    expect(res.status).toBe(200);
    expect(res.json.entries).toEqual(own([a, b]));
  });

  it("omits withdrawn items on GET and drops them on PUT", async () => {
    const a = await createAndPublish(cookie, "will withdraw");
    const b = await createAndPublish(cookie, "stays");
    await put({ entries: own([a, b]) });
    const before = await changes();
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${a}/withdraw`, {})).status).toBe(200);
    expect((await changes()).shelf).toBeGreaterThan(before.shelf);
    expect((await get()).json.entries).toEqual(own([b]));
    expect((await put({ entries: own([a, b]) })).json.entries).toEqual(own([b]));
  });

  it("drops a discarded draft", async () => {
    const a = await draft();
    const b = await draft("another");
    await put({ entries: own([a, b]) });
    const before = await changes();
    expect((await apiJson(cookie, "DELETE", `/blyg/api/items/${a}`)).status).toBe(200);
    expect((await changes()).shelf).toBeGreaterThan(before.shelf);
    expect((await get()).json.entries).toEqual(own([b]));
    expect(await env.DB.prepare("SELECT 1 FROM shelf WHERE subscription_id = '~own' AND remote_id = ?").bind(a).first()).toBeNull();
  });

  it("rejects malformed input and lists over the cap", async () => {
    const a = await draft();
    for (const body of [{}, { entries: "x" }, { entries: [1] }, { entries: [a] }, { entries: [{ sub: "~own" }] }, { entries: [{ sub: "", remoteId: a }] }, { entries: [{ sub: "~own", remoteId: "" }] }, { entries: [{ sub: "~own", remoteId: a, extra: 1 }] }, { itemIds: [a], expectedRevision: 0 }, { entries: own([a]), extra: true }, { entries: own([a]), expectedRevision: -1 }, { entries: own([a]) }]) {
      const res = await raw(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.code).toBe("invalid-input");
    }
    const over = await put({ entries: own(Array.from({ length: 51 }, (_, i) => `id-${i}`)) });
    expect(over.status).toBe(400);
    expect((await put({ entries: own(Array.from({ length: 50 }, () => a)) })).status).toBe(200);
  });

  it("replaces conditionally on expectedRevision and returns the current list on conflict", async () => {
    const a = await draft();
    const b = await draft("b");
    const { revision } = (await get()).json;
    const ok = await put({ entries: own([a]), expectedRevision: revision });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ entries: own([a]), revision: revision + 1 });

    const stale = await put({ entries: own([b]), expectedRevision: revision });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("revision-conflict");
    expect(stale.json.details.current).toEqual({ entries: own([a]), revision: revision + 1 });
    expect((await get()).json.entries).toEqual(own([a]));

    // There is no unconditional replace (#137): omitting the revision is a 400.
    expect((await raw({ entries: own([b]) })).status).toBe(400);
    expect((await get()).json).toEqual({ entries: own([a]), revision: revision + 1 });
  });

  it("holds imported items by subscription, beside own items", async () => {
    const mine = await draft();
    await importedFixture();
    const res = await put({ entries: [{ sub: SUB, remoteId: "r1" }, ...own([mine]), { sub: SUB, remoteId: "r2" }] });
    expect(res.status).toBe(200);
    expect(res.json.entries).toEqual([{ sub: SUB, remoteId: "r1" }, ...own([mine]), { sub: SUB, remoteId: "r2" }]);
    // A bare remote id names nothing: the same id under "~own" is not the imported item.
    expect((await put({ entries: own(["r1"]) })).json.entries).toEqual([]);
  });

  it("drops unknown subscriptions, items not held and tombstones quietly", async () => {
    await importedFixture();
    const res = await put({ entries: [
      { sub: "no-such-sub", remoteId: "r1" },
      { sub: SUB, remoteId: "not-held" },
      { sub: SUB, remoteId: "gone" },
      { sub: SUB, remoteId: "kept" },
      { sub: SUB, remoteId: "r1" },
      { sub: SUB, remoteId: "r1" },
    ] });
    expect(res.status).toBe(200);
    expect(res.json.entries).toEqual([{ sub: SUB, remoteId: "kept" }, { sub: SUB, remoteId: "r1" }]);
  });

  it("omits an imported item that becomes a tombstone, and moves the domain", async () => {
    await importedFixture();
    await put({ entries: [{ sub: SUB, remoteId: "r1" }, { sub: SUB, remoteId: "r2" }] });
    const before = await changes();
    await env.DB.prepare("UPDATE imported_items SET state = 'tombstone' WHERE subscription_id = ? AND remote_id = 'r1'").bind(SUB).run();
    expect((await changes()).shelf).toBeGreaterThan(before.shelf);
    expect((await get()).json.entries).toEqual([{ sub: SUB, remoteId: "r2" }]);
  });

  it("unsubscribing takes that subscription's entries off the shelf", async () => {
    const mine = await draft();
    await importedFixture();
    await put({ entries: [{ sub: SUB, remoteId: "r1" }, ...own([mine])] });
    const before = await changes();
    expect((await apiJson(cookie, "DELETE", `/blyg/api/subscriptions/${SUB}`)).status).toBe(200);
    expect((await changes()).shelf).toBeGreaterThan(before.shelf);
    expect((await get()).json.entries).toEqual(own([mine]));
    expect(await env.DB.prepare("SELECT 1 FROM shelf WHERE subscription_id = ?").bind(SUB).first()).toBeNull();
  });

  it("moves the shelf domain, and only the shelf domain, on PUT", async () => {
    const a = await draft();
    const before = await changes();
    await put({ entries: own([a]) });
    const after = await changes();
    for (const [domain, value] of Object.entries(after))
      if (domain === "shelf") expect(value).toBeGreaterThan(before.shelf);
      else expect(value, domain).toBe(before[domain]);
  });

  it("needs the owner", async () => {
    expect((await SELF.fetch("https://example.com/blyg/api/shelf")).status).toBe(401);
    expect((await SELF.fetch("https://example.com/blyg/api/shelf", { method: "PUT", headers: { "content-type": "application/json" }, body: '{"entries":[],"expectedRevision":0}' })).status).toBe(401);
  });

  it("never reaches the wire", async () => {
    const id = await createAndPublish(cookie, "a living thread");
    await put({ entries: own([id]) });
    const surfaces = [`/blyg/items/${id}.json`, "/blyg/feed.xml", "/blyg/blyg.json", `/blyg/f/${id}/`, "/blyg/"];
    for (const path of surfaces) {
      const res = await getPublic(path);
      expect(res.status, path).toBe(200);
      expect((await res.text()).toLowerCase(), path).not.toContain("shelf");
    }
  });
});
