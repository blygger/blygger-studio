// Following a link out of an entry (0.49.0): an item read from its own blyg
// without subscribing, which links name blyg items, and the private browsing
// path. The fetches are fixtures; nothing here goes over the network.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { alternateJsonHref, classifyLinks, peekItem } from "../src/peek.ts";
import { clearBrowse, listBrowse, recordBrowse } from "../src/browse-log.ts";
import { createSubscription } from "../src/importer/store.ts";
import { makeFixtureFetch } from "./importer/fixtures.ts";
import { apiJson, login } from "./helpers.ts";

const O = "https://them.example/blyg/";
const ID = "0000000000000000000000000h";
const doc = (over: Record<string, unknown> = {}) => ({
  body: JSON.stringify({ blyg: "0.4", id: ID, kind: "thread", origin: O, page: `t/${ID}/`, version: 2, content_html: '<p>hi <script>x()</script></p>', stub_of: { origin: O, id: "other", version: 1 }, ...over }),
});
const now = "2026-10-29T12:00:00.000Z";

describe("peek", () => {
  it("reads an item from an origin we do not subscribe to, sanitized, with its page and stub", async () => {
    const { fetch } = makeFixtureFetch({ [`${O}items/${ID}.json`]: doc() });
    const got = await peekItem(env.DB, fetch, O, ID);
    expect(got).toMatchObject({ ok: true, value: { origin: O, id: ID, kind: "thread", version: 2, url: `${O}t/${ID}/`, subscription_id: null, stub_of: { id: "other" } } });
    if (got.ok) expect(got.value.content_html).not.toContain("<script");
  });

  it("names the subscription when the origin is one we hold", async () => {
    const o = "https://held.example/";
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: o, feedUrl: `${o}feed.xml`, title: "Held" });
    const { fetch } = makeFixtureFetch({ [`${o}items/${ID}.json`]: doc({ origin: o }) });
    expect(await peekItem(env.DB, fetch, o, ID)).toMatchObject({ ok: true, value: { subscription_id: sub.id } });
  });

  it("refuses a document for another item, a missing item, and a malformed request", async () => {
    const { fetch } = makeFixtureFetch({ [`${O}items/${ID}.json`]: doc({ id: "x" }) });
    expect(await peekItem(env.DB, fetch, O, ID)).toMatchObject({ ok: false, status: 502 });
    expect(await peekItem(env.DB, fetch, O, "0000000000000000000000000z")).toMatchObject({ ok: false, status: 404 });
    expect(await peekItem(env.DB, fetch, "not a url", ID)).toMatchObject({ ok: false, status: 400 });
    expect(await peekItem(env.DB, fetch, O, "a/b")).toMatchObject({ ok: false, status: 400 });
  });
});

describe("which links name blyg items", () => {
  const page = `<html><head><link rel="alternate" type="application/json" href="${O}items/${ID}.json"></head></html>`;

  it("finds the item document a page points at (§5.8)", () => {
    expect(alternateJsonHref(page, `${O}t/${ID}/`)).toBe(`${O}items/${ID}.json`);
    expect(alternateJsonHref('<link rel="alternate" type="application/rss+xml" href="/f.xml">', O)).toBeNull();
    expect(alternateJsonHref('<link rel="alternate" type="application/json" href="items/a.json">', `${O}t/a/`)).toBe(`${O}t/a/items/a.json`);
  });

  it("probes a page once, caches both answers, and skips what is not http", async () => {
    const linked = `${O}t/${ID}/`, plain = "https://news.example/story";
    const { fetch, calls } = makeFixtureFetch({
      [linked]: { body: page },
      [`${O}items/${ID}.json`]: doc(),
      [plain]: { body: "<html></html>" },
    });
    const urls = [linked, plain, "javascript:alert(1)", linked];
    const first = await classifyLinks(env.DB, fetch, urls, "https://me.example/", now);
    expect(first).toEqual([
      { url: linked, target: { origin: O, id: ID } },
      { url: plain, target: null },
    ]);
    const before = calls.length;
    expect(await classifyLinks(env.DB, fetch, [linked, plain], "https://me.example/", now)).toEqual(first);
    expect(calls.length).toBe(before);
  });

  it("recognises our own pages and a held item's page without fetching", async () => {
    const { fetch, calls } = makeFixtureFetch({});
    const mine = "https://me.example/blyg/";
    expect(await classifyLinks(env.DB, fetch, [`${mine}t/${ID}/`], mine, now)).toEqual([{ url: `${mine}t/${ID}/`, target: { origin: mine, id: ID } }]);
    expect(calls).toEqual([]);
  });

  it("does not trust a document served from somewhere other than the origin it claims", async () => {
    const url = "https://evil.example/p";
    const { fetch } = makeFixtureFetch({
      [url]: { body: `<link rel="alternate" type="application/json" href="https://evil.example/d.json">` },
      "https://evil.example/d.json": doc(),
    });
    expect(await classifyLinks(env.DB, fetch, [url], "https://me.example/", now)).toEqual([{ url, target: null }]);
  });
});

describe("browsing path", () => {
  it("keeps a tree: a step names the step it came from, and a foreign parent is dropped", async () => {
    const a = await recordBrowse(env.DB, { trail: "trail-aaaa-1", origin: O, remoteId: "a", via: "start", at: now, title: "A" });
    const b = await recordBrowse(env.DB, { trail: "trail-aaaa-1", parentId: a, origin: O, remoteId: "b", via: "stub", at: now });
    const c = await recordBrowse(env.DB, { trail: "trail-aaaa-1", parentId: a, origin: O, remoteId: "c", via: "link", at: now });
    const stray = await recordBrowse(env.DB, { trail: "trail-bbbb-2", parentId: a, origin: O, remoteId: "d", via: "start", at: now });
    const { items } = await listBrowse(env.DB, 0, 50, "trail-aaaa-1");
    expect(items.map((r) => [r.id, r.parent_id])).toEqual([[c, a], [b, a], [a, null]]);
    expect((await listBrowse(env.DB, 0, 50, "trail-bbbb-2")).items[0]).toMatchObject({ id: stray, parent_id: null });
    await clearBrowse(env.DB, "trail-aaaa-1");
    expect((await listBrowse(env.DB, 0, 50, "trail-aaaa-1")).total).toBe(0);
    expect((await listBrowse(env.DB, 0, 50, "trail-bbbb-2")).total).toBe(1);
  });

  it("is written and read through /api, for the owner only", async () => {
    const cookie = await login();
    const body = { trail: "trail-cccc-3", origin: O, remoteId: ID, via: "start", version: 2, title: "T" };
    const posted = await apiJson(cookie, "POST", "/blyg/api/browse", body);
    expect(posted.status).toBe(201);
    const listed = await apiJson(cookie, "GET", "/blyg/api/browse?trail=trail-cccc-3");
    expect(listed.json.items).toEqual([expect.objectContaining({ id: posted.json.id, via: "start", title: "T" })]);
    expect((await apiJson(cookie, "POST", "/blyg/api/browse", { ...body, via: "teleport" })).status).toBe(400);
    expect((await apiJson(cookie, "DELETE", "/blyg/api/browse?trail=trail-cccc-3")).status).toBe(200);
  });
});
