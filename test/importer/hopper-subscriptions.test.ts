// Hopper subscriptions (PROPOSED, pending Fable): §12.1 step 7 (hopper match),
// §12.2 (identity = origin + hopper feed), §13.5a rules 5-6 (L0 rows, dropped
// when gone). Module level with fixture fetches, like subscribe-flow.test.ts:
// the HTTP route defaults to real network.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HOPPER_UNLISTED_FLAG, pollSubscription } from "../../src/importer/poll.ts";
import { matchHopper, resolve } from "../../src/importer/resolve.ts";
import { createSubscription, findHopperSubscription, findSubscription, getSubscription, listImportedItems } from "../../src/importer/store.ts";
import { loadProvenance } from "../../src/public-feed.ts";
import { composeStubCite } from "../../src/stub.ts";
import { resolveTarget } from "../../src/transclusion.ts";
import { makeFixtureFetch, manifestBody } from "./fixtures.ts";

let n = 0;

function blygFixture() {
  const host = `https://h${n++}.example`;
  const origin = `${host}/blyg/`;
  const hoppers = [
    { title: "Picks", page: "h/picks/", feed: "h/picks/feed.xml" },
    { title: "Page Only", page: "h/page-only/" },
    { title: "More", page: "h/more/", feed: "h/more/feed.xml" },
  ];
  return { host, origin, hoppers, manifestUrl: `${origin}blyg.json`, feed: `${origin}h/picks/feed.xml`, more: `${origin}h/more/feed.xml`, page: `${origin}h/picks/` };
}

function hopperFeedXml(entries: { guid: string; link: string; title: string; creator?: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Picks — Fixture Blyg</title>
    <link>https://example.invalid/</link>
    <description>A collection</description>
${entries
  .map(
    (e) => `    <item>
      <guid isPermaLink="false">${e.guid}</guid>
      <link>${e.link}</link>
      <title>${e.title}</title>
      <description><![CDATA[<p>excerpt of ${e.title}</p>]]></description>
      <pubDate>Sat, 05 Sep 2026 00:00:00 GMT</pubDate>${e.creator ? `\n      <dc:creator>${e.creator}</dc:creator>` : ""}
      <source url="https://other.example/feed.xml">Other</source>
    </item>`,
  )
  .join("\n")}
  </channel>
</rss>`;
}

describe("§12.1 step 7: hopper match", () => {
  it("matches the hopper feed URL, resolving { origin, manifest, hopper_feed }", async () => {
    const f = blygFixture();
    const { fetch } = makeFixtureFetch({
      [f.manifestUrl]: { body: manifestBody({ site: f.origin, title: "Fixture Blyg", hoppers: f.hoppers }) },
      [f.feed]: { body: hopperFeedXml([]) },
    });
    const result = await resolve(f.feed, fetch, { hoppers: true });
    expect(result).toMatchObject({ kind: "blyg", origin: f.origin, manifestUrl: f.manifestUrl, hopper: { title: "Picks", page: f.page, feed: f.feed } });
  });

  it("matches the page, with or without its trailing slash, ignoring a query and fragment", async () => {
    const f = blygFixture();
    const { fetch } = makeFixtureFetch({ [f.manifestUrl]: { body: manifestBody({ site: f.origin, hoppers: f.hoppers }) } });
    for (const input of [f.page, f.page.slice(0, -1), `${f.page}?utm=x#top`, `${f.page.slice(0, -1)}?a=1`]) {
      const result = await resolve(input, fetch, { hoppers: true });
      expect(result, input).toMatchObject({ kind: "blyg", origin: f.origin, hopper: { feed: f.feed } });
    }
  });

  it("finds the manifest from the hopper page's rel=blyg on an unconventional mount", async () => {
    const host = `https://r${n++}.example`;
    const origin = `${host}/site/`;
    const { fetch } = makeFixtureFetch({
      [`${origin}h/picks/`]: { body: `<!doctype html><html><head><link rel="blyg" href="${origin}blyg.json"></head><body></body></html>` },
      [`${origin}blyg.json`]: { body: manifestBody({ site: origin, hoppers: [{ title: "Picks", page: "h/picks/", feed: "h/picks/feed.xml" }] }) },
    });
    const result = await resolve(`${origin}h/picks/`, fetch, { hoppers: true });
    expect(result).toMatchObject({ kind: "blyg", origin, hopper: { feed: `${origin}h/picks/feed.xml` } });
  });

  it("falls through to the whole blyg on no match, and on a page-only entry", async () => {
    const f = blygFixture();
    const { fetch } = makeFixtureFetch({ [f.manifestUrl]: { body: manifestBody({ site: f.origin, hoppers: f.hoppers }) } });
    for (const input of [f.origin, `${f.origin}h/other/`, `${f.origin}h/page-only/`, `${f.origin}h/page-only`]) {
      const result = await resolve(input, fetch, { hoppers: true });
      expect(result, input).toMatchObject({ kind: "blyg", origin: f.origin });
      expect(result.kind === "blyg" && result.hopper, input).toBeFalsy();
    }
  });

  it("is skipped when hopper feeds are off: the hopper URL resolves to the blyg, as before", async () => {
    const f = blygFixture();
    const { fetch } = makeFixtureFetch({
      [f.manifestUrl]: { body: manifestBody({ site: f.origin, hoppers: f.hoppers }) },
      [f.feed]: { body: hopperFeedXml([]) },
    });
    for (const input of [f.feed, f.page]) {
      const result = await resolve(input, fetch);
      expect(result).toMatchObject({ kind: "blyg", origin: f.origin });
      expect(result.kind === "blyg" && result.hopper).toBeFalsy();
    }
  });

  it("ignores malformed hoppers entries", () => {
    const origin = "https://m.example/";
    const manifest = { blyg: "0.4", hoppers: [null, 7, { page: "h/x/", feed: "h/x/feed.xml" }, { title: "T", feed: "h/y/feed.xml" }] };
    expect(matchHopper(`${origin}h/x/feed.xml`, origin, manifest)).toBeNull();
    expect(matchHopper(`${origin}h/y/feed.xml`, origin, manifest)).toBeNull();
    expect(matchHopper(`${origin}h/x/`, origin, { blyg: "0.4", hoppers: "nope" })).toBeNull();
  });
});

// §12.2: origin is the blyg's identity origin; hopper_feed is the list at it.
async function hopperSub(f: ReturnType<typeof blygFixture>, feed = f.feed, title = "Picks — Fixture Blyg") {
  return createSubscription(env.DB, { kind: "rss", origin: f.origin, feedUrl: feed, title, hopperFeed: feed });
}

async function importedBlygRow(subId: string, remoteId: string, l0 = 0) {
  await env.DB.prepare(
    `INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html, author_json, l0)
     VALUES (?, ?, 'fragment', 'current', 1, '2026-08-01T00:00:00Z', 'held words', '<p>held words</p>', ?, ?)`,
  )
    .bind(subId, remoteId, JSON.stringify({ name: "Held Author" }), l0)
    .run();
}

describe("§12.2: a hopper subscription's identity", () => {
  it("is (origin, hopper feed): two hoppers of one blyg and the whole blyg coexist", async () => {
    const f = blygFixture();
    const picks = await hopperSub(f);
    const more = await hopperSub(f, f.more, "More — Fixture Blyg");
    // Hopper subscriptions never count as the whole blyg.
    expect(await findSubscription(env.DB, f.origin, `${f.origin}feed.xml`)).toBeNull();
    const blyg = await createSubscription(env.DB, { kind: "blyg", origin: f.origin, feedUrl: `${f.origin}feed.xml`, title: "Fixture Blyg" });
    expect(picks).toMatchObject({ kind: "rss", origin: f.origin, feed_url: f.feed, hopper_feed: f.feed });
    expect(more).toMatchObject({ origin: f.origin, hopper_feed: f.more });
    expect((await findSubscription(env.DB, f.origin, `${f.origin}feed.xml`))?.id).toBe(blyg.id);
    expect((await findHopperSubscription(env.DB, f.origin, f.feed))?.id).toBe(picks.id);
    expect((await findHopperSubscription(env.DB, f.origin, f.more))?.id).toBe(more.id);
    expect(await findHopperSubscription(env.DB, f.origin, `${f.origin}h/none/feed.xml`)).toBeNull();
  });

  it("refuses a second subscription to the same (origin, hopper feed)", async () => {
    const f = blygFixture();
    const first = await hopperSub(f);
    // The subscribe route's 409 check finds it ...
    expect((await findHopperSubscription(env.DB, f.origin, f.feed))?.id).toBe(first.id);
    // ... and migration 0033's unique index backs it.
    await expect(hopperSub(f)).rejects.toThrow();
  });

  it("never supplies the whole blyg's title, provenance or citation", async () => {
    const f = blygFixture();
    // The hopper subscription comes first, so a lookup by origin alone would find it.
    const hopper = await hopperSub(f);
    await importedBlygRow(hopper.id, "shared-id");
    const ref = { origin: f.origin, id: "shared-id", version: 1 };
    // With no whole-blyg subscription, nothing at this origin is known.
    let cite = await composeStubCite(env.DB, ref, "https://us.example/", "Us", "2026-09-01T00:00:00Z");
    expect(cite.source).toBe(new URL(f.origin).host);
    expect(cite.author).toBeUndefined();
    expect((await loadProvenance(env.DB, [[ref]])).remoteSources.size).toBe(0);
    expect((await resolveTarget(env.DB, "shared-id")).ok).toBe(false);

    const blyg = await createSubscription(env.DB, { kind: "blyg", origin: f.origin, feedUrl: `${f.origin}feed.xml`, title: "Fixture Blyg" });
    await importedBlygRow(blyg.id, "shared-id");
    cite = await composeStubCite(env.DB, ref, "https://us.example/", "Us", "2026-09-01T00:00:00Z");
    expect(cite.source).toBe("Fixture Blyg");
    const sources = (await loadProvenance(env.DB, [[ref]])).remoteSources;
    expect([...sources.values()].map((v) => v.title)).toEqual(["Fixture Blyg"]);
    // One resolvable row, the blyg's: the hopper's copy does not make it ambiguous.
    const resolved = await resolveTarget(env.DB, "shared-id");
    expect(resolved.ok).toBe(true);
  });
});

describe("§13.5a: polling a hopper subscription", () => {
  const listed = (f: ReturnType<typeof blygFixture>) => ({ [f.manifestUrl]: { body: manifestBody({ site: f.origin, hoppers: f.hoppers }) } });
  const entries = [
    { guid: "hopper:picks:https://other.example/:one", link: "https://other.example/posts/one/", title: "One", creator: "Entry Author" },
    { guid: "hopper:picks:https://other.example/:two", link: "https://other.example/items/two.json", title: "Two" },
  ];

  it("imports entries as L0 rows and drops one that leaves the feed", async () => {
    const f = blygFixture();
    const sub = await hopperSub(f);
    const first = makeFixtureFetch({ ...listed(f), [f.feed]: { body: hopperFeedXml(entries) } });
    expect((await pollSubscription(env.DB, sub, first.fetch)).outcome).toBe("polled");
    let rows = await listImportedItems(env.DB, sub.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.l0).toBe(1);
    // §13.5a rule 5: each entry keeps its own author, never the hopper's owner.
    const authors = rows.map((r) => (r.author_json ? JSON.parse(r.author_json).name : null)).sort();
    expect(authors).toEqual(["Entry Author", null]);
    expect(rows.map((r) => r.content_md).join("\n")).toContain("https://other.example/posts/one/");

    const second = makeFixtureFetch({ ...listed(f), [f.feed]: { body: hopperFeedXml(entries.slice(1)) } });
    await pollSubscription(env.DB, (await getSubscription(env.DB, sub.id))!, second.fetch);
    rows = await listImportedItems(env.DB, sub.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].content_md).toContain("Two");

    // An emptied hopper empties the subscription.
    const third = makeFixtureFetch({ ...listed(f), [f.feed]: { body: hopperFeedXml([]) } });
    await pollSubscription(env.DB, (await getSubscription(env.DB, sub.id))!, third.fetch);
    expect(await listImportedItems(env.DB, sub.id)).toHaveLength(0);
  });

  it("keeps a plain L0 subscription's windowed entries (the drop is hopper-only)", async () => {
    const f = blygFixture();
    const plain = await createSubscription(env.DB, { kind: "rss", origin: `${f.host}/plain.xml`, feedUrl: `${f.host}/plain.xml`, title: "Plain" });
    await pollSubscription(env.DB, plain, makeFixtureFetch({ [`${f.host}/plain.xml`]: { body: hopperFeedXml(entries) } }).fetch);
    await pollSubscription(env.DB, (await getSubscription(env.DB, plain.id))!, makeFixtureFetch({ [`${f.host}/plain.xml`]: { body: hopperFeedXml([]) } }).fetch);
    expect(await listImportedItems(env.DB, plain.id)).toHaveLength(2);
  });

  it("stops polling when the manifest no longer lists the hopper, and never becomes a whole-blyg subscription", async () => {
    const f = blygFixture();
    const sub = await hopperSub(f);
    await pollSubscription(env.DB, sub, makeFixtureFetch({ ...listed(f), [f.feed]: { body: hopperFeedXml(entries) } }).fetch);
    expect(await listImportedItems(env.DB, sub.id)).toHaveLength(2);
    // The daily manifest sync comes round; the hopper has gone private.
    await env.DB.prepare("UPDATE subscriptions SET last_index_sync_at = NULL WHERE id = ?").bind(sub.id).run();
    const unlisted = makeFixtureFetch({
      [f.manifestUrl]: { body: manifestBody({ site: f.origin, hoppers: f.hoppers.slice(1) }) },
      [f.feed]: { body: hopperFeedXml(entries) },
    });
    expect((await pollSubscription(env.DB, (await getSubscription(env.DB, sub.id))!, unlisted.fetch)).outcome).toBe("skipped");
    expect(unlisted.calls).not.toContain(f.feed);
    const after = (await getSubscription(env.DB, sub.id))!;
    expect(after).toMatchObject({ kind: "rss", status: "paused", origin: f.origin, feed_url: f.feed, hopper_feed: f.feed });
    expect(JSON.parse(after.flags).map((x: { type: string }) => x.type)).toContain(HOPPER_UNLISTED_FLAG);
    expect(await listImportedItems(env.DB, sub.id)).toHaveLength(0);
    // Nothing subscribed to the whole blyg on the reader's behalf.
    expect(await findSubscription(env.DB, f.origin, `${f.origin}feed.xml`)).toBeNull();
  });

  it("leaves the subscription alone when the manifest cannot be read", async () => {
    const f = blygFixture();
    const sub = await hopperSub(f);
    const r = await pollSubscription(env.DB, sub, makeFixtureFetch({ [f.manifestUrl]: { status: 503 }, [f.feed]: { body: hopperFeedXml(entries) } }).fetch);
    expect(r.outcome).toBe("polled");
    expect((await getSubscription(env.DB, sub.id))!.status).toBe("active");
  });

  it("never resolves a hopper row as a [[id]], ![[id]] or TK source", async () => {
    const f = blygFixture();
    const sub = await hopperSub(f);
    await pollSubscription(env.DB, sub, makeFixtureFetch({ ...listed(f), [f.feed]: { body: hopperFeedXml(entries) } }).fetch);
    const rows = await listImportedItems(env.DB, sub.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const r = await resolveTarget(env.DB, row.remote_id);
      expect(r.ok).toBe(false);
    }
  });
});
