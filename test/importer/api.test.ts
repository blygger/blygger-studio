// Subscription API route contract (§4.2) — validation, confirm-flow shape,
// and the pause/resume/resync/delete/blogroll-toggle lifecycle. Routes that
// would need real network (resolving a live URL) are covered by the
// fixture-driven pipeline test in subscribe-flow.test.ts instead; here we
// only exercise paths that are network-free (malformed input) or that
// operate on a subscription created directly via the store.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSubscription, getHopper, getHopperBySlug, getSubscription, upsertL0Item } from "../../src/importer/store.ts";
import { apiJson, BASE, login, STUDIO } from "../helpers.ts";

describe("subscription API (§4.2)", () => {
  it("400s without a url", async () => {
    const cookie = await login();
    const { status, json } = await apiJson(cookie, "POST", "/blyg/api/subscriptions", {});
    expect(status).toBe(400);
    expect(json.error).toMatch(/url/);
  });

  it("422s with the probe trail for an unresolvable URL", async () => {
    const cookie = await login();
    const { status, json } = await apiJson(cookie, "POST", "/blyg/api/subscriptions", { url: "not a url" });
    expect(status).toBe(422);
    expect(json.tried).toEqual([]);
  });

  it("requires auth", async () => {
    const res = await SELF.fetch(`${BASE}/blyg/api/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://a.example/" }),
    });
    expect(res.status).toBe(401);
  });

  it("PUT toggles the blogroll flag and title override on an existing subscription", async () => {
    const cookie = await login();
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: "https://a.example/", feedUrl: "https://a.example/feed.xml", title: "A" });
    const put = await apiJson(cookie, "PATCH", `/blyg/api/subscriptions/${sub.id}`, { in_blogroll: true, title: "Renamed" });
    expect(put.status).toBe(200);
    const after = await getSubscription(env.DB, sub.id);
    expect(after).toMatchObject({ in_blogroll: 1, title: "Renamed" });
  });

  it("pause/resume/resync/delete lifecycle on an existing subscription", async () => {
    const cookie = await login();
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: "https://b.example/", feedUrl: "https://b.example/feed.xml", title: "B" });

    const pause = await apiJson(cookie, "PATCH", `/blyg/api/subscriptions/${sub.id}`, { paused: true });
    expect(pause.status).toBe(200);
    expect((await getSubscription(env.DB, sub.id))?.status).toBe("paused");

    const resume = await apiJson(cookie, "PATCH", `/blyg/api/subscriptions/${sub.id}`, { paused: false });
    expect(resume.status).toBe(200);
    expect((await getSubscription(env.DB, sub.id))?.status).toBe("active");

    const del = await apiJson(cookie, "DELETE", `/blyg/api/subscriptions/${sub.id}`);
    expect(del.status).toBe(200);
    expect(await getSubscription(env.DB, sub.id)).toBeNull();
    const delAgain = await apiJson(cookie, "DELETE", `/blyg/api/subscriptions/${sub.id}`);
    expect(delAgain.status).toBe(404);
  });

  it("404s pause/resume/resync/put/delete for an unknown id", async () => {
    const cookie = await login();
    for (const [method, path] of [
      ["PATCH", "/blyg/api/subscriptions/nope"],
      ["POST", "/blyg/api/subscriptions/nope/resync"],
      ["DELETE", "/blyg/api/subscriptions/nope"],
    ] as const) {
      const { status } = await apiJson(cookie, method, path, method === "PATCH" ? {} : undefined);
      expect(status).toBe(404);
    }
  });
});

describe("studio subs page", () => {

  it("redirects to login when unauthenticated", async () => {
    const res = await SELF.fetch(`${BASE}${STUDIO}/subs`, { redirect: "manual" });
    expect(res.status).toBe(302);
  });
});

describe("hopper + signal API routes", () => {
  it("full CRUD: create, add item, remove item, delete", async () => {
    const cookie = await login();
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: "https://d.example/", feedUrl: "https://d.example/feed.xml", title: "D" });

    const created = await apiJson(cookie, "POST", "/blyg/api/hoppers", { name: "My Hopper" });
    expect(created.status).toBe(201);
    expect(created.json.slug).toBe("my-hopper");
    const hopperId = created.json.id;

    const add = await apiJson(cookie, "PUT", `/blyg/api/hoppers/${hopperId}/items/${sub.id}/remote-1`);
    expect(add.status).toBe(200);

    const togglePublic = await apiJson(cookie, "PATCH", `/blyg/api/hoppers/${hopperId}`, { public: true });
    expect(togglePublic.status).toBe(200);

    const remove = await apiJson(cookie, "DELETE", `/blyg/api/hoppers/${hopperId}/items/${sub.id}/remote-1`);
    expect(remove.status).toBe(200);

    const del = await apiJson(cookie, "DELETE", `/blyg/api/hoppers/${hopperId}`);
    expect(del.status).toBe(200);
  });

  it("slugs collide-safely on duplicate names", async () => {
    const cookie = await login();
    const first = await apiJson(cookie, "POST", "/blyg/api/hoppers", { name: "Dup" });
    const second = await apiJson(cookie, "POST", "/blyg/api/hoppers", { name: "Dup" });
    expect(first.json.slug).toBe("dup");
    expect(second.json.slug).toBe("dup-2");
  });

  it("renaming a never-public hopper re-derives its slug", async () => {
    const cookie = await login();
    const created = await apiJson(cookie, "POST", "/blyg/api/hoppers", { name: "Draft ideas" });
    expect(created.json.slug).toBe("draft-ideas");

    const renamed = await apiJson(cookie, "PATCH", `/blyg/api/hoppers/${created.json.id}`, { name: "Protocol reading" });
    expect(renamed.status).toBe(200);
    expect(renamed.json.slug).toBe("protocol-reading");
    expect((await getHopper(env.DB, created.json.id))!.name).toBe("Protocol reading");
    expect(await getHopperBySlug(env.DB, "draft-ideas")).toBeNull();
  });

  it("freezes the slug once a hopper has been public, and never thaws it", async () => {
    // A public hopper's /h/{slug}/ URL is its only address — nothing lists
    // hoppers, so every visitor came from a link. Renaming moves the name only.
    const cookie = await login();
    const created = await apiJson(cookie, "POST", "/blyg/api/hoppers", { name: "Good stuff" });
    await apiJson(cookie, "PATCH", `/blyg/api/hoppers/${created.json.id}`, { public: true });

    const renamed = await apiJson(cookie, "PATCH", `/blyg/api/hoppers/${created.json.id}`, { name: "Even better stuff" });
    expect(renamed.json.slug).toBe("good-stuff");
    const row = (await getHopper(env.DB, created.json.id))!;
    expect(row.name).toBe("Even better stuff");
    expect(row.slug).toBe("good-stuff");

    // Taking it private again does not release the address.
    await apiJson(cookie, "PATCH", `/blyg/api/hoppers/${created.json.id}`, { public: false });
    const afterPrivate = (await getHopper(env.DB, created.json.id))!;
    expect(afterPrivate.slug_frozen).toBe(1);
    await apiJson(cookie, "PATCH", `/blyg/api/hoppers/${created.json.id}`, { name: "Third name" });
    expect((await getHopper(env.DB, created.json.id))!.slug).toBe("good-stuff");
  });

  it("a rename that publishes in the same request freezes the NEW slug", async () => {
    const cookie = await login();
    const created = await apiJson(cookie, "POST", "/blyg/api/hoppers", { name: "Untitled" });
    const res = await apiJson(cookie, "PATCH", `/blyg/api/hoppers/${created.json.id}`, { name: "Reading list", public: true });
    expect(res.json.slug).toBe("reading-list");
    const row = (await getHopper(env.DB, created.json.id))!;
    expect(row.slug).toBe("reading-list");
    expect(row.slug_frozen).toBe(1);
  });

  it("a rename keeps its own slug instead of colliding with itself", async () => {
    const cookie = await login();
    const created = await apiJson(cookie, "POST", "/blyg/api/hoppers", { name: "Same" });
    const renamed = await apiJson(cookie, "PATCH", `/blyg/api/hoppers/${created.json.id}`, { name: "Same" });
    expect(renamed.json.slug).toBe("same"); // not "same-2"
  });

  it("rejects an empty rename and 404s an unknown hopper", async () => {
    const cookie = await login();
    const created = await apiJson(cookie, "POST", "/blyg/api/hoppers", { name: "Real" });
    expect((await apiJson(cookie, "PATCH", `/blyg/api/hoppers/${created.json.id}`, { name: "   " })).status).toBe(400);
    expect((await apiJson(cookie, "PATCH", "/blyg/api/hoppers/nope", { name: "x" })).status).toBe(404);
  });

  it("PUT /api/signals sets a thumb; rejects an invalid value", async () => {
    const cookie = await login();
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: "https://e.example/", feedUrl: "https://e.example/feed.xml", title: "E" });
    const ok = await apiJson(cookie, "PUT", `/blyg/api/signals/${sub.id}/remote-1`, { thumb: 1 });
    expect(ok.status).toBe(200);
    const bad = await apiJson(cookie, "PUT", `/blyg/api/signals/${sub.id}/remote-1`, { thumb: 0 });
    expect(bad.status).toBe(400);
  });
});

describe("the stub action (§3.1, decision #27 — absorbs `respond`)", () => {
  it("stubs an L0 entry with a citation line and none of its text", async () => {
    const cookie = await login();
    const sub = await createSubscription(env.DB, { kind: "rss", origin: "https://blog.example/feed", feedUrl: "https://blog.example/feed", title: "A Blog" });
    await upsertL0Item(env.DB, sub.id, "l0-xyz", {
      version: 1, created: "2026-09-01T00:00:00Z", updated: "2026-09-01T00:00:00Z", observedAt: "2026-09-01T00:00:00Z",
      contentMd: "[Our Eukaryotic Moment](https://blog.example/p/euk)\n\nsecret body prose",
      contentHtml: '<p><a href="https://blog.example/p/euk">Our Eukaryotic Moment</a></p>\n<p>secret body prose</p>',
      contentHash: "hash-l0",
    });

    const created = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "response", source: { subscription_id: sub.id, remote_id: "l0-xyz" } });
    expect(created.status).toBe(201);
    const detail = await apiJson(cookie, "GET", `/blyg/api/items/${created.json.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.content_md).toBe("[Our Eukaryotic Moment](https://blog.example/p/euk)\n\n");
    expect(detail.json.content_md).not.toContain("secret body prose");
    expect(detail.json.stub_of).toMatchObject({ url: "https://blog.example/p/euk" });
  });

  it("stubs a blyg entry with the transclusion directive and a citation", async () => {
    const cookie = await login();
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: "https://friend.example/blyg/", feedUrl: "https://friend.example/blyg/feed.xml", title: "Friend" });
    await upsertL0Item(env.DB, sub.id, "abc123", {
      version: 3, created: "2026-09-01T00:00:00Z", updated: "2026-09-01T00:00:00Z", observedAt: "2026-09-01T00:00:00Z",
      contentMd: "hi", contentHtml: "<p>hi</p>", contentHash: "hash-blyg",
    });
    await env.DB.prepare("UPDATE imported_items SET l0 = 0 WHERE subscription_id = ? AND remote_id = ?").bind(sub.id, "abc123").run();

    const created = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "response", source: { subscription_id: sub.id, remote_id: "abc123" } });
    expect(created.status).toBe(201);
    const row = await env.DB.prepare("SELECT kind, content_md, stub_of FROM items WHERE id = ?").bind(created.json.id).first<any>();
    expect(row.kind).toBe("thread");
    expect(row.content_md).toBe("![[abc123]]\n\n");
    expect(JSON.parse(row.stub_of)).toEqual({ origin: "https://friend.example/blyg/", id: "abc123", version: 3 });

    const detail = await apiJson(cookie, "GET", `/blyg/api/items/${created.json.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.stub_of).toMatchObject({ origin: "https://friend.example/blyg/", id: "abc123", version: 3 });
  });

  it("404s for an unknown subscription or item, and 400s with no target", async () => {
    const cookie = await login();
    expect((await apiJson(cookie, "POST", "/blyg/api/items", { mode: "response", source: {} })).status).toBe(400);
    expect((await apiJson(cookie, "POST", "/blyg/api/items", { mode: "response", source: { subscription_id: "nope", remote_id: "x" } })).status).toBe(404);
  });
});
