// tn-6 section 6, #91: the Mentions lens lists imported items whose own h-cards
// name the owner. Quotes are left out, nothing is counted, and own items never appear.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillImportedMentions, mentionTargets } from "../src/importer/mention-index.ts";
import { applyEffect, createSubscription, deleteSubscription, dropImportedItemsExcept } from "../src/importer/store.ts";
import { transition } from "../src/importer/transition.ts";
import { putSettings } from "../src/model.ts";
import { normalizeMentionTarget, ownMentionTargets } from "../src/mention-targets.ts";
import { newId } from "../src/util.ts";
import { itemDocBody } from "./importer/fixtures.ts";
import { apiJson, BASE, login } from "./helpers.ts";

const ME = "https://me.example/";
const card = (url: string, extra = "") => `<span class="h-card"><a class="u-url" href="${url}">@<span class="p-name">Me</span></a>${extra}</span>`;

async function imported(html: string) {
  const origin = `https://m${newId()}.example/`;
  const sub = await createSubscription(env.DB, { kind: "blyg", origin, feedUrl: `${origin}feed.xml`, title: "Them" });
  const id = newId();
  const result = transition({ local: { status: "absent" }, doc: JSON.parse(await itemDocBody({ id, kind: "fragment", version: 1, content_md: "x", content_html: html, origin })) });
  await applyEffect(env.DB, sub.id, id, result.effect, new Date().toISOString());
  return { sub: sub.id, id };
}
const lens = async (cookie: string) => {
  const { json } = await apiJson(cookie, "GET", "/blyg/api/reading?mentions=true&limit=50");
  return (json.items as { imported?: { remoteId: string }; source: string }[]);
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM imported_mentions").run();
  await putSettings(env.DB, { author_url: ME });
});

describe("mentionTargets", () => {
  it("reads links and data identifiers, normalized", async () => {
    expect(await mentionTargets(card("https://Me.Example/", '<data class="u-url" value="did:web:me.example"></data>'))).toEqual(["https://me.example", "did:web:me.example"]);
  });
  it("reads a card that is itself the link", async () => {
    expect(await mentionTargets('<a class="p-author h-card" href="https://me.example/">Me</a>')).toEqual(["https://me.example"]);
  });
  it("leaves out a baked quote's, at any depth, and keeps the writer's own beside it", async () => {
    const quote = `<blockquote class="blyg-transclusion"><p>${card("https://quoted.example/")}</p><blockquote class="blyg-transclusion">${card("https://deep.example/")}</blockquote></blockquote>`;
    expect(await mentionTargets(`${quote}<p>${card(ME)}</p>`)).toEqual(["https://me.example"]);
  });
  it("ignores plain links and text naming h-card", async () => {
    expect(await mentionTargets('<p>an h-card is <a href="https://me.example/">this</a></p>')).toEqual([]);
  });
});

describe("normalizing", () => {
  it("compares URLs by host case and trailing slash, acct by case, others exactly", () => {
    expect(normalizeMentionTarget("HTTPS://ME.example/a/")).toBe("https://me.example/a");
    expect(normalizeMentionTarget("acct:Me@Social.Example")).toBe("acct:me@social.example");
    expect(normalizeMentionTarget("did:plc:AbC")).toBe("did:plc:AbC");
  });
  it("takes the author URL and the blyg's address, once each", () => {
    expect(ownMentionTargets("https://a.example/", "https://a.example")).toEqual(["https://a.example"]);
    expect(ownMentionTargets("", "https://o.example/blyg/")).toEqual(["https://o.example/blyg"]);
  });
});

describe("the lens", () => {
  it("lists items naming the owner, not others or quotes, and tracks an update", async () => {
    const cookie = await login();
    const hit = await imported(`<p>Thanks ${card(ME)}</p>`);
    const other = await imported(`<p>Thanks ${card("https://other.example/")}</p>`);
    const quoted = await imported(`<blockquote class="blyg-transclusion">${card(ME)}</blockquote>`);
    const ids = (await lens(cookie)).map((e) => e.imported?.remoteId);
    expect(ids).toContain(hit.id);
    expect(ids).not.toContain(other.id);
    expect(ids).not.toContain(quoted.id);

    await applyEffect(env.DB, other.sub, other.id, { type: "update", doc: JSON.parse(await itemDocBody({ id: other.id, kind: "fragment", version: 2, content_md: "y", content_html: `<p>${card(ME)}</p>` })) } as never, new Date().toISOString());
    expect((await lens(cookie)).map((e) => e.imported?.remoteId)).toContain(other.id);
    await applyEffect(env.DB, hit.sub, hit.id, { type: "update", doc: JSON.parse(await itemDocBody({ id: hit.id, kind: "fragment", version: 2, content_md: "y", content_html: "<p>edited out</p>" })) } as never, new Date().toISOString());
    expect((await lens(cookie)).map((e) => e.imported?.remoteId)).not.toContain(hit.id);
  });

  it("never lists the owner's own items", async () => {
    const cookie = await login();
    await imported(`<p>${card(ME)}</p>`);
    expect((await lens(cookie)).every((e) => e.source === "imported")).toBe(true);
    const summary = await apiJson(cookie, "GET", "/blyg/api/reading/summary?mentions=true");
    expect(summary.json.counts.own).toBe(0);
  });

  it("matches the blyg's own address when no author URL is set", async () => {
    const cookie = await login();
    await putSettings(env.DB, { author_url: "", site_url: "" });
    const hit = await imported(`<p>${card(`${BASE}/blyg/`)}</p>`);
    expect((await lens(cookie)).map((e) => e.imported?.remoteId)).toContain(hit.id);
  });

  it("forgets a withdrawn item and a removed subscription", async () => {
    const a = await imported(`<p>${card(ME)}</p>`);
    await applyEffect(env.DB, a.sub, a.id, { type: "rollup-null", version: 2, updated: new Date().toISOString() }, new Date().toISOString());
    const b = await imported(`<p>${card(ME)}</p>`);
    await dropImportedItemsExcept(env.DB, b.sub, []);
    const c = await imported(`<p>${card(ME)}</p>`);
    await deleteSubscription(env.DB, c.sub);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM imported_mentions").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("backfill", () => {
  it("reads items imported before the index, then stops", async () => {
    const hit = await imported(`<p>${card(ME)}</p>`);
    await env.DB.prepare("DELETE FROM imported_mentions").run();
    await env.DB.prepare("INSERT OR REPLACE INTO imported_mentions_backfill (id, after) VALUES (1, 0)").run();
    expect(await backfillImportedMentions(env.DB, 100000)).toBeGreaterThan(0);
    expect(await env.DB.prepare("SELECT 1 FROM imported_mentions WHERE remote_id = ?").bind(hit.id).first()).toBeTruthy();
    expect(await env.DB.prepare("SELECT 1 FROM imported_mentions_backfill").first()).toBeNull();
    expect(await backfillImportedMentions(env.DB)).toBe(0);
  });
  it("walks in pages", async () => {
    await imported("<p>a</p>");
    await imported("<p>b</p>");
    await env.DB.prepare("INSERT OR REPLACE INTO imported_mentions_backfill (id, after) VALUES (1, 0)").run();
    expect(await backfillImportedMentions(env.DB, 1)).toBe(1);
    expect((await env.DB.prepare("SELECT after FROM imported_mentions_backfill").first<{ after: number }>())?.after).toBeGreaterThan(0);
  });
});
