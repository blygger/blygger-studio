// Reading resource (§3.6): own, imported and L0 identities sort by clamped
// dates; withdrawn content stays absent. Studio rendering is covered in Playwright.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyEffect, createSubscription, upsertL0Item } from "../../src/importer/store.ts";
import { transition } from "../../src/importer/transition.ts";
import { apiJson, BASE, createAndPublish, login, STUDIO } from "../helpers.ts";
import { itemDocBody } from "./fixtures.ts";

describe("reading resource and shell authentication — §3.6", () => {
  it("returns own, imported, and l0 entries in clamped reverse-chron order", async () => {
    const cookie = await login();
    // Own item, published "now" (well after everything else below).
    await createAndPublish(cookie, "my own fragment");

    // An imported blyg fragment, observed a bit before the own item.
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: "https://friend.example/", feedUrl: "https://friend.example/feed.xml", title: "Friend" });
    const doc = await itemDocBody({ id: "remote-1", kind: "fragment", version: 1, content_md: "a friend's fragment", updated: "2020-01-01T00:00:00Z" });
    const tr = transition({ local: { status: "absent" }, doc: JSON.parse(doc) });
    await applyEffect(env.DB, sub.id, "remote-1", tr.effect, "2020-01-02T00:00:00Z");

    // An L0 legacy import, oldest of all.
    const l0Sub = await createSubscription(env.DB, { kind: "rss", origin: "https://blog.example/", feedUrl: "https://blog.example/rss.xml", title: "Legacy Blog" });
    await upsertL0Item(env.DB, l0Sub.id, "l0-post-1", {
      version: 1,
      created: "2019-01-01T00:00:00Z",
      updated: "2019-01-01T00:00:00Z",
      observedAt: "2019-01-01T00:00:00Z",
      contentMd: "[an old post](https://blog.example/1)\n\nsummary text",
      contentHtml: "<p><a href=\"https://blog.example/1\">an old post</a></p><p>summary text</p>",
      contentHash: "sha256:whatever",
    });

    const res = await apiJson(cookie, "GET", "/blyg/api/reading");
    expect(res.status).toBe(200);
    const rows = res.json.items;
    const ownIdx = rows.findIndex((row: { contentHtml: string }) => row.contentHtml.includes("my own fragment"));
    const importedIdx = rows.findIndex((row: { imported?: { remoteId: string } }) => row.imported?.remoteId === "remote-1");
    const l0Idx = rows.findIndex((row: { imported?: { remoteId: string } }) => row.imported?.remoteId === "l0-post-1");
    expect(ownIdx).toBeGreaterThan(-1);
    expect(importedIdx).toBeGreaterThan(ownIdx);
    expect(l0Idx).toBeGreaterThan(importedIdx);
    expect(rows[l0Idx].l0).toBe(true);
    expect(rows[importedIdx].imported.subscriptionTitle).toBe("Friend");
  });

  it("returns a withdrawn imported item without its old content", async () => {
    const cookie = await login();
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: "https://friend2.example/", feedUrl: "https://friend2.example/feed.xml", title: "Friend2" });
    const doc = await itemDocBody({ id: "remote-2", kind: "fragment", version: 1, content_md: "secret content should not show" });
    const importTr = transition({ local: { status: "absent" }, doc: JSON.parse(doc) });
    await applyEffect(env.DB, sub.id, "remote-2", importTr.effect, "2026-08-01T00:00:00Z");

    const withdrawnDoc = await itemDocBody({ id: "remote-2", kind: "withdrawn", version: 2 });
    const withdrawTr = transition({ local: { status: "current", version: 1 }, doc: JSON.parse(withdrawnDoc) });
    await applyEffect(env.DB, sub.id, "remote-2", withdrawTr.effect, "2026-08-02T00:00:00Z");

    // Withdrawn items are background: absent from the feed, present under the Background lens.
    const feed = await apiJson(cookie, "GET", `/blyg/api/reading?sub=${sub.id}`);
    expect(feed.json.items.some((row: { imported?: { remoteId: string } }) => row.imported?.remoteId === "remote-2")).toBe(false);
    const res = await apiJson(cookie, "GET", `/blyg/api/reading?sub=${sub.id}&background=true`);
    expect(res.status).toBe(200);
    const entry = res.json.items.find((row: { imported?: { remoteId: string } }) => row.imported?.remoteId === "remote-2");
    expect(entry).toMatchObject({ withdrawn: true });
    expect(entry.contentHtml).not.toContain("secret content should not show");
  });

  it("requires auth", async () => {
    const res = await SELF.fetch(`${BASE}${STUDIO}/reading`, { redirect: "manual" });
    expect(res.status).toBe(302);
  });
});
