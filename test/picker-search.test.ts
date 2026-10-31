// The picker's search (0.29): every word anywhere in an item's text, a source
// filter (mine / imported / one subscription), newest or oldest first, and a
// total that counts the whole filtered set. Unique nonsense words keep these
// assertions independent of whatever else the shared fixture holds.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { apiJson, createAndPublish, login } from "./helpers.ts";

let cookie = "";
let mine = "";
const search = async (query: string) => (await apiJson(cookie, "GET", `/blyg/api/search?${query}`)).json as { items: { id: string; source: string; kind: string; source_title: string | null; subscription_id: string | null; excerpt: string }[]; total: number };

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
    expect(r.total).toBe(3);
  });

  it("needs every word, in any order, case-insensitively", async () => {
    const r = await search("q=" + encodeURIComponent("QUINTESSENCE Zorbleflux"));
    expect(r.items.map((i) => i.id).sort()).toEqual([mine, "pickbnew00000000000000000b"].sort());
  });

  it("filters by source and by one subscription, labelling each row", async () => {
    expect((await search("q=zorbleflux&source=mine")).items).toEqual([expect.objectContaining({ id: mine, source: "mine", source_title: null, subscription_id: null })]);
    const imported = await search("q=zorbleflux&source=imported");
    expect(imported.items.map((i) => i.source)).toEqual(["imported", "imported"]);
    // A subscription with no title is named by its host.
    expect(imported.items.find((i) => i.subscription_id === "pick-b")?.source_title).toBe("b.example");
    const one = await search("q=zorbleflux&sub=pick-a");
    expect(one.items).toEqual([expect.objectContaining({ id: "pickaold00000000000000000a", kind: "thread", source_title: "Alpha Blyg" })]);
  });

  it("sorts newest or oldest first, and pages with a total of the whole set", async () => {
    const newest = await search("q=zorbleflux&source=imported");
    expect(newest.items.map((i) => i.id)).toEqual(["pickbnew00000000000000000b", "pickaold00000000000000000a"]);
    const oldest = await search("q=zorbleflux&source=imported&sort=oldest");
    expect(oldest.items.map((i) => i.id)).toEqual(["pickaold00000000000000000a", "pickbnew00000000000000000b"]);
    const page = await search("q=zorbleflux&limit=1&offset=1&sort=oldest&source=imported");
    expect(page).toMatchObject({ total: 2, items: [{ id: "pickbnew00000000000000000b" }] });
  });

  it("treats LIKE wildcards in the query as literal text", async () => {
    expect((await search("q=" + encodeURIComponent("zorble%flux"))).total).toBe(0);
    expect((await search("q=_orbleflux")).total).toBe(0);
  });
});
