// `backfill` on createSubscription (studio#63, OPML import): false creates the
// subscription and leaves the archive to the quarter-hour cron; omitted keeps
// today's behaviour, a backfill under waitUntil. Driven through the real REST
// route with a deterministic public DNS answer and a fixture RSS feed, since
// the route's own fetch is the platform's (api.test.ts header note).
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createOwnerApi } from "../../src/owner-api.ts";
import { getSubscription, listImportedItems } from "../../src/importer/store.ts";
import { dueSubscriptions } from "../../src/importer/schedule.ts";

const RSS = (host: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${host}</title><link>https://${host}/</link>
  <item><guid>${host}-1</guid><title>one</title><link>https://${host}/1</link><description>first</description><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

afterEach(() => vi.restoreAllMocks());

/** Answers DNS with a public address, the feed URL with RSS, anything else 404; counts feed fetches. */
function network(feedUrl: string) {
  const host = new URL(feedUrl).host;
  const counts = { feed: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://cloudflare-dns.com/")) return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
    if (url === feedUrl) {
      counts.feed++;
      return new Response(RSS(host), { headers: { "content-type": "application/rss+xml" } });
    }
    return new Response("not found", { status: 404 });
  });
  return counts;
}

async function subscribe(body: Record<string, unknown>) {
  const app = new Hono().route("/api", createOwnerApi({ scope: ["owner:manage"], clientId: "opml-backfill", userId: "owner" }));
  const ctx = createExecutionContext();
  const waitUntil = vi.spyOn(ctx, "waitUntil");
  const res = await app.fetch(new Request("https://studio.example/api/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: (await res.json()) as any, waitUntil };
}

describe("createSubscription backfill flag", () => {
  it("backfill: false creates the subscription and queues no backfill; the cron finds it due", async () => {
    const feedUrl = "https://quiet.example/feed.xml";
    const counts = network(feedUrl);
    const { status, json, waitUntil } = await subscribe({ url: feedUrl, confirm: true, backfill: false });
    expect(status).toBe(201);
    expect(json).toMatchObject({ kind: "rss", feedUrl, inBlogroll: false, lastPollAt: null });
    // Resolution reads the feed once; nothing polls it afterwards.
    expect(counts.feed).toBe(1);
    expect(waitUntil.mock.calls.length).toBe(0);
    const row = await getSubscription(env.DB, json.id);
    expect(row).toMatchObject({ last_poll_at: null, last_index_sync_at: null });
    expect(await listImportedItems(env.DB, json.id)).toHaveLength(0);
    // The claim the flag rests on: a never-polled, unpaused subscription is due on the next tick.
    expect(dueSubscriptions([row!], Date.now()).map((s) => s.id)).toEqual([json.id]);
  });

  it("the default still backfills after the response", async () => {
    const feedUrl = "https://eager.example/feed.xml";
    const counts = network(feedUrl);
    const { status, json, waitUntil } = await subscribe({ url: feedUrl, confirm: true });
    expect(status).toBe(201);
    expect(waitUntil.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(counts.feed).toBe(2);
    const row = await getSubscription(env.DB, json.id);
    expect(row?.last_poll_at).not.toBeNull();
    expect(await listImportedItems(env.DB, json.id)).toHaveLength(1);
  });

  it("backfill: true is the default spelled out, and a non-boolean is refused", async () => {
    const feedUrl = "https://explicit.example/feed.xml";
    const counts = network(feedUrl);
    expect((await subscribe({ url: feedUrl, confirm: true, backfill: "no" })).status).toBe(400);
    const { status } = await subscribe({ url: feedUrl, confirm: true, backfill: true });
    expect(status).toBe(201);
    expect(counts.feed).toBe(2);
  });
});
