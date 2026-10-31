// URLs in content_html are absolute, because content_html travels (session 30).
//
// Found on a live import: a PI item published `<img src="/media/x.png">`, and
// venkateshrao's reading view resolved it against venkateshrao.com — a 404 for
// an image that was 200 at its own origin. §7 already required the RSS
// description to be self-contained (the feed absolutized it); the item
// document, which is what subscribers import, did not. Fixed on all three
// sides: we publish absolute URLs, we resolve a fetched item's relative URLs
// against its origin before storing it, and the cron heals rows stored before.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { pollSubscription } from "../src/importer/poll.ts";
import { repairImportedUrls } from "../src/importer/schedule.ts";
import { createSubscription, getImportedItem, getSubscription } from "../src/importer/store.ts";
import { apiJson, getPublic, login } from "./helpers.ts";
import { feedBody, itemDocBody, makeFixtureFetch } from "./importer/fixtures.ts";

const OURS = "https://example.com/blyg/";
const THEIRS = "https://them.example/blyg/";

const imgs = (html: string) => [...html.matchAll(/<img[^>]*src="([^"]*)"/g)].map((m) => m[1]);

async function publishThread(cookie: string, md: string): Promise<string> {
  const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: md, kind: "thread" })).json.id as string;
  expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
  return id;
}

describe("publishing", () => {
  it("writes absolute media URLs into the item document", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "Look:\n\n![a](/blyg/media/abc.png)\n\n![b](media/def.png)" })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<{ content_html: string; content_md: string }>();
    expect(imgs(doc.content_html)).toEqual(["https://example.com/blyg/media/abc.png", `${OURS}media/def.png`]);
    // The source is the author's, untouched: only the rendering changes.
    expect(doc.content_md).toContain("![a](/blyg/media/abc.png)");
  });

  it("leaves absolute, protocol-relative and fragment URLs alone", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "[x](https://else.example/p) [y](//cdn.example/q) [z](#here)" })).json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<{ content_html: string }>();
    expect(doc.content_html).toContain('href="https://else.example/p"');
    expect(doc.content_html).toContain('href="//cdn.example/q"');
    expect(doc.content_html).toContain('href="#here"');
  });
});

describe("importing", () => {
  it("resolves a fetched item's relative URLs against its own origin before storing", async () => {
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: THEIRS, feedUrl: `${THEIRS}feed.xml`, title: "Them" });
    const doc = await itemDocBody({ id: "remote-img", kind: "fragment", version: 1, content_html: '<p><img src="/blyg/media/r.png" alt=""><img src="media/s.png" alt=""></p>', origin: THEIRS });
    const { fetch } = makeFixtureFetch({
      [`${THEIRS}feed.xml`]: { body: feedBody({ items: [{ id: "remote-img", version: 1, itemUrl: `${THEIRS}items/remote-img.json` }] }) },
      [`${THEIRS}items/remote-img.json`]: { body: doc },
    });
    await env.DB.prepare("UPDATE subscriptions SET last_index_sync_at = ? WHERE id = ?").bind(new Date().toISOString(), sub.id).run();
    await pollSubscription(env.DB, (await getSubscription(env.DB, sub.id))!, fetch);
    const row = await getImportedItem(env.DB, sub.id, "remote-img");
    expect(imgs(row!.content_html)).toEqual(["https://them.example/blyg/media/r.png", `${THEIRS}media/s.png`]);
  });

  it("the cron repairs rows stored before, and leaves L0 rows and // URLs alone", async () => {
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: THEIRS, feedUrl: `${THEIRS}feed.xml`, title: "Them" });
    const insert = (remote: string, l0: number, html: string) =>
      env.DB.prepare("INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html, l0) VALUES (?, ?, 'fragment', 'current', 1, '2026-10-01T00:00:00Z', '', ?, ?)")
        .bind(sub.id, remote, html, l0).run();
    await insert("old", 0, '<p><img src="/media/old.png"> <a href="//cdn.example/x">cdn</a></p>');
    await insert("cdn-only", 0, '<p><a href="//cdn.example/y">cdn</a></p>');
    await insert("rss", 1, '<p><img src="/rel.png"></p>');
    expect(await repairImportedUrls(env.DB)).toBe(1);
    expect((await getImportedItem(env.DB, sub.id, "old"))!.content_html).toBe('<p><img src="https://them.example/media/old.png"> <a href="//cdn.example/x">cdn</a></p>');
    expect((await getImportedItem(env.DB, sub.id, "cdn-only"))!.content_html).toBe('<p><a href="//cdn.example/y">cdn</a></p>');
    expect((await getImportedItem(env.DB, sub.id, "rss"))!.content_html).toBe('<p><img src="/rel.png"></p>');
    // Idempotent: nothing left to do.
    expect(await repairImportedUrls(env.DB)).toBe(0);
  });
});

describe("baking a remote snapshot into a thread", () => {
  it("resolves the snapshot against ITS origin, not ours, even for a row stored before the fix", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: THEIRS, feedUrl: `${THEIRS}feed.xml`, title: "Them" });
    const remote = "0000000000000000000000000r";
    await env.DB.prepare("INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html, l0) VALUES (?, ?, 'fragment', 'current', 1, '2026-10-01T00:00:00Z', 'x', ?, 0)")
      .bind(sub.id, remote, '<p>Their picture <img src="/blyg/media/theirs.png" alt=""></p>').run();
    const id = await publishThread(cookie, `![[${remote}]]\n\nMine: ![](/blyg/media/mine.png)`);
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<{ content_html: string }>();
    expect(imgs(doc.content_html)).toEqual(["https://them.example/blyg/media/theirs.png", "https://example.com/blyg/media/mine.png"]);
  });
});
