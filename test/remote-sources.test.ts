// Remote generation sources (decision #44, 0.3 §16.3; v0.4-plan §7.2, gate G8).
//
// A [TK] scope may draw on any item a directive may name, resolved by §10.2's
// order against the local snapshot: our published items of either kind, then
// an imported item that is current or pin-retained. A remote source is
// disclosed as a reference (`origin` + frozen `cited`) and, at publish, is a
// remote reference that sends a mention verified as `source`.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderFetchLike } from "../src/ai/provider.ts";
import type { FetchLike } from "../src/importer/http.ts";
import { applyEffect } from "../src/importer/store.ts";
import { transition } from "../src/importer/transition.ts";
import { createDraft, getItem, getTkProvenance, publish, putSettings } from "../src/model.ts";
import { receiveMention, relationTo, verifyMention } from "../src/mentions/receive.ts";
import { listOutbound } from "../src/mentions/store.ts";
import { runGenerateScope } from "../src/tk-generate.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const OURS = "https://example.com/blyg/";
const THEM = "https://friend.example/blyg/";
const OTHER = "https://other.example/blyg/";
const R1 = "00000000000000000000000r01";
const R2 = "00000000000000000000000r02";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM imported_items WHERE subscription_id IN ('them', 'other')").run();
  await putSettings(env.DB, { ai_model: "claude-opus-5", site_url: OURS, site_title: "Our Blyg" });
  await env.DB.prepare("INSERT OR IGNORE INTO subscriptions (id, kind, origin, feed_url, title, created) VALUES ('them', 'blyg', ?, ?, 'Friend''s Blyg', '2026-10-01T00:00:00Z')").bind(THEM, `${THEM}feed.xml`).run();
  await env.DB.prepare("INSERT OR IGNORE INTO subscriptions (id, kind, origin, feed_url, title, created) VALUES ('other', 'blyg', ?, ?, 'Other Blyg', '2026-10-01T00:00:00Z')").bind(OTHER, `${OTHER}feed.xml`).run();
});

async function seedImported(
  sub: string,
  id: string,
  opts: { kind?: "fragment" | "thread"; md?: string; html?: string; state?: "current" | "tombstone"; version?: number; retained?: number | null; l0?: number } = {},
) {
  await env.DB.prepare(
    `INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html, l0, pinned_version_retained, page)
     VALUES (?, ?, ?, ?, ?, '2026-10-02T00:00:00Z', ?, ?, ?, ?, ?)`,
  )
    .bind(sub, id, opts.kind ?? "fragment", opts.state ?? "current", opts.version ?? 3, opts.md ?? "", opts.html ?? "<p>Their words.</p>", opts.l0 ?? 0, opts.retained ?? null, `f/${id}/`)
    .run();
}

function provider(text = "a summary") {
  const calls: { messages: { content: string }[] }[] = [];
  const fetchImpl: ProviderFetchLike = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: "claude-opus-5", content: [{ type: "text", text }] }) };
  };
  return { fetchImpl, calls };
}

async function generateWith(md: string) {
  const item = await createDraft(env.DB, md);
  const { fetchImpl, calls } = provider();
  const result = await runGenerateScope({ ...env, AI_PROVIDER_KEY: "k" }, item, 0, fetchImpl, OURS);
  return { item, result, calls, provenance: getTkProvenance((await getItem(env.DB, item.id))!) };
}

describe("resolution (R2): §10.2's order against the local snapshot", () => {
  it("a remote fragment: its markdown is fed, and the source records origin and a frozen cite", async () => {
    await seedImported("them", R1, { md: "Stigmergy is what a protocol looks like from inside.", html: "<p>Stigmergy is what a protocol looks like from inside.</p>" });
    const { result, calls, provenance } = await generateWith(`[TK]summarize ![[${R1}]][/TK]`);
    expect(result.ok).toBe(true);
    expect(calls[0].messages[0].content).toContain("Stigmergy is what a protocol looks like from inside.");
    expect(provenance[0]!.sources).toEqual([
      {
        id: R1,
        version: 3,
        origin: THEM,
        cited: expect.objectContaining({ source: "Friend's Blyg", url: `${THEM}f/${R1}/`, retrieved: provenance[0]!.at }),
      },
    ]);
  });

  it("a remote thread is fed as its reader sees it: the baked quote included, line breaks kept", async () => {
    await seedImported("them", R1, {
      kind: "thread",
      md: `![[zzzzzzzzzzzzzzzzzzzzzzzzzz]]\n\nMy reply.`,
      html: `<blockquote class="blyg-transclusion" data-blyg-id="zzzzzzzzzzzzzzzzzzzzzzzzzz"><p>The quoted words.</p></blockquote><p>My reply.</p>`,
    });
    const { result, calls, provenance } = await generateWith(`[TK]summarize ![[${R1}]][/TK]`);
    expect(result.ok).toBe(true);
    const fed = calls[0].messages[0].content;
    expect(fed).toContain("The quoted words.\nMy reply.");
    expect(fed).not.toContain("![[zzzzzzzzzzzzzzzzzzzzzzzzzz]]");
    // Disclosure is direct only: the thread, never what it quoted.
    expect(provenance[0]!.sources.map((s) => s.id)).toEqual([R1]);
  });

  it("an imported item with no markdown is fed from its HTML", async () => {
    await seedImported("them", R1, { md: "", html: "<p>Only HTML came.</p>" });
    const { calls } = await generateWith(`[TK]summarize ![[${R1}]][/TK]`);
    expect(calls[0].messages[0].content).toContain("Only HTML came.");
  });

  it("our own thread is a source now, with no origin and no cite", async () => {
    const cookie = await login();
    const frag = await createAndPublish(cookie, "Quoted fragment.");
    const thread = (await apiJson(cookie, "POST", "/api/items", { content_md: `![[${frag}]]\n\nThread words.`, kind: "thread" })).json.id as string;
    expect((await apiJson(cookie, "POST", `/api/items/${thread}/publish`, {})).status).toBe(200);
    const { result, calls, provenance } = await generateWith(`[TK]summarize ![[${thread}]][/TK]`);
    expect(result.ok).toBe(true);
    expect(calls[0].messages[0].content).toContain("Quoted fragment.\nThread words.");
    expect(provenance[0]!.sources).toEqual([{ id: thread, version: 1 }]);
  });

  it("a plain RSS (L0) item is refused by name, and the provider is never called", async () => {
    await seedImported("them", R1, { l0: 1 });
    const { result, calls } = await generateWith(`[TK]summarize ![[${R1}]][/TK]`);
    expect(result).toMatchObject({ ok: false, status: 400, body: { error: "unresolvable source: source is a plain RSS (L0) item, not a blyg item", id: R1 } });
    expect(calls).toHaveLength(0);
  });

  it("an id imported from two origins is ambiguous, an error rather than a guess", async () => {
    await seedImported("them", R1);
    await seedImported("other", R1);
    const { result } = await generateWith(`[TK]summarize ![[${R1}]][/TK]`);
    expect(result).toMatchObject({ ok: false, status: 400, body: { reason: "ambiguous id: imported from more than one origin" } });
  });

  it("withdrawn with a pin-retained snapshot: usable, at the retained version", async () => {
    await seedImported("them", R1, { state: "tombstone", version: 5, retained: 2, md: "Retained words.", html: "<p>Retained words.</p>" });
    const { result, calls, provenance } = await generateWith(`[TK]summarize ![[${R1}]][/TK]`);
    expect(result.ok).toBe(true);
    expect(calls[0].messages[0].content).toContain("Retained words.");
    expect(provenance[0]!.sources[0]).toMatchObject({ id: R1, version: 2, origin: THEM });
  });

  it("withdrawn with nothing retained is refused", async () => {
    await seedImported("them", R1, { state: "tombstone", version: 5, retained: null });
    const { result } = await generateWith(`[TK]summarize ![[${R1}]][/TK]`);
    expect(result).toMatchObject({ ok: false, body: { reason: "source withdrawn by origin" } });
  });
});

describe("emission (R3): the published reference is the stored one", () => {
  it("a remote source carries origin and cited on the item document and on the pinned file; an own source carries neither", async () => {
    const cookie = await login();
    const own = await createAndPublish(cookie, "Own words.");
    await seedImported("them", R2, { md: "Their words.", html: "<p>Their words.</p>" });
    const { item } = await generateWith(`[TK]compare ![[${own}]] with ![[${R2}]][/TK]`);
    await publish(env.DB, (await getItem(env.DB, item.id))!, null, OURS);
    expect((await apiJson(cookie, "PUT", `/api/items/${item.id}/versions/1/pin`)).status).toBe(200);

    const doc = await (await getPublic(`/blyg/items/${item.id}.json`)).json<any>();
    const sources = doc.generated[0].sources;
    expect(sources[0]).toEqual({ id: own, version: 1 });
    expect(sources[1]).toMatchObject({ id: R2, version: 3, origin: THEM, cited: { source: "Friend's Blyg", url: `${THEM}f/${R2}/` } });
    expect(typeof sources[1].cited.retrieved).toBe("string");

    const pinned = await (await getPublic(`/blyg/items/${item.id}/v1.json`)).json<any>();
    expect(JSON.stringify(pinned.generated)).toBe(JSON.stringify(doc.generated));
  });

  it("renaming the subscription after generation does not rewrite the published cite", async () => {
    await seedImported("them", R2, { md: "Their words." });
    const { item } = await generateWith(`[TK]summarize ![[${R2}]][/TK]`);
    await env.DB.prepare("UPDATE subscriptions SET title = 'Renamed' WHERE id = 'them'").run();
    await publish(env.DB, (await getItem(env.DB, item.id))!, null, OURS);
    const doc = await (await getPublic(`/blyg/items/${item.id}.json`)).json<any>();
    expect(doc.generated[0].sources[0].cited.source).toBe("Friend's Blyg");
  });
});

describe("send (R4): a remote source is a remote reference", () => {
  it("publishing a fragment whose scope drew on a remote item enqueues exactly one mention, with its target version", async () => {
    const cookie = await login();
    await seedImported("them", R1, { md: "Their words.", version: 4 });
    const { item } = await generateWith(`[TK]summarize ![[${R1}]][/TK]`);
    expect((await apiJson(cookie, "POST", `/api/items/${item.id}/publish`, {})).status).toBe(200);
    const queued = (await listOutbound(env.DB)).filter((r) => r.item_id === item.id);
    expect(queued).toHaveLength(1);
    expect(queued[0].target).toBe(`${THEM}f/${R1}/`);
    expect(queued[0].target_version).toBe(4);
  });

  it("a thread that both quotes and draws on the same item sends one mention, not two", async () => {
    const cookie = await login();
    await seedImported("them", R1, { md: "Their words.", html: "<p>Their words.</p>" });
    const thread = await createDraft(env.DB, `![[${R1}]]\n\n[TK]answer ![[${R1}]][/TK]`, "thread");
    const { fetchImpl } = provider("My answer.");
    expect((await runGenerateScope({ ...env, AI_PROVIDER_KEY: "k" }, thread, 0, fetchImpl, OURS)).ok).toBe(true);
    expect((await apiJson(cookie, "POST", `/api/items/${thread.id}/publish`, {})).status).toBe(200);
    expect((await listOutbound(env.DB)).filter((r) => r.item_id === thread.id)).toHaveLength(1);
  });

  it("an own source sends nothing", async () => {
    const cookie = await login();
    const own = await createAndPublish(cookie, "Own words.");
    const { item } = await generateWith(`[TK]summarize ![[${own}]][/TK]`);
    expect((await apiJson(cookie, "POST", `/api/items/${item.id}/publish`, {})).status).toBe(200);
    expect((await listOutbound(env.DB)).filter((r) => r.item_id === item.id)).toHaveLength(0);
  });
});

describe("receive (R5): `source`, the fourth relation", () => {
  const TARGET = "target-id";
  const sourceDoc = (sources: unknown[], extra: Record<string, unknown> = {}) => ({ generated: [{ sources, model: "m", at: "2026-10-10T00:00:00Z" }], ...extra });

  it("a generated[].sources[] entry naming our origin and the target is `source`", () => {
    expect(relationTo(sourceDoc([{ id: TARGET, version: 1, origin: OURS }]), OURS, TARGET)).toBe("source");
    // Origin is compared normalized, as for the other three.
    expect(relationTo(sourceDoc([{ id: TARGET, version: 1, origin: "HTTPS://Example.com/blyg/" }]), OURS, TARGET)).toBe("source");
  });

  it("one naming another origin, another item, or no origin (their own item) does not reference us", () => {
    expect(relationTo(sourceDoc([{ id: TARGET, version: 1, origin: OTHER }]), OURS, TARGET)).toBeNull();
    expect(relationTo(sourceDoc([{ id: "other-id", version: 1, origin: OURS }]), OURS, TARGET)).toBeNull();
    expect(relationTo(sourceDoc([{ id: TARGET, version: 1 }]), OURS, TARGET)).toBeNull();
    expect(relationTo({ generated: "nonsense" }, OURS, TARGET)).toBeNull();
    expect(relationTo({ generated: [null, { sources: "x" }] }, OURS, TARGET)).toBeNull();
  });

  it("ranks last: stub_of, a transclusion and a fork all outrank it", () => {
    const ref = { id: TARGET, version: 1, origin: OURS };
    expect(relationTo(sourceDoc([ref], { stub_of: ref }), OURS, TARGET)).toBe("stub");
    expect(relationTo(sourceDoc([ref], { transclusions: [ref] }), OURS, TARGET)).toBe("transclusion");
    expect(relationTo(sourceDoc([ref], { forked_from: ref }), OURS, TARGET)).toBe("fork");
  });

  it("verifies end to end, and the public responses list says the source drew on it", async () => {
    const cookie = await login();
    const ours = await createAndPublish(cookie, "Our words, read by their model.");
    expect((await apiJson(cookie, "PATCH", `/api/items/${ours}`, { responses: "show" })).status).toBe(200);
    const id = "00000000000000000000000s01";
    const page = `${THEM}f/${id}/`;
    const docUrl = `${THEM}items/${id}.json`;
    const doc = {
      blyg: "0.4", id, kind: "fragment", origin: THEM, page: `f/${id}/`, author: { name: "Their Name" }, version: 1,
      content_md: "A summary.", content_html: "<p>A summary.</p>", content_hash: "sha256:x", media: [], transclusions: [],
      generated: [{ sources: [{ id: ours, version: 1, origin: OURS }], model: "m", at: "2026-10-10T00:00:00Z" }],
    };
    const bodies: Record<string, string> = {
      [page]: `<html><head><link rel="alternate" type="application/json" href="${docUrl}"></head></html>`,
      [docUrl]: JSON.stringify(doc),
    };
    const net: FetchLike = async (url) => {
      const body = bodies[url];
      const status = body ? 200 : 404;
      return { ok: status === 200, status, url, headers: new Headers(), text: async () => body ?? "" };
    };
    const claim = await receiveMention(env.DB, { source: page, target: `${OURS}f/${ours}/` }, OURS);
    expect(claim.status).toBe(202);
    const result = await verifyMention(env.DB, (claim as { mentionId: string }).mentionId, page, ours, OURS, net);
    expect(result).toMatchObject({ status: "verified", relation: "source" });

    const html = await (await getPublic(`/blyg/f/${ours}/`)).text();
    expect(html).toContain("drew on this");
  });
});

describe("import (R8c, migration 0027): generated[] survives verbatim", () => {
  const generated = [{ sources: [{ id: "x0000000000000000000000001", version: 2, origin: OTHER, cited: { source: "Other Blyg", url: `${OTHER}f/x/`, retrieved: "2026-10-10T00:00:00Z" } }], model: "m", at: "2026-10-10T00:00:00Z" }];
  const doc = (version: number, extra: Record<string, unknown> = {}) => ({
    blyg: "0.4", id: R1, kind: "fragment", origin: THEM, page: `f/${R1}/`, version, created: "2026-10-01T00:00:00Z", updated: "2026-10-10T00:00:00Z",
    content_md: `v${version}`, content_html: `<p>v${version}</p>`, content_hash: `sha256:${version}`, media: [], ...extra,
  });
  const row = () => env.DB.prepare("SELECT generated_json FROM imported_items WHERE subscription_id = 'them' AND remote_id = ?").bind(R1).first<{ generated_json: string | null }>();

  it("is stored on import, replaced on update, and served by the imports API and the imported feed", async () => {
    const cookie = await login();
    await applyEffect(env.DB, "them", R1, transition({ local: { status: "absent" }, doc: doc(1, { generated }) }).effect, "2026-10-10T00:00:00Z");
    expect(JSON.parse((await row())!.generated_json!)).toEqual(generated);

    const api = await apiJson(cookie, "GET", `/api/imports/them/${R1}`);
    expect(JSON.parse(api.json.generated_json)).toEqual(generated);
    const feed = await apiJson(cookie, "GET", "/api/reading/imported?limit=100");
    expect(feed.json.items.find((i: { remoteId: string }) => i.remoteId === R1).generated).toEqual(generated);

    await applyEffect(env.DB, "them", R1, transition({ local: { status: "current", version: 1 }, doc: doc(2) }).effect, "2026-10-10T01:00:00Z");
    expect((await row())!.generated_json).toBeNull();
  });

  it("is cleared with the rest of the content when the origin withdraws the item", async () => {
    await applyEffect(env.DB, "them", R1, transition({ local: { status: "absent" }, doc: doc(1, { generated }) }).effect, "2026-10-10T00:00:00Z");
    const endcap = { blyg: "0.4", id: R1, kind: "withdrawn", origin: THEM, version: 2, updated: "2026-10-10T02:00:00Z" };
    await applyEffect(env.DB, "them", R1, transition({ local: { status: "current", version: 1 }, doc: endcap }).effect, "2026-10-10T02:00:00Z");
    expect((await row())!.generated_json).toBeNull();
  });
});
