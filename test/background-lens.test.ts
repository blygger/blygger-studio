// Withdrawn posts are background (0.49.0): every lens but Background leaves
// them out of the feed and its counts, and Background shows only them.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyEffect, createSubscription } from "../src/importer/store.ts";
import { transition } from "../src/importer/transition.ts";
import { newId } from "../src/util.ts";
import { itemDocBody } from "./importer/fixtures.ts";
import { apiJson, createAndPublish, login } from "./helpers.ts";

describe("reading: withdrawn posts are background", () => {
  it("keeps own endcaps and imported tombstones out of every other lens, and only them in Background", async () => {
    const cookie = await login();
    const live = await createAndPublish(cookie, "Background lens live post");
    const gone = await createAndPublish(cookie, "Background lens withdrawn post");
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${gone}/withdraw`, {})).status).toBe(200);

    const origin = "https://bg.example/";
    const sub = await createSubscription(env.DB, { kind: "blyg", origin, feedUrl: `${origin}feed.xml`, title: "Bg" });
    const keep = newId(), drop = newId();
    for (const id of [keep, drop]) {
      await applyEffect(env.DB, sub.id, id, transition({ local: { status: "absent" }, doc: JSON.parse(await itemDocBody({ id, kind: "fragment", version: 1, content_md: "imported" })) }).effect, new Date().toISOString());
    }
    await env.DB.prepare("UPDATE imported_items SET state = 'tombstone' WHERE subscription_id = ? AND remote_id = ?").bind(sub.id, drop).run();

    const keys = async (query: string) => {
      const res = await apiJson(cookie, "GET", `/blyg/api/reading?limit=50${query}`);
      expect(res.status).toBe(200);
      return { keys: (res.json.items as { key: string }[]).map((e) => e.key), counts: res.json.counts };
    };
    const feed = await keys("");
    expect(feed.keys).toContain(`own:${live}`);
    expect(feed.keys).toContain(`imported:${JSON.stringify([sub.id, keep])}`);
    expect(feed.keys).not.toContain(`own:${gone}`);
    expect(feed.keys).not.toContain(`imported:${JSON.stringify([sub.id, drop])}`);
    expect(feed.counts.subscriptions[sub.id]).toBe(1);

    const background = await keys("&background=true");
    expect(background.keys).toContain(`own:${gone}`);
    expect(background.keys).toContain(`imported:${JSON.stringify([sub.id, drop])}`);
    expect(background.keys).not.toContain(`own:${live}`);
    expect(background.keys).not.toContain(`imported:${JSON.stringify([sub.id, keep])}`);
    // The kind lens applies on top of it: a withdrawn fragment is not a thread.
    expect((await keys("&background=true&kind=thread")).keys).not.toContain(`own:${gone}`);
    expect((await keys("&background=true&kind=fragment")).keys).toContain(`own:${gone}`);
  });
});
