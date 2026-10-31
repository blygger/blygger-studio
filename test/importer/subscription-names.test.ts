// Subscription names follow their source (0.29): a blyg's manifest title is
// re-read with the daily sync, an RSS feed's channel title on every poll, and
// a name the owner gave is never overwritten. Reported by Venkat, session 36:
// three blygs had renamed themselves and the studio still showed the old names.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { pollSubscription } from "../../src/importer/poll.ts";
import { createSubscription, getSubscription } from "../../src/importer/store.ts";
import { apiJson, login } from "../helpers.ts";
import { makeFixtureFetch } from "./fixtures.ts";

const ORIGIN = "https://renamed.example/";
const emptyFeed = (title: string) =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:blyg="https://blygger.org/ns/1.0"><channel><title>${title}</title><link>${ORIGIN}</link><description>x</description></channel></rss>`;
const index = JSON.stringify({ items: [] });

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM subscriptions WHERE origin LIKE '%renamed.example%'").run();
});

describe("subscription names follow their source", () => {
  it("a blyg's new manifest title replaces the old name at the daily sync", async () => {
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: ORIGIN, feedUrl: ORIGIN + "feed.xml", title: "Old Name" });
    const { fetch, calls } = makeFixtureFetch({
      [ORIGIN + "feed.xml"]: { body: emptyFeed("Feed Title") },
      [ORIGIN + "blyg.json"]: { body: JSON.stringify({ title: "Summer Lightning", feed: "feed.xml" }) },
      [ORIGIN + "items/index.json"]: { body: index },
    });
    await pollSubscription(env.DB, sub, fetch);
    expect((await getSubscription(env.DB, sub.id))!.title).toBe("Summer Lightning");
    expect(calls).toContain(ORIGIN + "blyg.json");
    // Between daily syncs the manifest is not fetched again.
    const after = (await getSubscription(env.DB, sub.id))!;
    calls.length = 0;
    await pollSubscription(env.DB, after, fetch);
    expect(calls).not.toContain(ORIGIN + "blyg.json");
  });

  // The daily manifest read still happens for an owner-named subscription:
  // since 0.35 it also re-reads where a templated blyg's surface lives
  // (§16.6e). What the owner's name is protected from is the overwrite.
  it("never overwrites a name the owner gave", async () => {
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: ORIGIN, feedUrl: ORIGIN + "feed.xml", title: "My name for it", titleAuto: false });
    const { fetch, calls } = makeFixtureFetch({
      [ORIGIN + "feed.xml"]: { body: emptyFeed("x") },
      [ORIGIN + "blyg.json"]: { body: JSON.stringify({ title: "Their Name" }) },
      [ORIGIN + "items/index.json"]: { body: index },
    });
    await pollSubscription(env.DB, sub, fetch);
    expect((await getSubscription(env.DB, sub.id))!.title).toBe("My name for it");
    expect(calls).toContain(ORIGIN + "blyg.json");
  });

  it("a missing or broken manifest leaves the name and the poll alone", async () => {
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: ORIGIN, feedUrl: ORIGIN + "feed.xml", title: "Kept" });
    const { fetch } = makeFixtureFetch({ [ORIGIN + "feed.xml"]: { body: emptyFeed("x") }, [ORIGIN + "blyg.json"]: { body: "{not json" }, [ORIGIN + "items/index.json"]: { body: index } });
    const r = await pollSubscription(env.DB, sub, fetch);
    expect(r.outcome).toBe("polled");
    expect((await getSubscription(env.DB, sub.id))!.title).toBe("Kept");
  });

  it("an RSS subscription takes its feed's channel title on every poll", async () => {
    const feed = "https://renamed.example/rss.xml";
    const sub = await createSubscription(env.DB, { kind: "rss", origin: feed, feedUrl: feed, title: "renamed.example" });
    await pollSubscription(env.DB, sub, makeFixtureFetch({ [feed]: { body: emptyFeed("Interconnected") } }).fetch);
    expect((await getSubscription(env.DB, sub.id))!.title).toBe("Interconnected");
    const renamed = (await getSubscription(env.DB, sub.id))!;
    await pollSubscription(env.DB, renamed, makeFixtureFetch({ [feed]: { body: emptyFeed("Interconnected, by Matt Webb") } }).fetch);
    expect((await getSubscription(env.DB, sub.id))!.title).toBe("Interconnected, by Matt Webb");
  });

  it("renaming makes the name the owner's; null hands it back to the source", async () => {
    const cookie = await login();
    const sub = await createSubscription(env.DB, { kind: "rss", origin: "https://renamed.example/a.xml", feedUrl: "https://renamed.example/a.xml", title: "x" });
    const named = await apiJson(cookie, "PATCH", `/blyg/api/subscriptions/${sub.id}`, { title: "Mine" });
    expect(named.json).toMatchObject({ title: "Mine", titleFollowsSource: false });
    const back = await apiJson(cookie, "PATCH", `/blyg/api/subscriptions/${sub.id}`, { title: null });
    expect(back.json).toMatchObject({ title: "Mine", titleFollowsSource: true });
    await pollSubscription(env.DB, (await getSubscription(env.DB, sub.id))!, makeFixtureFetch({ "https://renamed.example/a.xml": { body: emptyFeed("Their Name") } }).fetch);
    expect((await getSubscription(env.DB, sub.id))!.title).toBe("Their Name");
  });
});
