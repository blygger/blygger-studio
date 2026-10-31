// Snapshot freshness and refresh — decision #33's direct check, #38's
// "detect always, refresh only on a decision, never silently".
//
// What these pin down:
//   1. A quote is stale only by the direct relation: a newer version of the
//      item it baked, here or at the origin. Nothing transitive (#45).
//   2. The report agrees with what a republish would actually bake, because it
//      asks the same resolver.
//   3. A refresh is a republish of the *published* words: it refuses a dirty
//      working copy, refuses to bump a version for nothing, and refuses what
//      would fail anyway — and when it runs, the re-bake is visible on the wire
//      as same content_hash, new version (#38's distinguishing fact).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSubscription } from "../src/importer/store.ts";
import { probeVersion, threadFreshness } from "../src/freshness.ts";
import { getItem } from "../src/model.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";
import { makeFixtureFetch } from "./importer/fixtures.ts";

const THEIRS = "https://them.example/blyg/";

async function publishThread(cookie: string, md: string): Promise<string> {
  const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: md, kind: "thread" })).json.id as string;
  const pub = await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
  expect(pub.status).toBe(200);
  return id;
}

async function editAndPublish(cookie: string, id: string, md: string): Promise<void> {
  expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { content_md: md })).status).toBe(200);
  expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
}

describe("detecting stale quotes", () => {
  it("a quote of our own item goes stale when that item is republished, and only then", async () => {
    const cookie = await login();
    const frag = await createAndPublish(cookie, "First take.");
    const thread = await publishThread(cookie, `![[${frag}]]\n\nCommentary.`);

    let report = (await apiJson(cookie, "GET", `/blyg/api/items/${thread}/freshness`)).json;
    expect(report.quotes).toEqual([expect.objectContaining({ id: frag, baked: 1, held: 1, status: "current" })]);
    expect(report.stale).toBe(0);

    await editAndPublish(cookie, frag, "Second take.");
    report = (await apiJson(cookie, "GET", `/blyg/api/items/${thread}/freshness`)).json;
    expect(report.quotes).toEqual([expect.objectContaining({ id: frag, baked: 1, held: 2, status: "refreshable" })]);
    expect(report.stale).toBe(1);
    expect(report.blocking).toBe(0);
  });

  it("is direct only: a quote of a thread is not stale because that thread's own quote moved", async () => {
    const cookie = await login();
    const c = await createAndPublish(cookie, "C, original.");
    const b = await publishThread(cookie, `![[${c}]]\n\nB says.`);
    const a = await publishThread(cookie, `![[${b}]]\n\nA says.`);
    await editAndPublish(cookie, c, "C, revised.");
    // B is stale (its quote of C); A is not — A holds B's unchanged bytes (#45).
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${b}/freshness`)).json.stale).toBe(1);
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${a}/freshness`)).json.stale).toBe(0);
  });

  it("a partial quote whose passage is gone from the new version is blocking, not refreshable", async () => {
    const cookie = await login();
    const frag = await createAndPublish(cookie, "Keep this sentence. Drop that one.");
    const thread = await publishThread(cookie, `![[${frag}]]\n> Drop that one.\n\nWhy it matters.`);
    await editAndPublish(cookie, frag, "Keep this sentence.");
    const report = (await apiJson(cookie, "GET", `/blyg/api/items/${thread}/freshness`)).json;
    expect(report.quotes[0]).toMatchObject({ partial: true, status: "passage-missing" });
    expect(report.blocking).toBe(1);
    expect(report.stale).toBe(0);
  });

  it("a withdrawn local source is unresolvable — a republish would fail", async () => {
    const cookie = await login();
    const frag = await createAndPublish(cookie, "Soon gone.");
    const thread = await publishThread(cookie, `![[${frag}]]\n\nHmm.`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${frag}/withdraw`, {})).status).toBe(200);
    const report = (await apiJson(cookie, "GET", `/blyg/api/items/${thread}/freshness`)).json;
    expect(report.quotes[0]).toMatchObject({ status: "unresolvable", held: null });
    expect(report.blocking).toBe(1);
  });

  it("lists every published thread that needs attention, and no others", async () => {
    const cookie = await login();
    const frag = await createAndPublish(cookie, "Original.");
    const stale = await publishThread(cookie, `![[${frag}]]\n\nOne.`);
    await editAndPublish(cookie, frag, "Edited.");
    const fresh = await publishThread(cookie, `![[${frag}]]\n\nTwo.`);
    const list = (await apiJson(cookie, "GET", "/blyg/api/freshness")).json.items as { id: string }[];
    expect(list.map((t) => t.id)).toContain(stale);
    expect(list.map((t) => t.id)).not.toContain(fresh);
  });

  it("orders the queue stalest first, by versions missed summed over stale quotes", async () => {
    const cookie = await login();
    const a = await createAndPublish(cookie, "A v1.");
    const b = await createAndPublish(cookie, "B v1.");
    // `little` misses one version of one quote; `lots` misses three of one and
    // two of another, so it is five behind and must come first even though
    // `little` was published later (the old banner's recency order).
    const lots = await publishThread(cookie, `![[${a}]]\n\n![[${b}]]\n\nLots.`);
    for (const n of [2, 3, 4]) await editAndPublish(cookie, a, `A v${n}.`);
    await editAndPublish(cookie, b, "B v2.");
    const little = await publishThread(cookie, `![[${b}]]\n\nLittle.`);
    await editAndPublish(cookie, b, "B v3.");
    const list = (await apiJson(cookie, "GET", "/blyg/api/freshness")).json.items as { id: string; behind: number; stale: number }[];
    const ours = list.filter((t) => t.id === lots || t.id === little);
    expect(ours.map((t) => t.id)).toEqual([lots, little]);
    expect(ours[0]).toMatchObject({ behind: 5, stale: 2 });
    expect(ours[1]).toMatchObject({ behind: 1, stale: 1 });
  });

  it("refuses a freshness report for something that is not a published thread", async () => {
    const cookie = await login();
    const frag = await createAndPublish(cookie, "Just a fragment.");
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${frag}/freshness`)).status).toBe(409);
  });
});

describe("the origin probe (the direct check, §5.9)", () => {
  it("reports a remote quote as behind when the origin is ahead of our import", async () => {
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: THEIRS, feedUrl: `${THEIRS}feed.xml`, title: "Them" });
    const remote = "0000000000000000000000000q";
    await env.DB.prepare("INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html, l0) VALUES (?, ?, 'fragment', 'current', 2, '2026-10-01T00:00:00Z', 'x', '<p>Their v2.</p>', 0)")
      .bind(sub.id, remote).run();
    const cookie = await login();
    const thread = await publishThread(cookie, `![[${remote}]]\n\nMine.`);
    const item = (await getItem(env.DB, thread))!;

    // Without a probe the report is database-only: current.
    expect((await threadFreshness(env.DB, item)).quotes[0]).toMatchObject({ origin: THEIRS, baked: 2, held: 2, live: null, status: "current" });

    const { fetch } = makeFixtureFetch({ [`${THEIRS}items/${remote}.json`]: { body: JSON.stringify({ id: remote, version: 3 }) } });
    const probed = await threadFreshness(env.DB, item, fetch);
    expect(probed.quotes[0]).toMatchObject({ held: 2, live: 3, status: "behind" });
    expect(probed.stale).toBe(1);
  });

  it("an unreachable or malformed origin is inconclusive, never evidence of staleness", async () => {
    const remote = "0000000000000000000000000p";
    const { fetch } = makeFixtureFetch({
      [`${THEIRS}items/${remote}.json`]: { status: 500, body: "" },
      [`${THEIRS}items/other.json`]: { body: JSON.stringify({ id: "someone-else", version: 9 }) },
    });
    expect(await probeVersion(fetch, THEIRS, remote)).toBeNull();
    // A document naming a different id is not this item's version.
    expect(await probeVersion(fetch, THEIRS, "other")).toBeNull();
  });
});

describe("refreshing — a republish of the published words", () => {
  it("re-bakes the stale quote: same content_hash, new version, the new text on the wire", async () => {
    const cookie = await login();
    const frag = await createAndPublish(cookie, "Before.");
    const thread = await publishThread(cookie, `![[${frag}]]\n\nMy point.`);
    const before = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    await editAndPublish(cookie, frag, "After.");

    const res = await apiJson(cookie, "POST", `/blyg/api/items/${thread}/refresh`, { note: "refreshed quotes" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ version: 2, refreshed: [frag], resynced: 0 });

    const after = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(after.version).toBe(2);
    // #38: a re-bake is distinguishable from an edit — the hash covers
    // content_md only, and the author's words did not change.
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.transclusions).toEqual([{ id: frag, version: 2 }]);
    expect(after.content_html).toContain("After.");
    expect(after.content_html).not.toContain("Before.");
    expect(after.changelog.at(-1)).toMatchObject({ version: 2, note: "refreshed quotes" });
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${thread}/freshness`)).json.stale).toBe(0);
  });

  it("refuses when the working copy has unpublished edits — those are other words", async () => {
    const cookie = await login();
    const frag = await createAndPublish(cookie, "Before.");
    const thread = await publishThread(cookie, `![[${frag}]]\n\nMy point.`);
    await editAndPublish(cookie, frag, "After.");
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${thread}`, { content_md: `![[${frag}]]\n\nHalf-written new point` })).status).toBe(200);
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${thread}/refresh`, {});
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/unpublished edits/);
    expect((await getPublic(`/blyg/items/${thread}.json`).then((r) => r.json<any>())).version).toBe(1);
  });

  it("refuses to bump a version when nothing is stale", async () => {
    const cookie = await login();
    const frag = await createAndPublish(cookie, "Steady.");
    const thread = await publishThread(cookie, `![[${frag}]]\n\nFine.`);
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${thread}/refresh`, {});
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/already current/);
  });

  it("refuses, naming the quote, when a republish would fail", async () => {
    const cookie = await login();
    const keep = await createAndPublish(cookie, "Keep v1.");
    const gone = await createAndPublish(cookie, "Gone soon.");
    const thread = await publishThread(cookie, `![[${keep}]]\n\n![[${gone}]]\n\nBoth.`);
    await editAndPublish(cookie, keep, "Keep v2.");
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${gone}/withdraw`, {})).status).toBe(200);
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${thread}/refresh`, {});
    expect(res.status).toBe(409);
    expect(res.json.errors).toEqual([expect.objectContaining({ id: gone })]);
  });
});

describe("what counts as the published words", () => {
  it("a discarded edit can be refreshed, and is clean again (session 46)", async () => {
    const cookie = await login();
    const frag = await createAndPublish(cookie, "Before.");
    const md = `![[${frag}]]\n\nMy point.`;
    const thread = await publishThread(cookie, md);
    await editAndPublish(cookie, frag, "After.");
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${thread}`, { content_md: md + " Draft." })).status).toBe(200);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/restore`, { version: 1 })).status).toBe(200);
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${thread}`)).json.dirty).toBe(false);
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${thread}/freshness`)).json.dirty).toBe(false);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/refresh`, {})).status).toBe(200);
  });

  it("refuses when republishing would drop a generation disclosure the published version made", async () => {
    const cookie = await login();
    const frag = await createAndPublish(cookie, "Before.");
    const md = `![[${frag}]]\n\nMy point.`;
    const thread = await publishThread(cookie, md);
    await editAndPublish(cookie, frag, "After.");
    // As if v1 disclosed generated text, and the working copy was then restored
    // from it — the restore drops the provenance cache a republish would need.
    await env.DB.prepare("UPDATE versions SET generated_json = ? WHERE item_id = ? AND version = 1")
      .bind(JSON.stringify([{ sources: [], model: "m" }]), thread).run();
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/restore`, { version: 1 })).status).toBe(200);
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${thread}/refresh`, {});
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/unpublished edits/);
  });
});
