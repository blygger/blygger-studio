// Per-hopper feeds (proposed, pending Fable: blygger-spec protocol-v0.4.md
// §6.1 `hoppers`, §13.5a), behind the `hopper_feeds` setting, off by default.

import { SELF, env } from "cloudflare:test";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { afterEach, describe, expect, it } from "vitest";
import { createSubscription } from "../src/importer/store.ts";
import { hopperGuid } from "../src/hopper-feed-shape.ts";
import { BASE, apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const ORIGIN = "https://a.example/blyg/";
const LONG_TAIL = "SNAPSHOT-TAIL-NEVER-IN-FEED";
const LONG_BODY = `${"Words that carry the curated argument forward. ".repeat(12)}${LONG_TAIL}`;

type Item = { guid: { "#text": string; "@_isPermaLink": string }; link: string; title: string; description: string; pubDate: string; "dc:creator"?: string; source?: { "#text": string; "@_url": string } };
const parse = (xml: string) =>
  new XMLParser({ ignoreAttributes: false, isArray: (name) => name === "item" }).parse(xml) as {
    rss: { channel: { title: string; link: string; description: string; "atom:link": { "@_href": string }; item?: Item[] } };
  };

let counter = 0;

async function setFeeds(on: boolean) {
  expect((await apiJson(await login(), "PATCH", "/api/settings", { hopper_feeds: on })).status).toBe(200);
}

afterEach(async () => {
  await setFeeds(false);
});

async function publicHopper(cookie: string, name: string, description?: string) {
  const hopper = (await apiJson(cookie, "POST", "/api/hoppers", { name })).json as { id: string };
  expect((await apiJson(cookie, "PATCH", `/api/hoppers/${hopper.id}`, { public: true, ...(description ? { description } : {}) })).status).toBe(200);
  return (await apiJson(cookie, "GET", `/api/hoppers/${hopper.id}`)).json.hopper as { id: string; slug: string; name: string };
}

async function importRow(subId: string, remoteId: string, opts: { html: string; page?: string; author?: string; l0?: boolean; state?: "current" | "tombstone"; pinned?: number | null }) {
  await env.DB.prepare(
    `INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, created, updated, observed_at, content_md, content_html, author_json, l0, pinned_version_retained, page)
     VALUES (?, ?, 'fragment', ?, 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '', ?, ?, ?, ?, ?)`,
  )
    .bind(subId, remoteId, opts.state ?? "current", opts.html, opts.author ? JSON.stringify({ name: opts.author }) : null, opts.l0 ? 1 : 0, opts.pinned ?? null, opts.page ?? null)
    .run();
}

async function member(hopperId: string, subId: string, remoteId: string, addedAt: string) {
  await env.DB.prepare("INSERT INTO hopper_items (hopper_id, subscription_id, remote_id, added_at) VALUES (?, ?, ?, ?)").bind(hopperId, subId, remoteId, addedAt).run();
}

/** A public hopper holding: a titled imported item with a page, one without, an L0 entry, two tombstones (one pinned) and an own item. */
async function seed() {
  const n = counter++;
  const cookie = await login();
  const hopper = await publicHopper(cookie, `Curated ${n}`);
  const sub = await createSubscription(env.DB, { kind: "blyg", origin: ORIGIN, feedUrl: `${ORIGIN}feed.xml`, title: "A Blyg" });
  const rss = await createSubscription(env.DB, { kind: "rss", origin: "https://l0.example/", feedUrl: "https://l0.example/rss", title: "Plain Feed" });
  const ids = { paged: `paged-${n}`, bare: `bare-${n}`, l0: `l0-${n}`, gone: `gone-${n}`, kept: `kept-${n}` };
  await importRow(sub.id, ids.paged, { html: `<h1>Heading One</h1><p>${LONG_BODY}</p>`, page: "posts/one/", author: "Ann Author" });
  await importRow(sub.id, ids.bare, { html: "<p>No page declared here.</p>" });
  await importRow(rss.id, ids.l0, { html: '<p><a href="https://l0.example/post">L0 Title</a></p><p>legacy text</p>', l0: true });
  await importRow(sub.id, ids.gone, { html: "", state: "tombstone", pinned: null });
  await importRow(sub.id, ids.kept, { html: "<p>Retained by a pin.</p>", state: "tombstone", pinned: 1 });
  const own = await createAndPublish(cookie, `# My own post\n\nOwn words ${n}.`);
  await member(hopper.id, sub.id, ids.paged, "2026-09-05T00:00:00.000Z");
  await member(hopper.id, sub.id, ids.bare, "2026-09-04T00:00:00.000Z");
  await member(hopper.id, rss.id, ids.l0, "2026-09-03T00:00:00.000Z");
  await member(hopper.id, sub.id, ids.gone, "2026-09-02T00:00:00.000Z");
  await member(hopper.id, sub.id, ids.kept, "2026-09-01T00:00:00.000Z");
  await member(hopper.id, "~own", own, "2026-09-06T00:00:00.000Z");
  return { cookie, hopper, sub, rss, ids, own };
}

const feedPath = (slug: string) => `/blyg/h/${slug}/feed.xml`;

describe("hopper feeds, off (the default)", () => {
  it("404 the feed, add no links to the page and no hoppers key to the manifest", async () => {
    const { hopper } = await seed();
    const res = await getPublic(feedPath(hopper.slug));
    expect(res.status).toBe(404);
    const page = await (await getPublic(`/blyg/h/${hopper.slug}/`)).text();
    expect(page).not.toContain("feed.xml\" class");
    expect(page).not.toContain(`h/${hopper.slug}/feed.xml`);
    expect(page).not.toContain('rel="blyg"');
    expect(page).toContain(`<link rel="alternate" type="application/rss+xml" title="`);
    expect(page).toContain(`href="https://example.com/blyg/feed.xml"`);
    const settings = (await apiJson(await login(), "GET", "/api/settings")).json as { hopper_feeds: boolean };
    expect(settings.hopper_feeds).toBe(false);
  });
});

describe("hopper feeds, on", () => {
  it("serve valid RSS: the hopper's channel, curation entries, newest-added first", async () => {
    const { hopper, sub, rss, ids, own } = await seed();
    await setFeeds(true);
    const res = await getPublic(feedPath(hopper.slug));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    const xml = await res.text();
    expect(XMLValidator.validate(xml)).toBe(true);
    const { channel } = parse(xml).rss;
    expect(channel.title).toMatch(new RegExp(`^${hopper.name} — `));
    expect(channel.link).toBe(`${BASE}/blyg/h/${hopper.slug}/`);
    expect(channel["atom:link"]["@_href"]).toBe(`${BASE}/blyg/h/${hopper.slug}/feed.xml`);
    expect(channel.description).toMatch(/^A collection on /);

    // §13.5a rule 2: no blyg: namespace anywhere, own items included.
    expect(xml).not.toMatch(/<\/?blyg:/);
    expect(xml).not.toContain("xmlns:blyg");

    const items = channel.item!;
    // The unpinned tombstone has rolled to null; the pinned one stays.
    expect(items.map((i) => i.guid["#text"])).toEqual([
      hopperGuid(hopper.slug, `${BASE}/blyg/`, own),
      hopperGuid(hopper.slug, ORIGIN, ids.paged),
      hopperGuid(hopper.slug, ORIGIN, ids.bare),
      hopperGuid(hopper.slug, rss.origin, ids.l0),
      hopperGuid(hopper.slug, ORIGIN, ids.kept),
    ]);
    for (const i of items) expect(i.guid["@_isPermaLink"]).toBe("false");
    expect(items.map((i) => new Date(i.pubDate).toISOString())).toEqual([
      "2026-09-06T00:00:00.000Z", "2026-09-05T00:00:00.000Z", "2026-09-04T00:00:00.000Z", "2026-09-03T00:00:00.000Z", "2026-09-01T00:00:00.000Z",
    ]);

    const [ownEntry, paged, bare, l0] = items;
    // Imported entries link to the origin: the declared page, else the item document. Never to us.
    expect(paged.link).toBe(`${ORIGIN}posts/one/`);
    expect(bare.link).toBe(`${ORIGIN}items/${ids.bare}.json`);
    expect(l0.link).toBe("https://l0.example/post");
    for (const i of items.slice(1)) expect(i.link.startsWith(`${BASE}/`)).toBe(false);
    expect(xml).not.toMatch(/a\.example\/blyg\/[ft]\//);
    // Own entries link to our own page, carry no <source>.
    expect(ownEntry.link).toBe(`${BASE}/blyg/f/${own}/`);
    expect(ownEntry.source).toBeUndefined();
    expect(ownEntry.title).toBe("My own post");

    // Attribution.
    expect(paged.title).toBe("Heading One");
    expect(paged["dc:creator"]).toBe("Ann Author");
    expect(paged.source).toEqual({ "#text": "A Blyg", "@_url": sub.feed_url });
    expect(bare["dc:creator"]).toBeUndefined();
    expect(l0.title).toBe("L0 Title");
    expect(l0.source?.["@_url"]).toBe("https://l0.example/rss");

    // An excerpt, never the held snapshot, plus the via line.
    expect(paged.description).toContain("Words that carry the curated argument forward.");
    expect(paged.description).not.toContain(LONG_TAIL);
    expect(xml).not.toContain(LONG_TAIL);
    expect(paged.description).toContain(`via <a href="${BASE}/blyg/h/${hopper.slug}/">${hopper.name}</a> on `);
  });

  it("keep guids stable across renders and membership changes", async () => {
    const { cookie, hopper, sub, ids } = await seed();
    await setFeeds(true);
    const guids = async () => parse(await (await getPublic(feedPath(hopper.slug))).text()).rss.channel.item!.map((i) => i.guid["#text"]);
    const first = await guids();
    expect(await guids()).toEqual(first);
    // Removing a member drops just its entry (§13.5a rule 3).
    expect((await apiJson(cookie, "DELETE", `/api/hoppers/${hopper.id}/items/${sub.id}/${ids.bare}`)).status).toBe(200);
    expect(await guids()).toEqual(first.filter((g) => g !== hopperGuid(hopper.slug, ORIGIN, ids.bare)));
  });

  it("advertise the feed on the hopper page, with an RSS link and rel=blyg", async () => {
    const { hopper } = await seed();
    await setFeeds(true);
    const page = await (await getPublic(`/blyg/h/${hopper.slug}/`)).text();
    const feed = `${BASE}/blyg/h/${hopper.slug}/feed.xml`;
    expect(page).toContain(`<link rel="alternate" type="application/rss+xml" title="${hopper.name} — `);
    expect(page).toContain(`href="${feed}">`);
    expect(page).toContain(`<a class="collection-feed" href="${feed}">RSS</a>`);
    expect(page).toContain(`<link rel="blyg" href="${BASE}/blyg/blyg.json">`);
  });

  it("404 for a private or unknown hopper, leaking nothing", async () => {
    const cookie = await login();
    await setFeeds(true);
    const hopper = (await apiJson(cookie, "POST", "/api/hoppers", { name: `Private ${counter++}` })).json as { id: string };
    const slug = ((await apiJson(cookie, "GET", `/api/hoppers/${hopper.id}`)).json.hopper as { slug: string | null }).slug;
    const unknown = await getPublic(feedPath("no-such-hopper"));
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    if (slug) {
      const priv = await getPublic(feedPath(slug));
      expect(priv.status).toBe(404);
      expect(await priv.text()).toBe(unknownBody);
    }
  });

  it("go 404 through the public cache once the hopper is made private, or the setting is turned off", async () => {
    const { cookie, hopper } = await seed();
    await setFeeds(true);
    const url = `${BASE}${feedPath(hopper.slug)}`;
    const served = await SELF.fetch(url);
    expect(served.status).toBe(200);
    expect(served.headers.get("cloudflare-cdn-cache-control")).toContain("max-age=60");
    expect(served.headers.get("etag")).toMatch(/^W\//);
    await served.arrayBuffer();
    expect((await apiJson(cookie, "PATCH", `/api/hoppers/${hopper.id}`, { public: false })).status).toBe(200);
    const hidden = await SELF.fetch(url);
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get("cache-control")).toBe("no-store");
    await hidden.arrayBuffer();

    expect((await apiJson(cookie, "PATCH", `/api/hoppers/${hopper.id}`, { public: true })).status).toBe(200);
    const again = await SELF.fetch(url);
    expect(again.status).toBe(200);
    await again.arrayBuffer();
    await setFeeds(false);
    const off = await SELF.fetch(url);
    expect(off.status).toBe(404);
    await off.arrayBuffer();
  });

  it("leave the blyg's own feed.xml alone (decision #12)", async () => {
    const { hopper, ids } = await seed();
    await setFeeds(false);
    const before = await (await getPublic("/blyg/feed.xml")).text();
    await setFeeds(true);
    const after = await (await getPublic("/blyg/feed.xml")).text();
    const strip = (xml: string) => xml.replace(/<!-- cache-generation:[^>]*-->/, "").replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, "");
    expect(strip(after)).toBe(strip(before));
    expect(after).not.toContain("Words that carry the curated argument forward.");
    expect(after).not.toContain(ids.paged);
    expect(after).not.toContain(`hopper:${hopper.slug}`);
  });
});
