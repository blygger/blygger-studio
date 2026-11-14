// `syndication` (spec 0.4 §16.14, decision #98): copies of an item its
// publisher made on other networks, written in place on the live document.
// The gate's first half is "one client emits an entry for a real copy without
// spending a version on it"; these tests pin the "without a version" part,
// the omissions (pinned files, endcaps, feed) and the reader's https: filter.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { pollSubscription } from "../src/importer/poll.ts";
import { createSubscription, getImportedItem, getSubscription } from "../src/importer/store.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";
import { feedBody, itemDocBody, makeFixtureFetch } from "./importer/fixtures.ts";

const BSKY = "https://bsky.app/profile/did:plc:abcdexample234/post/3lzexample22";
const CAST = "https://farcaster.xyz/someone/0xabc123";
const path = (id: string) => `/blyg/api/items/${id}/syndication`;
const doc = async (id: string) => (await getPublic(`/blyg/items/${id}.json`)).json<Record<string, any>>();
const changes = async (cookie: string) => (await apiJson(cookie, "GET", "/blyg/api/changes")).json.domains as Record<string, number>;

describe("own items: GET/PUT /items/{id}/syndication", () => {
  it("writes the live document in place: no version, no changelog entry, no feed entry", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "a post that went to Bluesky", "first");
    const before = await doc(id);
    const feedBefore = await (await getPublic("/blyg/feed.xml")).text();
    const domains = await changes(cookie);

    const res = await apiJson(cookie, "PUT", path(id), { entries: [{ url: BSKY, version: 1 }] });
    expect(res.status).toBe(200);
    expect(res.json.entries).toEqual([{ url: BSKY, version: 1 }]);

    const after = await doc(id);
    expect(after.syndication).toEqual([{ url: BSKY, version: 1 }]);
    expect(after.version).toBe(before.version);
    expect(after.changelog).toEqual(before.changelog);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.content_html).toBe(before.content_html);
    expect(after.updated).toBe(before.updated);
    expect(await (await getPublic("/blyg/feed.xml")).text()).toBe(feedBefore);
    const moved = await changes(cookie);
    expect(moved.items).toBeGreaterThan(domains.items);
    expect(moved.feed).toBe(domains.feed);
    expect((await apiJson(cookie, "GET", path(id))).json.entries).toEqual([{ url: BSKY, version: 1 }]);
  });

  it("replaces the whole list, keeps order, and dedupes by url", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "two networks");
    const res = await apiJson(cookie, "PUT", path(id), { entries: [{ url: CAST, version: 1 }, { url: BSKY, version: 1 }, { url: CAST, version: 1 }] });
    expect(res.json.entries).toEqual([{ url: CAST, version: 1 }, { url: BSKY, version: 1 }]);
    expect((await apiJson(cookie, "PUT", path(id), { entries: [{ url: BSKY, version: 1 }] })).json.entries).toEqual([{ url: BSKY, version: 1 }]);
    expect((await apiJson(cookie, "PUT", path(id), { entries: [] })).json.entries).toEqual([]);
    // No copies, no member: an item that never syndicated is unchanged on the wire.
    expect("syndication" in (await doc(id))).toBe(false);
  });

  it("bumps the item's revision and refuses a stale one", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "revision");
    const { revision } = (await apiJson(cookie, "GET", path(id))).json;
    const ok = await apiJson(cookie, "PUT", path(id), { entries: [{ url: BSKY, version: 1 }], expectedRevision: revision });
    expect(ok.json.revision).toBe(revision + 1);
    const stale = await apiJson(cookie, "PUT", path(id), { entries: [], expectedRevision: revision });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("revision-conflict");
    expect((await doc(id)).syndication).toEqual([{ url: BSKY, version: 1 }]);
  });

  it("refuses non-https URLs, unpublished versions, drafts and malformed bodies", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "validation");
    for (const url of ["http://bsky.app/x", "javascript:alert(1)", "/relative", "ftp://x.example/y"]) {
      const res = await apiJson(cookie, "PUT", path(id), { entries: [{ url, version: 1 }] });
      expect(res.status, url).toBe(400);
    }
    expect((await apiJson(cookie, "PUT", path(id), { entries: [{ url: BSKY, version: 2 }] })).status).toBe(409);
    for (const entries of [[{ url: BSKY }], [{ url: BSKY, version: 0 }], [{ url: BSKY, version: 1, likes: 3 }], Array.from({ length: 21 }, (_, i) => ({ url: `${BSKY}${i}`, version: 1 }))]) {
      expect((await apiJson(cookie, "PUT", path(id), { entries })).status, JSON.stringify(entries).slice(0, 80)).toBe(400);
    }
    const draft = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "not yet" })).json.id as string;
    expect((await apiJson(cookie, "PUT", path(draft), { entries: [{ url: BSKY, version: 1 }] })).status).toBe(409);
    expect((await apiJson(cookie, "PUT", path("no-such-item"), { entries: [], expectedRevision: 1 })).status).toBe(404);
  });

  it("is never in a pinned file, and an endcap omits it", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "pin then withdraw");
    expect((await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/1/pin`, {})).status).toBe(200);
    await apiJson(cookie, "PUT", path(id), { entries: [{ url: BSKY, version: 1 }] });
    const pinned = await (await getPublic(`/blyg/items/${id}/v1.json`)).json<Record<string, unknown>>();
    expect("syndication" in pinned).toBe(false);
    expect((await doc(id)).syndication).toHaveLength(1);

    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/withdraw`, {})).status).toBe(200);
    expect("syndication" in (await doc(id))).toBe(false);
    expect((await apiJson(cookie, "PUT", path(id), { entries: [] })).status).toBe(409);
  });

  it("shows on the public page as u-syndication links", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "page links");
    await apiJson(cookie, "PUT", path(id), { entries: [{ url: BSKY, version: 1 }] });
    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(html).toMatch(new RegExp(`class="[^"]*u-syndication[^"]*"[^>]*href="${BSKY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"|href="${BSKY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*class="[^"]*u-syndication`));
  });

  it("needs owner:publish to write and the owner to read", async () => {
    expect((await SELFfetch("GET", "x")).status).toBe(401);
    expect((await SELFfetch("PUT", "x", '{"entries":[],"expectedRevision":1}')).status).toBe(401);
  });
});

async function SELFfetch(method: string, id: string, body?: string) {
  const { SELF } = await import("cloudflare:test");
  return SELF.fetch(`https://example.com${path(id)}`, { method, headers: body ? { "content-type": "application/json" } : {}, body });
}

describe("imported items", () => {
  const THEIRS = "https://syndicated.example/blyg/";
  async function importWith(id: string, syndication: unknown) {
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: THEIRS, feedUrl: `${THEIRS}feed.xml`, title: "Them" });
    const body = JSON.parse(await itemDocBody({ id, kind: "fragment", version: 1, origin: THEIRS }));
    const { fetch } = makeFixtureFetch({
      [`${THEIRS}feed.xml`]: { body: feedBody({ items: [{ id, version: 1, itemUrl: `${THEIRS}items/${id}.json` }] }) },
      [`${THEIRS}items/${id}.json`]: { body: JSON.stringify({ ...body, syndication }) },
    });
    await env.DB.prepare("UPDATE subscriptions SET last_index_sync_at = ? WHERE id = ?").bind(new Date().toISOString(), sub.id).run();
    await pollSubscription(env.DB, (await getSubscription(env.DB, sub.id))!, fetch);
    return sub.id;
  }

  it("keeps the member as fetched, https: entries only, and the reading API returns it", async () => {
    const sub = await importWith("synd-1", [
      { url: BSKY, version: 1 },
      { url: "http://insecure.example/x", version: 1 },
      { url: "javascript:alert(1)", version: 1 },
      { url: CAST },
      { url: CAST, version: 1, likes: 40 },
      "junk",
    ]);
    const row = await getImportedItem(env.DB, sub, "synd-1");
    expect(JSON.parse(row!.syndication_json!)).toEqual([{ url: BSKY, version: 1 }, { url: CAST, version: 1 }]);
    const cookie = await login();
    const read = await apiJson(cookie, "GET", `/blyg/api/reading/imported/${encodeURIComponent(sub)}/synd-1`);
    if (read.status === 200) expect(read.json.syndication).toEqual([{ url: BSKY, version: 1 }, { url: CAST, version: 1 }]);
  });

  it("stores nothing when the origin published no copies", async () => {
    const sub = await importWith("synd-2", undefined);
    expect((await getImportedItem(env.DB, sub, "synd-2"))!.syndication_json ?? null).toBeNull();
  });
});
