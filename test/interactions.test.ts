// The owner's interaction log (migration 0019, 0.25.0): what gets logged, when,
// and that nothing is logged twice for one act.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyEffect, createSubscription } from "../src/importer/store.ts";
import { transition } from "../src/importer/transition.ts";
import { newId } from "../src/util.ts";
import { itemDocBody } from "./importer/fixtures.ts";
import { apiJson, login } from "./helpers.ts";

async function imported(origin: string, content = "their post"): Promise<{ sub: string; id: string }> {
  const sub = await createSubscription(env.DB, { kind: "blyg", origin, feedUrl: `${origin}feed.xml`, title: "Friend" });
  const id = newId();
  const doc = await itemDocBody({ id, kind: "fragment", version: 2, content_md: content });
  await applyEffect(env.DB, sub.id, id, transition({ local: { status: "absent" }, doc: JSON.parse(doc) }).effect, new Date().toISOString());
  return { sub: sub.id, id };
}

async function log(cookie: string, id: string): Promise<{ kind: string; origin: string; hopper_name: string | null; own_item_id: string | null; version: number | null; label: string | null }[]> {
  const res = await apiJson(cookie, "GET", "/blyg/api/interactions?limit=100");
  expect(res.status).toBe(200);
  return (res.json.items as any[]).filter((r) => r.remote_id === id).reverse();
}

describe("interaction log", () => {
  it("logs each thumb change once, and lists current thumbs with a label", async () => {
    const cookie = await login();
    const origin = "https://thumbs.example/blyg/";
    const t = await imported(origin, "a post about **stigmergy**");
    const path = `/blyg/api/signals/${t.sub}/${t.id}`;
    await apiJson(cookie, "PUT", path, { thumb: 1 });
    await apiJson(cookie, "PUT", path, { thumb: 1 }); // no change, no entry
    await apiJson(cookie, "PUT", path, { thumb: -1 });
    await apiJson(cookie, "DELETE", path);
    await apiJson(cookie, "DELETE", path); // nothing to clear, no entry
    expect((await log(cookie, t.id)).map((r) => r.kind)).toEqual(["thumb_up", "thumb_down", "thumb_clear"]);
    expect((await log(cookie, t.id))[0]).toMatchObject({ origin, label: expect.stringContaining("stigmergy") });

    await apiJson(cookie, "PUT", path, { thumb: 1 });
    const thumbs = (await apiJson(cookie, "GET", "/blyg/api/thumbs")).json.items as any[];
    expect(thumbs.find((r) => r.remote_id === t.id)).toMatchObject({ thumb: 1, origin, subscription_id: t.sub });
  });

  it("logs hopper membership with the hopper's name, including removals when a hopper is deleted", async () => {
    const cookie = await login();
    const t = await imported("https://hoppered.example/blyg/");
    const hopper = (await apiJson(cookie, "POST", "/blyg/api/hoppers", { name: "Traces" })).json.id as string;
    const path = `/blyg/api/hoppers/${hopper}/items/${t.sub}/${t.id}`;
    await apiJson(cookie, "PUT", path);
    await apiJson(cookie, "PUT", path); // already a member
    await apiJson(cookie, "DELETE", path);
    await apiJson(cookie, "PUT", path);
    await apiJson(cookie, "DELETE", `/blyg/api/hoppers/${hopper}`);
    const rows = await log(cookie, t.id);
    expect(rows.map((r) => r.kind)).toEqual(["hopper_add", "hopper_remove", "hopper_add", "hopper_remove"]);
    expect(rows.every((r) => r.hopper_name === "Traces")).toBe(true);
  });

  it("logs a remote quote and a stub when first published, and not again on republish", async () => {
    const cookie = await login();
    const origin = "https://quoted.example/blyg/";
    const t = await imported(origin);
    const created = await apiJson(cookie, "POST", "/blyg/api/items", { content_md: `![[${t.id}]]\n\nMy take.`, kind: "thread", stub_of: { origin, id: t.id, version: 2 } });
    const thread = created.json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {});
    await apiJson(cookie, "PATCH", `/blyg/api/items/${thread}`, { content_md: `![[${t.id}]]\n\nMy longer take.` });
    await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {});
    const rows = await log(cookie, t.id);
    expect(rows.map((r) => r.kind).sort()).toEqual(["quote", "stub"]);
    expect(rows.every((r) => r.own_item_id === thread && r.version === 2)).toBe(true);
  });

  it("filters by kind and never logs our own items", async () => {
    const cookie = await login();
    const own = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "mine" })).json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${own}/publish`, {});
    const thread = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: `![[${own}]]\n\nSelf-quote.`, kind: "thread" })).json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {});
    expect(await log(cookie, own)).toEqual([]);
    const quotes = (await apiJson(cookie, "GET", "/blyg/api/interactions?kind=quote&limit=100")).json.items as any[];
    expect(quotes.every((r) => r.kind === "quote")).toBe(true);
  });
});

describe("reading lens (kind filter on /api/reading)", () => {
  it("narrows every source and its counts to one kind", async () => {
    const cookie = await login();
    const frag = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "lens fragment" })).json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${frag}/publish`, {});
    const thread = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: `![[${frag}]]\n\nlens thread`, kind: "thread" })).json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {});
    const all = (await apiJson(cookie, "GET", "/blyg/api/reading?sub=own&limit=50")).json;
    const threads = (await apiJson(cookie, "GET", "/blyg/api/reading?sub=own&kind=thread&limit=50")).json;
    const fragments = (await apiJson(cookie, "GET", "/blyg/api/reading?sub=own&kind=fragment&limit=50")).json;
    expect(threads.items.every((e: any) => e.kind === "thread")).toBe(true);
    expect(fragments.items.every((e: any) => e.kind === "fragment")).toBe(true);
    expect(threads.items.map((e: any) => e.key)).toContain(`own:${thread}`);
    expect(fragments.items.map((e: any) => e.key)).toContain(`own:${frag}`);
    expect(threads.counts.own + fragments.counts.own).toBe(all.counts.own);
  });
});

import migration0019 from "../migrations/0019_interactions.sql?raw";

describe("migration 0019 backfill", () => {
  it("recovers thumbs, hopper memberships, first remote quotes, remote stubs and forks, and skips self-references", async () => {
    const db = env.DB;
    const origin = "https://backfill.example/blyg/";
    const ours = "https://example.com/blyg/";
    await db.prepare("INSERT INTO settings (key, value) VALUES ('site_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(ours).run();
    await db.batch([
      db.prepare("INSERT INTO subscriptions (id, kind, origin, feed_url, title, created) VALUES ('bf-sub', 'blyg', ?, ?, 'BF', '2026-01-01')").bind(origin, `${origin}feed.xml`),
      db.prepare("INSERT INTO signals (subscription_id, remote_id, thumb, at) VALUES ('bf-sub', 'r1', -1, '2026-02-01')"),
      db.prepare("INSERT INTO hoppers (id, name, slug, public, created) VALUES ('bf-h', 'BF hopper', 'bf-hopper', 0, '2026-01-01')"),
      db.prepare("INSERT INTO hopper_items (hopper_id, subscription_id, remote_id, added_at) VALUES ('bf-h', 'bf-sub', 'r2', '2026-02-02')"),
      db.prepare("INSERT INTO items (id, kind, status, created, updated, version, content_md, forked_from) VALUES ('bf-t', 'thread', 'public', '2026-01-01', '2026-03-01', 2, '', ?)").bind(JSON.stringify({ origin, id: 'r4', version: 1 })),
      // v1 quotes r3 and stubs r3; v2 quotes it again (a refresh) and stubs our own item.
      db.prepare("INSERT INTO versions (item_id, version, content_md, content_html, content_hash, published_at, transclusions, stub_of) VALUES ('bf-t', 1, '', '', 'h', '2026-03-01', ?, ?)").bind(JSON.stringify([{ id: 'r3', version: 1, origin }]), JSON.stringify({ origin, id: 'r3', version: 1 })),
      db.prepare("INSERT INTO versions (item_id, version, content_md, content_html, content_hash, published_at, transclusions, stub_of) VALUES ('bf-t', 2, '', '', 'h', '2026-03-02', ?, ?)").bind(JSON.stringify([{ id: 'r3', version: 2, origin }, { id: 'mine', version: 1 }]), JSON.stringify({ origin: ours, id: 'mine', version: 1 })),
    ]);
    const backfill = (migration0019 as string).slice((migration0019 as string).indexOf("-- Backfill"));
    await db.prepare("DELETE FROM interactions").run();
    for (const stmt of backfill.replace(/^\s*--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
    const rows = (await db.prepare("SELECT kind, remote_id, at, own_version, hopper_name, backfilled FROM interactions WHERE remote_id IN ('r1', 'r2', 'r3', 'r4', 'mine') ORDER BY kind, remote_id").all()).results;
    expect(rows).toEqual([
      { kind: "fork", remote_id: "r4", at: "2026-03-01", own_version: 1, hopper_name: null, backfilled: 1 },
      { kind: "hopper_add", remote_id: "r2", at: "2026-02-02", own_version: null, hopper_name: "BF hopper", backfilled: 1 },
      { kind: "quote", remote_id: "r3", at: "2026-03-01", own_version: 1, hopper_name: null, backfilled: 1 },
      { kind: "stub", remote_id: "r3", at: "2026-03-01", own_version: 1, hopper_name: null, backfilled: 1 },
      { kind: "thumb_down", remote_id: "r1", at: "2026-02-01", own_version: null, hopper_name: null, backfilled: 1 },
    ]);
  });
});
