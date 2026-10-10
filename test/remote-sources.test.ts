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
import { createDraft, getItem, getTkProvenance, publish, putSettings } from "../src/model.ts";
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
