// Gate G10's two halves (decision #55, spec §16.1a; studio#12).
//
//   1. A `{url}` stub carries the human half of its citation — frozen when the
//      stub is made (§5.9), so it can say which feed and which entry, not just
//      the host. (The studio has emitted a hostname-only `cited` here since
//      0.4; that was the stale premise of the "not yet built" note.)
//   2. An importer keeps `stub_of` and `forked_from` verbatim, `cited` and all,
//      so a citation survives the trip to another node.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyEffect, createSubscription, getImportedItem, toLocalState, upsertL0Item } from "../src/importer/store.ts";
import { transition } from "../src/importer/transition.ts";
import { apiJson, getPublic, login } from "./helpers.ts";

describe("a {url} stub's citation", () => {
  it("names the feed and the entry, frozen at creation", async () => {
    const cookie = await login();
    const sub = await createSubscription(env.DB, { kind: "rss", origin: "https://simon.example/", feedUrl: "https://simon.example/atom", title: "Simon's Weblog" });
    await upsertL0Item(env.DB, sub.id, "entry1", {
      version: 1, created: "2026-10-01T00:00:00Z", updated: "2026-10-01T00:00:00Z", observedAt: "2026-10-01T00:00:00Z",
      contentMd: "[How to write with an LLM](https://simon.example/2026/how-to-write/)",
      contentHtml: '<p><a href="https://simon.example/2026/how-to-write/">How to write with an LLM</a></p>', contentHash: "h",
    });
    const draft = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "response", source: { subscriptionId: sub.id, remoteId: "entry1" } });
    expect(draft.status).toBe(201);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${draft.json.id}/publish`, {})).status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${draft.json.id}.json`)).json<any>();
    expect(doc.stub_of).toEqual({
      url: "https://simon.example/2026/how-to-write/",
      cited: { source: "Simon's Weblog", excerpt: "How to write with an LLM", url: "https://simon.example/2026/how-to-write/", retrieved: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
    });
  });

  it("an author-set cited is validated: retrieved is required, the caption is clamped", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "Re: that page", kind: "thread" })).json.id as string;
    const missing = await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { stubOf: { url: "https://x.test/p", cited: { source: "X", url: "https://x.test/p" } } });
    expect(missing.status).toBe(400);
    const long = "word ".repeat(80);
    const ok = await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { stubOf: { url: "https://x.test/p", cited: { source: "X", excerpt: long, url: "https://x.test/p", retrieved: "2026-10-03T00:00:00Z" } } });
    expect(ok.status).toBe(200);
    expect(ok.json.stubOf.cited.excerpt.length).toBeLessThanOrEqual(200);
  });
});

describe("the importer keeps lineage (studio#12)", () => {
  const ID = "0000000000000000000000000l";
  const base = { id: ID, kind: "thread", created: "2026-10-01T00:00:00Z", updated: "2026-10-01T00:00:00Z", content_md: "Re", content_html: "<p>Re</p>", content_hash: "h1", author: null, media: [], transclusions: [] };
  const stub = { url: "https://x.test/p", cited: { source: "X", excerpt: "A page", url: "https://x.test/p", retrieved: "2026-10-01T00:00:00Z" } };
  const fork = { origin: "https://y.test/blyg/", id: "0000000000000000000000000f", version: 2, cited: { source: "Y", url: "https://y.test/blyg/f/x/", retrieved: "2026-10-01T00:00:00Z" } };

  it("stores stub_of and forked_from verbatim, updates them, and clears them on withdrawal", async () => {
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: "https://them.example/blyg/", feedUrl: "https://them.example/blyg/feed.xml", title: "Them" });
    const apply = async (doc: object) => {
      const row = await getImportedItem(env.DB, sub.id, ID);
      const t = transition({ local: toLocalState(row), doc, storedContentHash: row?.content_hash ?? undefined });
      await applyEffect(env.DB, sub.id, ID, t.effect, "2026-10-02T00:00:00Z");
      return getImportedItem(env.DB, sub.id, ID);
    };
    let row = await apply({ ...base, version: 1, stub_of: stub, forked_from: fork });
    expect(JSON.parse(row!.stub_of_json!)).toEqual(stub);
    expect(JSON.parse(row!.forked_from_json!)).toEqual(fork);

    row = await apply({ ...base, version: 2, content_hash: "h2", forked_from: fork });
    expect(row!.stub_of_json).toBeNull();
    expect(JSON.parse(row!.forked_from_json!)).toEqual(fork);

    row = await apply({ ...base, kind: "withdrawn", version: 3, content_md: "", content_html: "", content_hash: "" });
    expect(row!.state).toBe("tombstone");
    expect(row!.stub_of_json).toBeNull();
  });
});
