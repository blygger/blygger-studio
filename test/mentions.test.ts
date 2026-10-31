// v0.3 tasks 6–7 acceptance (plan §2.3, §4.3, decision #28): both halves of
// Webmention, in one process. Sending is driven against a fixture blyg that
// advertises an endpoint and records what arrives; receiving is driven
// against fixture source documents, including the whole negative table —
// because for an inbound mention the negatives are the feature. Structural
// verification exists to say no.
//
// Expect a few "uncaught exception … internal error" lines on stderr from this
// file: the publish and endpoint routes hand delivery and verification to
// waitUntil, and those background fetches are refused by the test runtime
// after the test itself has finished. Blocking them via a miniflare
// outboundService was tried and reverted — it took the suite from 14s to 520s.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FetchLike, FetchInit } from "../src/importer/http.ts";
import { applyEffect, createSubscription } from "../src/importer/store.ts";
import { transition } from "../src/importer/transition.ts";
import { discoverEndpoint, endpointFromHtml, endpointFromLinkHeader } from "../src/mentions/discover.ts";
import { receiveMention, relationTo, targetItemId, verifyMention } from "../src/mentions/receive.ts";
import { drainOutbound, enqueueForVersion, remoteReferences } from "../src/mentions/send.ts";
import { getVersion } from "../src/model.ts";
import type { VersionRow } from "../src/types.ts";
import {
  FAILED_INBOUND_RETENTION_MS,
  getInbound,
  INBOUND_DOMAIN_HOURLY_LIMIT,
  INBOUND_GLOBAL_HOURLY_LIMIT,
  INBOUND_HOURLY_LIMIT,
  INBOUND_PENDING_LIMIT,
  INBOUND_PENDING_WINDOW_MS,
  listOutbound,
  markInboundUnverified,
  markInboundVerified,
  markOutbound,
  pruneFailedInbound,
  registrableDomain,
  upsertInbound,
} from "../src/mentions/store.ts";
import { newId } from "../src/util.ts";
import { itemDocBody } from "./importer/fixtures.ts";
import { apiJson, BASE, createAndPublish, getPublic, login } from "./helpers.ts";

const OURS = "https://example.com/blyg/";
const THEIRS = "https://friend.example/blyg/";

interface Recorded {
  url: string;
  init?: FetchInit;
}

/** A FetchLike over a fixed URL map that also records what was sent to it. */
function pageLinking(docUrl: string): string {
  return `<html><head><link rel="alternate" type="application/json" href="${docUrl}"></head><body></body></html>`;
}

function fixtureNet(map: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>): {
  fetch: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const entry = map[url];
    const status = entry?.status ?? (entry ? 200 : 404);
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: new Headers(entry?.headers ?? {}),
      text: async () => entry?.body ?? "",
    };
  };
  return { fetch, calls };
}

async function importFrom(origin: string, doc: Parameters<typeof itemDocBody>[0], title = "Friend"): Promise<string> {
  const sub = await createSubscription(env.DB, { kind: "blyg", origin, feedUrl: `${origin}feed.xml`, title });
  const tr = transition({ local: { status: "absent" }, doc: JSON.parse(await itemDocBody(doc)) });
  await applyEffect(env.DB, sub.id, doc.id, tr.effect, new Date().toISOString());
  return sub.id;
}

/**
 * Wait for the publish route's own background drain to stop writing to an
 * item's outbound rows. The route calls `drainOutbound` inside `waitUntil`
 * against the real network; in this runtime that fetch fails, so the row ends
 * `no_endpoint` — but *when* it lands is not ordered against the test body, and
 * a late write will overwrite a status the test set on purpose.
 */
async function settleOutbound(itemId: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const rows = (await listOutbound(env.DB)).filter((r) => r.item_id === itemId);
    if (rows.length && rows.every((r) => r.status !== "pending")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("endpoint discovery (§2.3.4)", () => {
  it("reads a Link header, resolving it against the page", () => {
    expect(endpointFromLinkHeader('</wm>; rel="webmention"', "https://a.example/p/")).toBe("https://a.example/wm");
    expect(endpointFromLinkHeader('<https://a.example/x>; rel="self", </wm>; rel="webmention"', "https://a.example/")).toBe(
      "https://a.example/wm",
    );
    expect(endpointFromLinkHeader('</feed>; rel="alternate"', "https://a.example/")).toBeNull();
  });

  it("reads a link or anchor in the markup", () => {
    expect(endpointFromHtml('<link rel="webmention" href="/wm">', "https://a.example/p/")).toBe("https://a.example/wm");
    expect(endpointFromHtml('<a rel="webmention" href="wm">x</a>', "https://a.example/p/")).toBe("https://a.example/p/wm");
    expect(endpointFromHtml("<p>nothing here</p>", "https://a.example/")).toBeNull();
  });

  it("prefers a blyg target's manifest key over W3C discovery", async () => {
    const net = fixtureNet({
      [`${THEIRS}blyg.json`]: { body: JSON.stringify({ blyg: "0.3", site: THEIRS, webmention: "webmention" }) },
    });
    const found = await discoverEndpoint(`${THEIRS}f/abc/`, net.fetch, THEIRS);
    expect(found.endpoint).toBe(`${THEIRS}webmention`);
    // One fetch, of the manifest — the page itself is never touched.
    expect(net.calls).toHaveLength(1);
  });

  it("treats a manifest without the key as 'does not receive', and never retries it", async () => {
    const net = fixtureNet({ [`${THEIRS}blyg.json`]: { body: JSON.stringify({ blyg: "0.3", site: THEIRS }) } });
    const found = await discoverEndpoint(`${THEIRS}f/abc/`, net.fetch, THEIRS);
    expect(found.endpoint).toBeNull();
  });
});

describe("sending (§2.3.3)", () => {
  it("enqueues one mention per remote reference on publish, and delivers source + target", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const remoteId = newId();
    await importFrom(THEIRS, { id: remoteId, kind: "fragment", version: 2, content_md: "their post", page: `f/${remoteId}/` });

    const stub = await apiJson(cookie, "POST", "/blyg/api/items", {
      kind: "thread",
      content_md: `![[${remoteId}]]\n\nMy response.`,
      stub_of: { origin: THEIRS, id: remoteId, version: 2 },
    });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${stub.json.id}/publish`, {})).status).toBe(200);

    const queued = (await listOutbound(env.DB)).filter((r) => r.item_id === stub.json.id);
    // The stub citation and the transclusion name the same item, so one
    // mention, not two.
    expect(queued).toHaveLength(1);
    expect(queued[0].target).toBe(`${THEIRS}f/${remoteId}/`);

    const net = fixtureNet({
      [`${THEIRS}blyg.json`]: { body: JSON.stringify({ blyg: "0.3", site: THEIRS, webmention: "webmention" }) },
      [`${THEIRS}webmention`]: { status: 202 },
    });
    await drainOutbound(env.DB, net.fetch, { origin: OURS });

    const post = net.calls.find((c) => c.init?.method === "POST");
    expect(post?.url).toBe(`${THEIRS}webmention`);
    const sent = new URLSearchParams(post!.init!.body);
    expect(sent.get("source")).toBe(`${OURS}t/${stub.json.id}/`);
    expect(sent.get("target")).toBe(`${THEIRS}f/${remoteId}/`);
    expect((await listOutbound(env.DB)).find((r) => r.id === queued[0].id)?.status).toBe("sent");
  });

  it("a republish re-sends only when the target's version changed (§15.2)", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const remoteId = newId();
    await importFrom(THEIRS, { id: remoteId, kind: "fragment", version: 2, content_md: "their post", page: `f/${remoteId}/` });
    const thread = (await apiJson(cookie, "POST", "/blyg/api/items", { kind: "thread", content_md: `![[${remoteId}]]\n\nMine.` })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    const row = () => listOutbound(env.DB).then((rows) => rows.find((r) => r.item_id === thread)!);
    expect((await row()).target_version).toBe(2);

    // The publish route hands its own drain to waitUntil against the real
    // network, which fails in this runtime and writes the row's status at an
    // arbitrary later moment. Let that land first, then set the state this test
    // is actually about: a delivered mention. Otherwise the background write
    // clobbers whatever we assert.
    await settleOutbound(thread);
    await markOutbound(env.DB, (await row()).id, { status: "sent" });

    // Republish with the reference untouched: an edit to our own prose. Until
    // migration 0011 this reset the row to `pending` and re-notified an origin
    // that had nothing new to hear.
    await apiJson(cookie, "PATCH", `/blyg/api/items/${thread}`, { content_md: `![[${remoteId}]]\n\nMine, with a typo fixed.` });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);
    expect((await row()).status).toBe("sent");
    // Our own version moved; the target's did not, and the target's is the test.
    expect((await row()).version).toBe(2);
    expect((await row()).target_version).toBe(2);

    // Now the target moves. A poll would write this row; writing it directly is
    // the same input to resolution with less machinery.
    await env.DB.prepare("UPDATE imported_items SET version = 3, content_html = ? WHERE remote_id = ?")
      .bind("<p>their post, revised</p>", remoteId)
      .run();
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);
    expect((await row()).status).toBe("pending");
    expect((await row()).target_version).toBe(3);

    // And it really does go out again, once.
    const net = fixtureNet({
      [`${THEIRS}blyg.json`]: { body: JSON.stringify({ blyg: "0.3", site: THEIRS, webmention: "webmention" }) },
      [`${THEIRS}webmention`]: { status: 202 },
    });
    await drainOutbound(env.DB, net.fetch, { origin: OURS });
    expect(net.calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
  });

  it("withdrawal re-sends although nothing about the target changed (§15.7)", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const remoteId = newId();
    await importFrom(THEIRS, { id: remoteId, kind: "fragment", version: 2, content_md: "their post", page: `f/${remoteId}/` });
    const stub = (await apiJson(cookie, "POST", "/blyg/api/items", {
      kind: "thread",
      content_md: `![[${remoteId}]]`,
      stub_of: { origin: THEIRS, id: remoteId, version: 2 },
    })).json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${stub}/publish`, {});
    const row = () => listOutbound(env.DB).then((rows) => rows.find((r) => r.item_id === stub)!);
    await settleOutbound(stub);
    await markOutbound(env.DB, (await row()).id, { status: "sent" });

    // The one notification owed precisely *because* nothing changed: the
    // receiver has to re-verify and find a withdrawn document. It is the only
    // caller that overrides the re-send test.
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${stub}/withdraw`, {})).status).toBe(200);
    expect((await row()).status).toBe("pending");
  });

  it("a {url} stub is sent once and never re-sent — a web page has no version", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const url = "https://example.org/some/essay";
    const stub = (await apiJson(cookie, "POST", "/blyg/api/items", { kind: "thread", content_md: "Answering this.", stub_of: { url } })).json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${stub}/publish`, {});
    const row = () => listOutbound(env.DB).then((rows) => rows.find((r) => r.item_id === stub)!);
    expect((await row()).target).toBe(url);
    expect((await row()).target_version).toBeNull();
    await settleOutbound(stub);
    await markOutbound(env.DB, (await row()).id, { status: "sent" });

    // Two null target versions must read as unchanged, which is why the
    // comparison is `IS NOT` and not `<>` — under `<>` this would re-send on
    // every republish forever.
    await apiJson(cookie, "PATCH", `/blyg/api/items/${stub}`, { content_md: "Answering this, at more length." });
    await apiJson(cookie, "POST", `/blyg/api/items/${stub}/publish`, {});
    expect((await row()).status).toBe("sent");
  });

  it("never sends for an own-origin reference", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const mine = await createAndPublish(cookie, "my own fragment");
    const stub = await apiJson(cookie, "POST", "/blyg/api/items", {
      kind: "thread",
      content_md: `![[${mine}]]`,
      stub_of: { origin: OURS, id: mine, version: 1 },
    });
    await apiJson(cookie, "POST", `/blyg/api/items/${stub.json.id}/publish`, {});
    expect((await listOutbound(env.DB)).filter((r) => r.item_id === stub.json.id)).toHaveLength(0);
  });

  it("records no_endpoint without retrying, and backs off on a 5xx", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const silent = newId();
    await importFrom("https://static.example/", { id: silent, kind: "fragment", version: 1, content_md: "static blyg" }, "Static");
    const a = await apiJson(cookie, "POST", "/blyg/api/items", {
      kind: "thread",
      content_md: `![[${silent}]]`,
      stub_of: { origin: "https://static.example/", id: silent, version: 1 },
    });
    await apiJson(cookie, "POST", `/blyg/api/items/${a.json.id}/publish`, {});

    // A static blyg: manifest present, no endpoint key. Conformant, unreachable.
    const quiet = fixtureNet({
      "https://static.example/blyg.json": { body: JSON.stringify({ blyg: "0.3", site: "https://static.example/" }) },
    });
    await drainOutbound(env.DB, quiet.fetch, { origin: OURS });
    let row = (await listOutbound(env.DB)).find((r) => r.item_id === a.json.id)!;
    expect(row.status).toBe("no_endpoint");

    const down = newId();
    await importFrom("https://down.example/", { id: down, kind: "fragment", version: 1, content_md: "down" }, "Down");
    const b = await apiJson(cookie, "POST", "/blyg/api/items", {
      kind: "thread",
      content_md: `![[${down}]]`,
      stub_of: { origin: "https://down.example/", id: down, version: 1 },
    });
    await apiJson(cookie, "POST", `/blyg/api/items/${b.json.id}/publish`, {});
    const broken = fixtureNet({
      "https://down.example/blyg.json": { body: JSON.stringify({ blyg: "0.3", site: "https://down.example/", webmention: "wm" }) },
      "https://down.example/wm": { status: 503 },
    });
    const now = Date.parse("2026-09-16T12:00:00Z");
    await drainOutbound(env.DB, broken.fetch, { origin: OURS, now });
    row = (await listOutbound(env.DB)).find((r) => r.item_id === b.json.id)!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    // First retry is 15 minutes out, not immediately.
    expect(Date.parse(row.next_attempt_at!) - now).toBe(15 * 60_000);
  });

  it("retries a 429 on the backoff schedule, which outlasts the receiver's 60 s pair cooldown", async () => {
    // 0.36.1's receiver refuses a repeat claim for the same pair within 60 s, so a
    // quick republish meets a 429. That must stay retryable, not terminal like other 4xx.
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const busy = newId();
    await importFrom("https://busy.example/", { id: busy, kind: "fragment", version: 1, content_md: "busy" }, "Busy");
    const stub = await apiJson(cookie, "POST", "/blyg/api/items", {
      kind: "thread",
      content_md: `![[${busy}]]`,
      stub_of: { origin: "https://busy.example/", id: busy, version: 1 },
    });
    await apiJson(cookie, "POST", `/blyg/api/items/${stub.json.id}/publish`, {});
    const limited = fixtureNet({
      "https://busy.example/blyg.json": { body: JSON.stringify({ blyg: "0.3", site: "https://busy.example/", webmention: "wm" }) },
      "https://busy.example/wm": { status: 429 },
    });
    const now = Date.parse("2026-10-09T12:00:00Z");
    await drainOutbound(env.DB, limited.fetch, { origin: OURS, now });
    const row = (await listOutbound(env.DB)).find((r) => r.item_id === stub.json.id)!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(Date.parse(row.next_attempt_at!) - now).toBeGreaterThan(60_000);
  });
});

describe("mention targets without the target's page (§15.2 sixth revision, decision #85)", () => {
  async function quoteAndPublish(cookie: string, origin: string, id: string): Promise<string> {
    const item = await apiJson(cookie, "POST", "/blyg/api/items", {
      kind: "thread",
      content_md: `![[${id}]]\n\nMine.`,
      stub_of: { origin, id, version: 1 },
    });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${item.json.id}/publish`, {})).status).toBe(200);
    return item.json.id as string;
  }
  const targetOf = async (itemId: string) => (await listOutbound(env.DB)).filter((r) => r.item_id === itemId).map((r) => r.target);

  it("an import that declares its page is still mentioned at the page", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const origin = "https://paged.example/";
    const id = newId();
    await importFrom(origin, { id, kind: "fragment", version: 1, content_md: "paged", page: `posts/${id}.html` }, "Paged");
    expect(await targetOf(await quoteAndPublish(cookie, origin, id))).toEqual([`${origin}posts/${id}.html`]);
  });

  it("an import without page is mentioned at its item document, never at f/{id}/", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const origin = "https://pageless.example/";
    const id = newId();
    await importFrom(origin, { id, kind: "fragment", version: 1, content_md: "no page" }, "Pageless");
    expect(await targetOf(await quoteAndPublish(cookie, origin, id))).toEqual([`${origin}items/${id}.json`]);
  });

  it("a thread without page is not guessed as t/{id}/ (nor as f/{id}/)", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const origin = "https://threads.example/";
    const id = newId();
    await importFrom(origin, { id, kind: "thread", version: 1, content_md: "a thread" }, "Threads");
    const targets = await targetOf(await quoteAndPublish(cookie, origin, id));
    expect(targets).toEqual([`${origin}items/${id}.json`]);
    expect(targets.some((t) => /\/[ft]\/[^/]+\/$/.test(t))).toBe(false);
  });

  it("a subscription whose manifest declared an item template is mentioned at the templated address", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const origin = "https://templated.example/";
    const id = newId();
    const sub = await importFrom(origin, { id, kind: "thread", version: 1, content_md: "templated" }, "Templated");
    await env.DB.prepare("UPDATE subscriptions SET surface = ? WHERE id = ?").bind(JSON.stringify({ item: "api/doc?id={id}" }), sub).run();
    expect(await targetOf(await quoteAndPublish(cookie, origin, id))).toEqual([`${origin}api/doc?id=${id}`]);
  });

  it("an origin we do not subscribe to has its manifest read once, for item template and endpoint", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const origin = "https://stranger.example/";
    const a = newId(), b = newId();
    const item = await apiJson(cookie, "POST", "/blyg/api/items", { kind: "fragment", content_md: "Mine." });
    await apiJson(cookie, "POST", `/blyg/api/items/${item.json.id}/publish`, {});
    // The references are hand-set on the version row: the publish route reads
    // manifests with the real network, which this runtime refuses.
    const row = { ...(await getVersion(env.DB, item.json.id, 1)) } as VersionRow;
    row.transclusions = JSON.stringify([{ id: a, version: 1, origin }, { id: b, version: 2, origin }]);
    const net = fixtureNet({
      [`${origin}blyg.json`]: { body: JSON.stringify({ blyg: "0.4", site: origin, item: "docs/{id}.json", webmention: "/wm" }) },
    });
    const refs = await remoteReferences(env.DB, item.json.id, row, OURS, net.fetch);
    expect(refs.map((r) => r.target)).toEqual([`${origin}docs/${a}.json`, `${origin}docs/${b}.json`]);
    expect(refs.every((r) => r.endpoint === "https://stranger.example/wm")).toBe(true);
    expect(net.calls.map((c) => c.url)).toEqual([`${origin}blyg.json`]);

    // No manifest at all: the default item document, and no endpoint claimed.
    const none = fixtureNet({});
    const fallback = await remoteReferences(env.DB, item.json.id, row, OURS, none.fetch);
    expect(fallback.map((r) => r.target)).toEqual([`${origin}items/${a}.json`, `${origin}items/${b}.json`]);
    expect(fallback.every((r) => r.endpoint === undefined)).toBe(true);
  });

  it("an endpoint learnt at enqueue is what delivery posts to", async () => {
    const origin = "https://stranger2.example/";
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const id = newId();
    const item = await apiJson(cookie, "POST", "/blyg/api/items", { kind: "fragment", content_md: "Mine." });
    // Published first, so the item has a public source URL to send.
    await apiJson(cookie, "POST", `/blyg/api/items/${item.json.id}/publish`, {});
    const row = { ...(await getVersion(env.DB, item.json.id, 1)) } as VersionRow;
    row.transclusions = JSON.stringify([{ id, version: 1, origin }]);
    const net = fixtureNet({
      [`${origin}blyg.json`]: { body: JSON.stringify({ blyg: "0.4", site: origin, webmention: "wm" }) },
      [`${origin}wm`]: { status: 202 },
    });
    await enqueueForVersion(env.DB, item.json.id, 1, row, OURS, { fetchFn: net.fetch });
    await drainOutbound(env.DB, net.fetch, { origin: OURS });
    const post = net.calls.find((c) => c.init?.method === "POST");
    expect(post?.url).toBe(`${origin}wm`);
    expect(new URLSearchParams(post!.init!.body).get("target")).toBe(`${origin}items/${id}.json`);
  });
});

describe("receiving and structural verification (§2.3.5)", () => {
  async function ourItem(): Promise<{ id: string; target: string; cookie: string }> {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const id = await createAndPublish(cookie, "a fragment worth responding to");
    return { id, target: `${OURS}f/${id}/`, cookie };
  }

  /** A fixture blyg whose page points at its document, the §2.3.2 way. */
  function sourceFixture(opts: {
    origin?: string;
    docOrigin?: string;
    id?: string;
    stubTargetId?: string | null;
    transcludeId?: string | null;
    /** §16.4: make the transclusion a partial one, carrying a `selector`. */
    partial?: boolean;
    withdrawn?: boolean;
    pageHtml?: string;
  }) {
    const origin = opts.origin ?? THEIRS;
    const id = opts.id ?? newId();
    const page = `${origin}t/${id}/`;
    const docUrl = `${origin}items/${id}.json`;
    const doc: Record<string, unknown> = {
      blyg: "0.3",
      id,
      kind: opts.withdrawn ? "withdrawn" : "thread",
      origin: opts.docOrigin ?? origin,
      page: `t/${id}/`,
      author: { name: "Their Name", url: origin },
      version: 2,
      content_md: "their response",
      content_html: "<p>their response</p>",
      content_hash: "sha256:x",
      media: [],
      transclusions: opts.transcludeId
        ? [
            {
              id: opts.transcludeId,
              version: 1,
              origin: OURS,
              ...(opts.partial
                ? { selector: { exact: "a fragment worth", prefix: "", suffix: " responding to" } }
                : {}),
            },
          ]
        : [],
      ...(opts.stubTargetId ? { stub_of: { origin: OURS, id: opts.stubTargetId, version: 1 } } : {}),
    };
    return {
      id,
      page,
      map: {
        [page]: {
          body: opts.pageHtml ?? `<html><head><link rel="alternate" type="application/json" href="${docUrl}"></head><body>hi</body></html>`,
        },
        [docUrl]: { body: JSON.stringify(doc) },
      },
    };
  }

  it("verifies a stub: 202 on the claim, `stub` once the document is read", async () => {
    const { id, target } = await ourItem();
    const src = sourceFixture({ stubTargetId: id, transcludeId: id });
    const net = fixtureNet(src.map);

    const outcome = await receiveMention(env.DB, { source: src.page, target }, OURS);
    expect(outcome.status).toBe(202);
    const mentionId = (outcome as { mentionId: string }).mentionId;
    const result = await verifyMention(env.DB, mentionId, src.page, id, OURS, net.fetch);
    expect(result.status).toBe("verified");
    // stub_of outranks the transclusion of the same item.
    expect(result.relation).toBe("stub");

    const row = await getInbound(env.DB, mentionId);
    expect(row?.status).toBe("verified");
    expect(row?.source_origin).toBe(THEIRS);
    expect(row?.source_version).toBe(2);
    expect(JSON.parse(row!.source_author_json!).name).toBe("Their Name");
    // A verified mention is a pointer: none of their prose is stored.
    expect(JSON.stringify(row)).not.toContain("their response");
    // Two fetches, exactly: the page and the document it names.
    expect(net.calls).toHaveLength(2);
  });

  it("verifies a plain transclusion as `transclusion`", async () => {
    const { id, target } = await ourItem();
    const src = sourceFixture({ transcludeId: id });
    const net = fixtureNet(src.map);
    const outcome = await receiveMention(env.DB, { source: src.page, target }, OURS);
    const result = await verifyMention(env.DB, (outcome as { mentionId: string }).mentionId, src.page, id, OURS, net.fetch);
    expect(result.relation).toBe("transclusion");
  });

  // §16.4 / plan §7.3 P5: a partial transclusion is the same construct with a
  // selector, so verification must reach the same verdict — and must reach it
  // *without* looking at the selector, which is why this is asserted rather
  // than assumed. A receiver that started treating `selector` as verification
  // input would be checking a claim about our text against their copy of it.
  it("verifies a PARTIAL transclusion as `transclusion` too, ignoring the selector", async () => {
    const { id, target } = await ourItem();
    const src = sourceFixture({ transcludeId: id, partial: true });
    const net = fixtureNet(src.map);
    const outcome = await receiveMention(env.DB, { source: src.page, target }, OURS);
    const result = await verifyMention(env.DB, (outcome as { mentionId: string }).mentionId, src.page, id, OURS, net.fetch);
    expect(result.status).toBe("verified");
    expect(result.relation).toBe("transclusion");
  });

  it("verifies a partial whose selector quotes text we never wrote", async () => {
    // The selector is self-asserted and is NOT a claim verification tests. It
    // describes what they took from us, checked at *their* publish time
    // against the snapshot they held; re-checking it here would make delivery
    // depend on our current text, and §16.4 keeps it out of §15.4 for exactly
    // that reason. A reader MAY re-check, separately, and display the result.
    const { id, target } = await ourItem();
    const src = sourceFixture({ transcludeId: id, partial: true });
    const doc = JSON.parse(src.map[`${THEIRS}items/${src.id}.json`].body);
    doc.transclusions[0].selector = { exact: "words we never published anywhere" };
    src.map[`${THEIRS}items/${src.id}.json`] = { body: JSON.stringify(doc) };

    const net = fixtureNet(src.map);
    const outcome = await receiveMention(env.DB, { source: src.page, target }, OURS);
    const result = await verifyMention(env.DB, (outcome as { mentionId: string }).mentionId, src.page, id, OURS, net.fetch);
    expect(result.status).toBe("verified");
    expect(result.relation).toBe("transclusion");
  });

  it("accepts a source URL that is the document itself — one fetch", async () => {
    const { id, target } = await ourItem();
    const src = sourceFixture({ stubTargetId: id });
    const docUrl = `${THEIRS}items/${src.id}.json`;
    const net = fixtureNet(src.map);
    const outcome = await receiveMention(env.DB, { source: docUrl, target }, OURS);
    const result = await verifyMention(env.DB, (outcome as { mentionId: string }).mentionId, docUrl, id, OURS, net.fetch);
    expect(result.status).toBe("verified");
    expect(net.calls).toHaveLength(1);
  });

  it("the negative table", async () => {
    const { id, target } = await ourItem();

    // (a) A page on one host whose document claims another origin — a mirror
    // or an impostor trying to speak in a real blyg's name.
    const impostor = sourceFixture({ origin: "https://mirror.example/", docOrigin: THEIRS, stubTargetId: id });
    let net = fixtureNet(impostor.map);
    let out = await receiveMention(env.DB, { source: impostor.page, target }, OURS);
    let res = await verifyMention(env.DB, (out as { mentionId: string }).mentionId, impostor.page, id, OURS, net.fetch);
    expect(res.status).toBe("failed");
    expect(res.reason).toMatch(/origin mismatch/);

    // (b) A real blyg document that simply doesn't reference us.
    const unrelated = sourceFixture({});
    net = fixtureNet(unrelated.map);
    out = await receiveMention(env.DB, { source: unrelated.page, target }, OURS);
    res = await verifyMention(env.DB, (out as { mentionId: string }).mentionId, unrelated.page, id, OURS, net.fetch);
    expect(res.status).toBe("failed");
    expect(res.reason).toMatch(/does not reference/);

    // (c) A withdrawn source → gone, not failed: it verified once.
    const withdrawn = sourceFixture({ stubTargetId: id, withdrawn: true });
    net = fixtureNet(withdrawn.map);
    out = await receiveMention(env.DB, { source: withdrawn.page, target }, OURS);
    res = await verifyMention(env.DB, (out as { mentionId: string }).mentionId, withdrawn.page, id, OURS, net.fetch);
    expect(res.status).toBe("gone");

    // (d) An ordinary web page with no JSON alternate — a plain webmention,
    // which the reference client holds apart and drops at 0.3 (§2.3.7).
    const plain = sourceFixture({ stubTargetId: id, pageHtml: `<html><body><a href="${target}">look at this</a></body></html>` });
    net = fixtureNet(plain.map);
    out = await receiveMention(env.DB, { source: plain.page, target }, OURS);
    res = await verifyMention(env.DB, (out as { mentionId: string }).mentionId, plain.page, id, OURS, net.fetch);
    expect(res.status).toBe("failed");
    expect(res.reason).toMatch(/not a blyg item/);
  });

  // Decision #61 (spec §15.4 step 2, eighth revision; conformance F1 and F4).
  it("a blyg path-mounted on the same host cannot verify in another's name (F1)", async () => {
    const { id, target } = await ourItem();
    // Alice's document is served from alice's path but claims carol's origin.
    const alice = sourceFixture({ origin: "https://shared.example/alice/", docOrigin: "https://shared.example/carol/", stubTargetId: id });
    const net = fixtureNet(alice.map);
    const out = await receiveMention(env.DB, { source: alice.page, target }, OURS);
    const res = await verifyMention(env.DB, (out as { mentionId: string }).mentionId, alice.page, id, OURS, net.fetch);
    expect(res.status).toBe("failed");
    expect(res.reason).toMatch(/origin mismatch/);
  });

  it("a pinned version file never verifies a mention (F4)", async () => {
    const { id, target } = await ourItem();
    const src = sourceFixture({ stubTargetId: id });
    // A pinned page whose alternate names the pin file, which still carries
    // stub_of — while the live document may long since be an endcap.
    const pinUrl = `${THEIRS}items/${src.id}/v2.json`;
    const pinPage = `${THEIRS}t/${src.id}/v2/`;
    const map = {
      [pinPage]: { body: `<html><head><link rel="alternate" type="application/json" href="${pinUrl}"></head></html>` },
      [pinUrl]: src.map[`${THEIRS}items/${src.id}.json`],
    };
    const net = fixtureNet(map);
    const out = await receiveMention(env.DB, { source: pinPage, target }, OURS);
    const res = await verifyMention(env.DB, (out as { mentionId: string }).mentionId, pinPage, id, OURS, net.fetch);
    expect(res.status).toBe("failed");
    expect(res.reason).toMatch(/origin mismatch/);
  });

  it("host case and a default port do not defeat an honest document", async () => {
    const { id, target } = await ourItem();
    const src = sourceFixture({ stubTargetId: id, docOrigin: "HTTPS://Friend.Example:443/blyg" });
    const net = fixtureNet(src.map);
    const out = await receiveMention(env.DB, { source: src.page, target }, OURS);
    const res = await verifyMention(env.DB, (out as { mentionId: string }).mentionId, src.page, id, OURS, net.fetch);
    expect(res.status).toBe("verified");
  });

  it("a target on our host but outside our mount names nothing of ours (§15.3)", async () => {
    const { id } = await ourItem();
    expect(await targetItemId(env.DB, new URL(`https://example.com/f/${id}/`), OURS)).toBeNull();
    expect(await targetItemId(env.DB, new URL(`https://example.com/blygx/f/${id}/`), OURS)).toBeNull();
    expect(await targetItemId(env.DB, new URL(`${OURS}f/${id}/`), OURS)).toBe(id);
  });

  it("a pinned version's document names its item: 202, recorded and verified against the item (§15.3, #84)", async () => {
    const { id, cookie } = await ourItem();
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { content_md: "a fragment worth responding to, revised" });
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
    expect((await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/1/pin`)).status).toBe(200);
    const target = `${OURS}items/${id}/v1.json`;
    const src = sourceFixture({ stubTargetId: id });
    const net = fixtureNet(src.map);

    const out = await receiveMention(env.DB, { source: src.page, target }, OURS);
    expect(out.status).toBe(202);
    const mentionId = (out as { mentionId: string }).mentionId;
    // Recorded against the item, never a version.
    const row = await env.DB.prepare("SELECT target_item_id FROM mentions_in WHERE id = ?").bind(mentionId).first<{ target_item_id: string }>();
    expect(row?.target_item_id).toBe(id);
    const res = await verifyMention(env.DB, mentionId, src.page, row!.target_item_id, OURS, net.fetch);
    expect(res.status).toBe("verified");
    expect(res.relation).toBe("stub");

    // The pinned page names it too, under its authored kind only.
    expect(await targetItemId(env.DB, new URL(`${OURS}f/${id}/v1/`), OURS)).toBe(id);
    expect(await targetItemId(env.DB, new URL(`${OURS}t/${id}/v1/`), OURS)).toBeNull();
    // An unpinned version is not an address we serve (§4); v2 exists, v3 does not.
    expect(await targetItemId(env.DB, new URL(`${OURS}items/${id}/v2.json`), OURS)).toBeNull();
    expect(await targetItemId(env.DB, new URL(`${OURS}f/${id}/v2/`), OURS)).toBeNull();
  });

  it("an unpinned v3, an unknown id or another blyg's page is 400 (§15.3, #84)", async () => {
    const { id, cookie } = await ourItem();
    expect((await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/1/pin`)).status).toBe(200);
    const source = `${THEIRS}t/${newId()}/`;
    for (const target of [
      `${OURS}items/${id}/v3.json`,
      `${OURS}items/${newId()}/v1.json`,
      `${OURS}f/${newId()}/v1/`,
      `${THEIRS}f/${id}/`,
      `${THEIRS}items/${id}/v1.json`,
      `https://example.com/items/${id}/v1.json`,
    ]) {
      expect((await receiveMention(env.DB, { source, target }, OURS)).status, target).toBe(400);
    }
  });

  it("a live page under the wrong kind is not an address we serve: 400 (§15.3, #84)", async () => {
    const { id, cookie } = await ourItem();
    const source = `${THEIRS}t/${newId()}/`;
    expect(await targetItemId(env.DB, new URL(`${OURS}f/${id}/`), OURS)).toBe(id);
    expect((await receiveMention(env.DB, { source, target: `${OURS}t/${id}/` }, OURS)).status).toBe(400);
    // The item document is served for either kind.
    expect(await targetItemId(env.DB, new URL(`${OURS}items/${id}.json`), OURS)).toBe(id);
    // A withdrawn fragment keeps its authored kind.
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/withdraw`, {});
    expect(await targetItemId(env.DB, new URL(`${OURS}f/${id}/`), OURS)).toBe(id);
    expect(await targetItemId(env.DB, new URL(`${OURS}t/${id}/`), OURS)).toBeNull();

    // And a thread named at f/{id}/.
    const thread = (await apiJson(cookie, "POST", "/blyg/api/items", { kind: "thread", content_md: "A thread of mine." })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);
    expect(await targetItemId(env.DB, new URL(`${OURS}t/${thread}/`), OURS)).toBe(thread);
    expect((await receiveMention(env.DB, { source, target: `${OURS}f/${thread}/` }, OURS)).status).toBe(400);
  });

  it("rejects malformed claims syntactically, before any fetch", async () => {
    const { target } = await ourItem();
    const cases: [string, { source?: string; target?: string }][] = [
      ["no source", { target }],
      ["relative source", { source: "/x", target }],
      ["source equals target", { source: target, target }],
      ["target on another host", { source: `${THEIRS}t/x/`, target: "https://elsewhere.example/f/x/" }],
      ["target names no item", { source: `${THEIRS}t/x/`, target: `${OURS}f/${newId()}/` }],
      ["target is not an item URL", { source: `${THEIRS}t/x/`, target: `${OURS}archive/` }],
    ];
    for (const [label, form] of cases) {
      const res = await receiveMention(env.DB, form, OURS);
      expect(res.status, label).toBe(400);
    }
  });

  it("accepts a mention that targets a withdrawn item — people may respond to a withdrawal", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const id = await createAndPublish(cookie, "soon withdrawn");
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/withdraw`, {});
    const res = await receiveMention(env.DB, { source: `${THEIRS}t/x/`, target: `${OURS}f/${id}/` }, OURS);
    expect(res.status).toBe(202);
  });

  it("rate-limits one source host at 60 an hour", async () => {
    const { id, target } = await ourItem();
    const now = Date.parse("2026-09-16T12:00:00Z");
    for (let i = 0; i < INBOUND_HOURLY_LIMIT; i++) {
      await upsertInbound(env.DB, `https://flood.example/t/${i}/`, target, id, new Date(now).toISOString());
    }
    // These rows stand for claims already resolved; the pending cap (row 11) is tested on its own.
    await env.DB.prepare("UPDATE mentions_in SET status = 'failed' WHERE target_item_id = ?").bind(id).run();
    const res = await receiveMention(env.DB, { source: "https://flood.example/t/last/", target }, OURS, now);
    expect(res.status).toBe(429);
    // A different host is unaffected — the limit is per source host.
    expect((await receiveMention(env.DB, { source: `${THEIRS}t/x/`, target }, OURS, now)).status).toBe(202);
  });

  it("rate-limits a wildcard-DNS flood at the registrable domain, which the per-host cap misses", async () => {
    const { id, target } = await ourItem();
    const now = Date.parse("2026-09-28T12:00:00Z");
    // One host per claim: every one of these is inside the per-host cap of 60,
    // which is exactly the hole §9.1 gap 1 names — a DNS wildcard costs the
    // flooder nothing.
    for (let i = 0; i < INBOUND_DOMAIN_HOURLY_LIMIT; i++) {
      await upsertInbound(env.DB, `https://h${i}.spam.example/t/x/`, target, id, new Date(now).toISOString());
    }
    // These rows stand for claims already resolved; the pending cap (row 11) is tested on its own.
    await env.DB.prepare("UPDATE mentions_in SET status = 'failed' WHERE target_item_id = ?").bind(id).run();
    const res = await receiveMention(env.DB, { source: "https://h999.spam.example/t/x/", target }, OURS, now);
    expect(res.status).toBe(429);
    expect((res as { error: string }).error).toMatch(/domain/);
    // A different registrable domain is unaffected, and so is a different
    // operator under a hosting suffix — `spam.example` groups, `pages.dev` does not.
    expect((await receiveMention(env.DB, { source: `${THEIRS}t/x/`, target }, OURS, now)).status).toBe(202);
  });

  it("caps the endpoint as a whole, which no per-source limit does", async () => {
    const { id, target } = await ourItem();
    const now = Date.parse("2026-09-28T12:00:00Z");
    // Spread across distinct registrable domains, each well inside both
    // per-source caps: the aggregate is the only thing that bounds this.
    for (let i = 0; i < INBOUND_GLOBAL_HOURLY_LIMIT; i++) {
      await upsertInbound(env.DB, `https://d${i}.example/t/x/`, target, id, new Date(now).toISOString());
    }
    const res = await receiveMention(env.DB, { source: "https://newcomer.example/t/x/", target }, OURS, now);
    expect(res.status).toBe(429);
    expect((res as { error: string }).error).toMatch(/hourly limit/);
    // An hour later the window has rolled and the endpoint accepts again.
    const later = now + 61 * 60_000;
    expect((await receiveMention(env.DB, { source: "https://newcomer.example/t/x/", target }, OURS, later)).status).toBe(202);
  });

  it("refuses the same pair claimed again within a minute, without touching the stored row (row 11)", async () => {
    const { target } = await ourItem();
    const now = Date.parse("2026-10-07T12:00:00Z");
    const source = `${THEIRS}t/x/`;
    const first = await receiveMention(env.DB, { source, target }, OURS, now);
    expect(first.status).toBe(202);
    const row = await getInbound(env.DB, (first as { mentionId: string }).mentionId);
    await markInboundVerified(env.DB, row!.id, { relation: "stub", sourceOrigin: THEIRS, sourceId: "x", sourceKind: "thread", sourceVersion: 1, authorJson: null, sourcePage: source });
    const again = await receiveMention(env.DB, { source, target }, OURS, now + 10_000);
    expect(again.status).toBe(429);
    expect((again as { retryAfter: number }).retryAfter).toBe(50);
    // Still verified, attempts not bumped: the repeat cost nothing and changed nothing.
    const after = await getInbound(env.DB, row!.id);
    expect(after?.status).toBe("verified");
    expect(after?.attempts).toBe(row?.attempts);
    // After the cooldown it is accepted and re-verified as before.
    expect((await receiveMention(env.DB, { source, target }, OURS, now + 61_000)).status).toBe(202);
  });

  it("caps claims awaiting verification, and a wedged pending row ages out of the count (row 11)", async () => {
    const { id, target } = await ourItem();
    const now = Date.parse("2026-10-07T12:00:00Z");
    for (let i = 0; i < INBOUND_PENDING_LIMIT; i++) {
      await upsertInbound(env.DB, `https://p${i}.example/t/x/`, target, id, new Date(now).toISOString());
    }
    const res = await receiveMention(env.DB, { source: "https://newcomer.example/t/x/", target }, OURS, now);
    expect(res.status).toBe(429);
    expect((res as { error: string }).error).toMatch(/awaiting verification/);
    // Verified and failed rows do not count, only pending ones.
    const later = now + INBOUND_PENDING_WINDOW_MS + 1000;
    expect((await receiveMention(env.DB, { source: "https://newcomer.example/t/x/", target }, OURS, later)).status).toBe(202);
  });

  it("prunes failed claims past retention and keeps verified, gone and pending ones", async () => {
    const { id, target } = await ourItem();
    const now = Date.parse("2026-09-28T12:00:00Z");
    const old = new Date(now - FAILED_INBOUND_RETENTION_MS - 1000).toISOString();
    const rows: Record<string, "failed" | "gone" | "verified" | "pending"> = {
      "https://old-fail.example/t/x/": "failed",
      "https://old-gone.example/t/x/": "gone",
      "https://old-pending.example/t/x/": "pending",
    };
    for (const [source, status] of Object.entries(rows)) {
      const row = await upsertInbound(env.DB, source, target, id, old);
      if (status === "failed" || status === "gone") await markInboundUnverified(env.DB, row.id, status, "fixture");
    }
    const recent = await upsertInbound(env.DB, "https://recent-fail.example/t/x/", target, id, new Date(now - 1000).toISOString());
    await markInboundUnverified(env.DB, recent.id, "failed", "fixture");

    expect(await pruneFailedInbound(env.DB, now)).toBe(1);
    const left = await env.DB.prepare("SELECT source FROM mentions_in WHERE target_item_id = ?").bind(id).all<{ source: string }>();
    const sources = left.results.map((r) => r.source);
    expect(sources).not.toContain("https://old-fail.example/t/x/");
    // `gone` is a relationship we deliberately remember; a fresh failure is
    // still legible to whoever is watching a spam wave.
    expect(sources).toContain("https://old-gone.example/t/x/");
    expect(sources).toContain("https://old-pending.example/t/x/");
    expect(sources).toContain("https://recent-fail.example/t/x/");
  });

  it("re-verification of a source that stopped referencing us marks it gone, keeping the row", async () => {
    const { id, target } = await ourItem();
    const src = sourceFixture({ stubTargetId: id });
    let net = fixtureNet(src.map);
    const out = await receiveMention(env.DB, { source: src.page, target }, OURS);
    const mentionId = (out as { mentionId: string }).mentionId;
    await verifyMention(env.DB, mentionId, src.page, id, OURS, net.fetch);
    expect((await getInbound(env.DB, mentionId))?.status).toBe("verified");

    const gone = sourceFixture({ id: src.id, stubTargetId: id, withdrawn: true });
    net = fixtureNet(gone.map);
    const again = await receiveMention(env.DB, { source: src.page, target }, OURS, Date.now() + 2 * 60_000);
    expect((again as { mentionId: string }).mentionId).toBe(mentionId);
    await verifyMention(env.DB, mentionId, src.page, id, OURS, net.fetch);
    const row = await getInbound(env.DB, mentionId);
    expect(row?.status).toBe("gone");
    // Kept, not deleted: a stubber who republishes is the same relationship.
    expect(row?.first_seen).toBeTruthy();
  });

  it("relationTo ignores a reference to some other item on our origin", () => {
    const ours = { origin: OURS, id: "target-id", version: 1 };
    expect(relationTo({ stub_of: ours }, OURS, "target-id")).toBe("stub");
    expect(relationTo({ stub_of: ours }, OURS, "different-id")).toBeNull();
    expect(relationTo({ stub_of: { url: "https://x.example/" } }, OURS, "target-id")).toBeNull();
  });
});

describe("the endpoint route (§2.3.1)", () => {
  it("is advertised in the manifest, in a page link, and in a Link header", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item");
    const manifest = await (await getPublic("/blyg/blyg.json")).json<any>();
    expect(manifest.webmention).toBe("webmention");

    const res = await getPublic(`/blyg/f/${id}/`);
    expect(res.headers.get("link")).toContain('rel="webmention"');
    expect(await res.text()).toContain('<link rel="webmention" href="https://example.com/blyg/webmention">');
    expect(await (await getPublic("/blyg/")).text()).toContain('rel="webmention"');
  });

  it("answers 202 on a well-formed claim and 400 on a bad one", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "a target item");
    const post = (body: Record<string, string>) =>
      SELF.fetch(`${BASE}/blyg/webmention`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      });

    const ok = await post({ source: `${THEIRS}t/abc/`, target: `https://example.com/blyg/f/${id}/` });
    expect(ok.status).toBe(202);
    const bad = await post({ source: "not-a-url", target: `https://example.com/blyg/f/${id}/` });
    expect(bad.status).toBe(400);
  });
});

describe("detect stubs — /studio/mentions (§3.3)", () => {
  it("returns verified relations and identifies imported sources for stub-back", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const mine = await createAndPublish(cookie, "something people respond to");

    // Someone we subscribe to and have imported: stub-back is possible.
    const knownId = newId();
    await importFrom(THEIRS, { id: knownId, kind: "thread", version: 1, content_md: "their stub" }, "Friend Blyg");
    const known = await upsertInbound(env.DB, `${THEIRS}t/${knownId}/`, `${OURS}f/${mine}/`, mine);
    const net = fixtureNet({
      // The page names its document, which lives at its real URL — §15.4
      // step 2 (decision #61) verifies only a document served from there.
      [`${THEIRS}t/${knownId}/`]: { body: pageLinking(`${THEIRS}items/${knownId}.json`) },
      [`${THEIRS}items/${knownId}.json`]: {
        body: JSON.stringify({
          blyg: "0.3",
          id: knownId,
          kind: "thread",
          origin: THEIRS,
          version: 1,
          author: { name: "Friend Author" },
          stub_of: { origin: OURS, id: mine, version: 1 },
          transclusions: [],
        }),
      },
    });
    await verifyMention(env.DB, known.id, `${THEIRS}t/${knownId}/`, mine, OURS, net.fetch);

    // A stranger we don't subscribe to: no stub-back, an invitation instead.
    const strangerId = newId();
    const stranger = await upsertInbound(env.DB, `https://stranger.example/t/${strangerId}/`, `${OURS}f/${mine}/`, mine);
    const strangerNet = fixtureNet({
      [`https://stranger.example/t/${strangerId}/`]: { body: pageLinking(`https://stranger.example/items/${strangerId}.json`) },
      [`https://stranger.example/items/${strangerId}.json`]: {
        body: JSON.stringify({
          blyg: "0.3",
          id: strangerId,
          kind: "thread",
          origin: "https://stranger.example/",
          version: 4,
          transclusions: [{ id: mine, version: 1, origin: OURS }],
        }),
      },
    });
    await verifyMention(env.DB, stranger.id, `https://stranger.example/t/${strangerId}/`, mine, OURS, strangerNet.fetch);

    const result = await apiJson(cookie, "GET", "/blyg/api/mentions?direction=inbound");
    const rows = result.json.items.filter((row: { target_item_id: string }) => row.target_item_id === mine);
    expect(rows).toHaveLength(2);
    expect(rows.find((row: { id: string }) => row.id === known.id)).toMatchObject({ relation: "stub", status: "verified" });
    expect(JSON.parse(rows.find((row: { id: string }) => row.id === known.id).source_author_json).name).toBe("Friend Author");
    expect(rows.find((row: { id: string }) => row.id === stranger.id)).toMatchObject({ relation: "transclusion", status: "verified" });
    expect((await apiJson(cookie, "GET", `/blyg/api/mentions/${known.id}/source`)).json.holder).toBeTruthy();
    expect((await apiJson(cookie, "GET", `/blyg/api/mentions/${stranger.id}/source`)).json.holder).toBeNull();
  });

  it("exposes the outbound queue and canonical site preference", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: "" });
    expect((await apiJson(cookie, "GET", "/blyg/api/settings")).json.site_url).toBe("");

    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const remoteId = newId();
    await importFrom(THEIRS, { id: remoteId, kind: "fragment", version: 1, content_md: "theirs" });
    const stub = await apiJson(cookie, "POST", "/blyg/api/items", {
      kind: "thread",
      content_md: `![[${remoteId}]]`,
      stub_of: { origin: THEIRS, id: remoteId, version: 1 },
    });
    await apiJson(cookie, "POST", `/blyg/api/items/${stub.json.id}/publish`, {});

    expect((await apiJson(cookie, "GET", "/blyg/api/settings")).json.site_url).toBe(OURS);
    const after = await apiJson(cookie, "GET", "/blyg/api/mentions?direction=outbound");
    expect(after.json.items).toEqual(expect.arrayContaining([expect.objectContaining({ target: `${THEIRS}items/${remoteId}.json`, item_id: stub.json.id })]));
  });
});

describe("the stub stack (§4.3)", () => {
  it("A's fragment → B's stub → A's stub of the stub, nested two deep and verified", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });

    // A (us) publishes F.
    const f = await createAndPublish(cookie, "the original claim");

    // B stubs it: their thread quotes F and cites it. We import that.
    const s1 = newId();
    const s1Html = `<p>I disagree.</p>\n<blockquote class="blyg-transclusion" data-blyg-id="${f}" data-blyg-version="1" data-blyg-origin="${OURS}"><p>the original claim</p></blockquote>`;
    const subId = await importFrom(THEIRS, { id: s1, kind: "thread", version: 1, content_md: "I disagree.", content_html: s1Html }, "Friend Blyg");

    // Their mention of F verifies as a stub.
    const inbound = await upsertInbound(env.DB, `${THEIRS}t/${s1}/`, `${OURS}f/${f}/`, f);
    const net = fixtureNet({
      // The page names its document, which lives at its real URL — §15.4
      // step 2 (decision #61) verifies only a document served from there.
      [`${THEIRS}t/${s1}/`]: { body: pageLinking(`${THEIRS}items/${s1}.json`) },
      [`${THEIRS}items/${s1}.json`]: {
        body: JSON.stringify({
          blyg: "0.3",
          id: s1,
          kind: "thread",
          origin: THEIRS,
          version: 1,
          stub_of: { origin: OURS, id: f, version: 1 },
          transclusions: [{ id: f, version: 1, origin: OURS }],
        }),
      },
    });
    expect((await verifyMention(env.DB, inbound.id, `${THEIRS}t/${s1}/`, f, OURS, net.fetch)).relation).toBe("stub");

    // A stubs the stub back, from the studio's own gesture.
    const created = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "response", source: { subscription_id: subId, remote_id: s1 } });
    expect(created.status).toBe(201);
    const s2 = created.json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${s2}/publish`, {})).status).toBe(200);

    const doc = await (await getPublic(`/blyg/items/${s2}.json`)).json<any>();
    expect(doc.stub_of).toMatchObject({ origin: THEIRS, id: s1, version: 1 });
    expect(doc.transclusions).toMatchObject([{ id: s1, version: 1, origin: THEIRS }]);
    // Two levels of blockquote: their thread, and our fragment inside it.
    expect((doc.content_html.match(/<blockquote class="blyg-transclusion"/g) ?? []).length).toBe(2);
    expect(doc.content_html).toContain(`data-blyg-id="${s1}"`);
    expect(doc.content_html).toContain(`data-blyg-id="${f}"`);
    expect(doc.content_html).toContain("the original claim");

    // And the mention we owe B is queued at their item document: the import
    // declared no `page`, and §15.2 (decision #85) forbids guessing `t/{id}/`.
    const queued = (await listOutbound(env.DB)).filter((r) => r.item_id === s2);
    expect(queued).toHaveLength(1);
    expect(queued[0].target).toBe(`${THEIRS}items/${s1}.json`);
  });
});

describe("registrableDomain — the rate-limit grouping heuristic (§9.1 gap 1)", () => {
  it("groups subdomains of one real domain and separates operators under a hosting suffix", () => {
    const cases: [string, string | null][] = [
      ["https://spam.example/x", "spam.example"],
      ["https://a.spam.example/x", "spam.example"],
      ["https://a.b.c.spam.example/x", "spam.example"],
      // Registry suffix: three labels, not two.
      ["https://blog.someone.co.uk/x", "someone.co.uk"],
      ["https://someone.co.uk/x", "someone.co.uk"],
      // Hosting suffixes, where a subdomain is a whole different operator —
      // including exe.xyz, where one of the live third-party nodes runs.
      ["https://jd-blyg.exe.xyz/blyg/", "jd-blyg.exe.xyz"],
      ["https://someones-blyg.pages.dev/x", "someones-blyg.pages.dev"],
      ["https://a.b.workers.dev/x", "b.workers.dev"],
      // The suffix itself, with nothing in front of it.
      ["https://pages.dev/x", "pages.dev"],
      // No suffix arithmetic applies to a literal address.
      ["http://192.168.0.9:8787/x", "192.168.0.9"],
      ["http://[::1]:8787/x", "[::1]"],
      // A trailing root dot is the same name.
      ["https://a.spam.example./x", "spam.example"],
      ["not a url", null],
    ];
    for (const [url, expected] of cases) {
      expect(registrableDomain(url), url).toBe(expected);
    }
  });
});

// An operator who never chose to run an unauthenticated public endpoint can
// switch it off — 0.3 §15 is OPTIONAL at every level, and §15.1 says the
// advertisement exists only when mentions are accepted. Until session 27 the
// client had no way to express that: `buildManifest` took a `webmention: false`
// option no caller ever passed.
describe("declining to receive mentions (§15 is optional)", () => {
  async function setAccept(cookie: string, accept: boolean) {
    const res = await apiJson(cookie, "PATCH", "/blyg/api/settings", { accept_mentions: accept });
    expect(res.status).toBe(200);
  }

  it("withdraws the endpoint from the manifest, the pages and the network", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const id = await createAndPublish(cookie, "an item someone might respond to");
    const target = `${OURS}f/${id}/`;

    // On by default — an existing deployment's behaviour does not change.
    let manifest = await (await getPublic("/blyg/blyg.json")).json<{ webmention?: string }>();
    expect(manifest.webmention).toBe("webmention");
    let page = await getPublic(`/blyg/f/${id}/`);
    expect(await page.text()).toContain('rel="webmention"');
    expect(page.headers.get("link")).toContain('rel="webmention"');

    await setAccept(cookie, false);

    // Not advertised: no manifest key, no link element, no Link header.
    manifest = await (await getPublic("/blyg/blyg.json")).json<{ webmention?: string }>();
    expect(manifest.webmention).toBeUndefined();
    page = await getPublic(`/blyg/f/${id}/`);
    expect(await page.text()).not.toContain('rel="webmention"');
    expect(page.headers.get("link")).toBeNull();

    // And not there: 404, the same answer a static export gives, rather than a
    // 403 that would imply an endpoint with a policy.
    const res = await SELF.fetch(`${BASE}/blyg/webmention`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `source=${encodeURIComponent(`${THEIRS}t/x/`)}&target=${encodeURIComponent(target)}`,
    });
    expect(res.status).toBe(404);

    expect((await apiJson(cookie, "GET", "/blyg/api/settings")).json.accept_mentions).toBe(false);

    // Reversible, and the item is untouched by any of it.
    await setAccept(cookie, true);
    manifest = await (await getPublic("/blyg/blyg.json")).json<{ webmention?: string }>();
    expect(manifest.webmention).toBe("webmention");
  });

  it("still sends mentions — the two halves are independent", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    await setAccept(cookie, false);

    const remoteId = newId();
    await importFrom(THEIRS, { id: remoteId, kind: "fragment", version: 2, content_md: "their post", page: `f/${remoteId}/` });
    const stub = await apiJson(cookie, "POST", "/blyg/api/items", {
      kind: "thread",
      content_md: `![[${remoteId}]]\n\nMy response.`,
      stub_of: { origin: THEIRS, id: remoteId, version: 2 },
    });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${stub.json.id}/publish`, {})).status).toBe(200);

    const queued = (await listOutbound(env.DB)).filter((r) => r.item_id === stub.json.id);
    expect(queued).toHaveLength(1);
    expect(queued[0].target).toBe(`${THEIRS}f/${remoteId}/`);
  });

  it("refuses a value that is neither true nor false, rather than reading it as on", async () => {
    const cookie = await login();
    const res = await apiJson(cookie, "PATCH", "/blyg/api/settings", { accept_mentions: "no" });
    expect(res.status).toBe(400);
    // `getSettings` treats anything but "off" as on, so a typo that was stored
    // would silently re-open the endpoint the operator meant to close.
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { accept_mentions: false })).status).toBe(200);
    const manifest = await (await getPublic("/blyg/blyg.json")).json<{ webmention?: string }>();
    expect(manifest.webmention).toBeUndefined();
  });
});
