// Clearing read state (migration 0026): DELETE /reading/{sub}/{remoteId}/read,
// POST /reading/unread, the unread_at tombstone that read_at is checked
// against, and the read_state_clear flag. The shapes here were agreed with an
// external client (Blygger Desktop); change them only with it.
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createOwnerApi } from "../src/owner-api.ts";
import { makeApp } from "../src/index.ts";
import { READ_BATCH_MAX } from "../src/importer/read-state.ts";
import { BASE, STUDIO, apiJson, login } from "./helpers.ts";

const db = () => env.DB;

async function seedSub(id: string) {
  await db()
    .prepare("INSERT INTO subscriptions (id, kind, origin, feed_url, title, created) VALUES (?, 'blyg', ?, ?, ?, '2026-01-01T00:00:00.000Z')")
    .bind(id, `https://${id}.example/`, `https://${id}.example/feed.xml`, id)
    .run();
}

async function seedItem(sub: string, remote: string, version = 1) {
  await db()
    .prepare(
      `INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html)
       VALUES (?, ?, 'fragment', 'current', ?, '2026-03-01T00:00:00.000Z', 'md', '<p>html</p>')`,
    )
    .bind(sub, remote, version)
    .run();
}

async function row(sub: string, remote: string) {
  return db()
    .prepare("SELECT read_version, unread_at FROM read_state WHERE subscription_id = ? AND remote_id = ?")
    .bind(sub, remote)
    .first<{ read_version: number | null; unread_at: string | null }>();
}

async function readingVersion(cookie: string, sub: string, remote: string) {
  const { status, json } = await apiJson(cookie, "GET", `/blyg/api/reading?sub=${sub}&limit=50`);
  expect(status).toBe(200);
  return (json.items as any[]).find((e) => e.imported?.remoteId === remote)?.imported.readVersion;
}

async function readingRevision(cookie: string): Promise<number> {
  const { status, json } = await apiJson(cookie, "GET", "/blyg/api/changes");
  expect(status).toBe(200);
  return json.domains.reading;
}

const PAST = "2000-01-01T00:00:00Z";
const FUTURE = "2999-01-01T00:00:00Z";

describe("clearing read state", () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = await login();
    await seedSub("rcA");
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c/slash"]) await seedItem("rcA", id, 3);
    await seedSub("rcB");
    await seedItem("rcB", "b1", 1);
    await seedItem("rcB", "b2", 1);
  });

  it("GET /reading advertises read_state_clear beside read_state", async () => {
    const { json } = await apiJson(cookie, "GET", "/blyg/api/reading?limit=1");
    expect(json.readState).toBe(true);
    expect(json.readStateClear).toBe(true);
  });

  it("Reading entries carry the held version beside readVersion, so 'updated since read' is visible", async () => {
    const { json } = await apiJson(cookie, "GET", "/blyg/api/reading?sub=rcA&limit=50");
    const entry = (json.items as any[]).find((e) => e.imported?.remoteId === "c1").imported;
    expect(entry).toMatchObject({ version: 3, readVersion: null });
  });

  it("DELETE clears to null on Reading and answers the agreed body, idempotently", async () => {
    await apiJson(cookie, "PUT", "/blyg/api/reading/rcA/c1/read", { version: 3 });
    expect(await readingVersion(cookie, "rcA", "c1")).toBe(3);
    for (let i = 0; i < 2; i++) {
      const r = await apiJson(cookie, "DELETE", "/blyg/api/reading/rcA/c1/read");
      expect(r).toEqual({ status: 200, json: { ok: true, stored: false, readVersion: null } });
    }
    expect(await readingVersion(cookie, "rcA", "c1")).toBeNull();
    const held = await row("rcA", "c1");
    expect(held!.read_version).toBeNull();
    expect(new Date(held!.unread_at!).toISOString()).toBe(held!.unread_at);
  });

  it("DELETE for an unknown subscription or item is 200, stores nothing, never 404", async () => {
    for (const p of ["/blyg/api/reading/rcA/nope/read", "/blyg/api/reading/nosub/c1/read"]) {
      expect(await apiJson(cookie, "DELETE", p)).toEqual({ status: 200, json: { ok: true, stored: false, readVersion: null } });
    }
    expect(await row("rcA", "nope")).toBeNull();
    expect(await row("nosub", "c1")).toBeNull();
    expect((await apiJson(cookie, "DELETE", `/blyg/api/reading/rcA/${"x".repeat(1025)}/read`)).status).toBe(400);
  });

  it("DELETE decodes an escaped remote id", async () => {
    await apiJson(cookie, "PUT", `/blyg/api/reading/rcA/${encodeURIComponent("c/slash")}/read`, { version: 1 });
    await apiJson(cookie, "DELETE", `/blyg/api/reading/rcA/${encodeURIComponent("c/slash")}/read`);
    expect((await row("rcA", "c/slash"))!.read_version).toBeNull();
  });

  it("after a clear, the next read stores its own version, not the max with the pre-clear value", async () => {
    await apiJson(cookie, "PUT", "/blyg/api/reading/rcA/c2/read", { version: 3 });
    await apiJson(cookie, "DELETE", "/blyg/api/reading/rcA/c2/read");
    const r = await apiJson(cookie, "PUT", "/blyg/api/reading/rcA/c2/read", { version: 2 });
    expect(r.json).toEqual({ ok: true, stored: true, readVersion: 2 });
    // ...and from there it is monotonic again.
    expect((await apiJson(cookie, "PUT", "/blyg/api/reading/rcA/c2/read", { version: 1 })).json.readVersion).toBe(2);
  });

  it("tombstone: a read from before the clear is ignored, a later one applies, one without read_at applies", async () => {
    await apiJson(cookie, "PUT", "/blyg/api/reading/rcA/c3/read", { version: 2 });
    await apiJson(cookie, "DELETE", "/blyg/api/reading/rcA/c3/read");
    const stale = await apiJson(cookie, "PUT", "/blyg/api/reading/rcA/c3/read", { version: 3, readAt: PAST });
    expect(stale).toEqual({ status: 200, json: { ok: true, stored: false, readVersion: null } });
    expect(await readingVersion(cookie, "rcA", "c3")).toBeNull();

    const fresh = await apiJson(cookie, "PUT", "/blyg/api/reading/rcA/c3/read", { version: 2, readAt: FUTURE });
    expect(fresh.json).toEqual({ ok: true, stored: true, readVersion: 2 });

    // The watermark outlives the read that followed it: another stale read
    // is still refused, and reports what is held.
    const stillStale = await apiJson(cookie, "PUT", "/blyg/api/reading/rcA/c3/read", { version: 3, readAt: PAST });
    expect(stillStale.json).toEqual({ ok: true, stored: false, readVersion: 2 });

    await apiJson(cookie, "DELETE", "/blyg/api/reading/rcA/c3/read");
    const bare = await apiJson(cookie, "PUT", "/blyg/api/reading/rcA/c3/read", { version: 3 });
    expect(bare.json).toEqual({ ok: true, stored: true, readVersion: 3 });
  });

  it("compares read_at as an instant, whatever offset it is written in", async () => {
    await apiJson(cookie, "DELETE", "/blyg/api/reading/rcA/c4/read");
    const unreadAt = (await row("rcA", "c4"))!.unread_at!;
    const ms = Date.parse(unreadAt);
    // One second before the clear, written in +05:30: the string sorts after
    // the stored UTC value, but the instant is earlier.
    const before = new Date(ms - 1000 + 5.5 * 3600_000).toISOString().replace("Z", "+05:30");
    expect(before > unreadAt).toBe(true);
    expect((await apiJson(cookie, "PUT", "/blyg/api/reading/rcA/c4/read", { version: 1, readAt: before })).json.stored).toBe(false);
    const after = new Date(ms + 1000 - 8 * 3600_000).toISOString().replace("Z", "-08:00");
    expect((await apiJson(cookie, "PUT", "/blyg/api/reading/rcA/c4/read", { version: 1, readAt: after })).json).toEqual({ ok: true, stored: true, readVersion: 1 });
  });

  it("clearing a held item never read still leaves a tombstone", async () => {
    expect(await row("rcA", "c5")).toBeNull();
    await apiJson(cookie, "DELETE", "/blyg/api/reading/rcA/c5/read");
    expect((await row("rcA", "c5"))!.unread_at).not.toBeNull();
    expect((await apiJson(cookie, "PUT", "/blyg/api/reading/rcA/c5/read", { version: 1, readAt: PAST })).json.stored).toBe(false);
    expect(await readingVersion(cookie, "rcA", "c5")).toBeNull();
  });

  it("read_at must be a real ISO-8601 timestamp, on PUT and in the batch", async () => {
    for (const read_at of ["yesterday", "2026-10-06", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", 1, null]) {
      expect((await apiJson(cookie, "PUT", "/blyg/api/reading/rcB/b1/read", { version: 1, readAt: read_at })).status, String(read_at)).toBe(400);
      const batch = await apiJson(cookie, "POST", "/blyg/api/reading/read", { items: [{ sub: "rcB", remoteId: "b1", version: 1 }, { sub: "rcB", remoteId: "b1", version: 1, readAt: read_at }] });
      expect(batch.status).toBe(400);
      expect(batch.json.details.issues).toEqual([expect.objectContaining({ path: ["items", 1, "readAt"] })]);
    }
    expect(await row("rcB", "b1")).toBeNull();
  });

  it("the read batch applies read_at per row against each row's tombstone", async () => {
    await apiJson(cookie, "PUT", "/blyg/api/reading/rcB/b1/read", { version: 1 });
    await apiJson(cookie, "PUT", "/blyg/api/reading/rcB/b2/read", { version: 1 });
    await apiJson(cookie, "POST", "/blyg/api/reading/unread", { items: [{ sub: "rcB", remoteId: "b1" }, { sub: "rcB", remoteId: "b2" }] });
    const r = await apiJson(cookie, "POST", "/blyg/api/reading/read", {
      items: [
        { sub: "rcB", remoteId: "b1", version: 1, readAt: PAST }, // before the clear: skipped
        { sub: "rcB", remoteId: "b2", version: 1, readAt: FUTURE },
      ],
    });
    expect(r).toEqual({ status: 200, json: { ok: true, received: 2 } });
    expect(await readingVersion(cookie, "rcB", "b1")).toBeNull();
    expect(await readingVersion(cookie, "rcB", "b2")).toBe(1);
  });

  it("POST /unread clears many, skips unknown rows, and is all-or-nothing on bad input", async () => {
    await apiJson(cookie, "POST", "/blyg/api/reading/read", { items: [{ sub: "rcB", remoteId: "b1", version: 1 }, { sub: "rcB", remoteId: "b2", version: 1 }] });
    let r = await apiJson(cookie, "POST", "/blyg/api/reading/unread", { items: [{ sub: "rcB", remoteId: "b1" }, { sub: "rcZ", remoteId: "zz" }] });
    expect(r).toEqual({ status: 200, json: { ok: true, received: 2 } });
    expect(await readingVersion(cookie, "rcB", "b1")).toBeNull();
    expect(await readingVersion(cookie, "rcB", "b2")).toBe(1);
    expect(await row("rcZ", "zz")).toBeNull();

    for (const items of [[{ sub: "rcB", remoteId: "b2" }, { sub: "rcB" }], [{ sub: "rcB", remoteId: "b2" }, { sub: "rcB", remoteId: "b2", version: 1 }], [null]]) {
      r = await apiJson(cookie, "POST", "/blyg/api/reading/unread", { items });
      expect(r.status, JSON.stringify(items)).toBe(400);
    }
    expect(await readingVersion(cookie, "rcB", "b2")).toBe(1);
    expect((await apiJson(cookie, "POST", "/blyg/api/reading/unread", {})).status).toBe(400);
    expect((await apiJson(cookie, "POST", "/blyg/api/reading/unread", { items: [] })).json).toEqual({ ok: true, received: 0 });
  });

  it(`POST /unread takes at most ${READ_BATCH_MAX} items`, async () => {
    const items = Array.from({ length: READ_BATCH_MAX + 1 }, () => ({ sub: "rcB", remoteId: "b2" }));
    expect((await apiJson(cookie, "POST", "/blyg/api/reading/unread", { items })).status).toBe(400);
    expect(await readingVersion(cookie, "rcB", "b2")).toBe(1);
    expect((await apiJson(cookie, "POST", "/blyg/api/reading/unread", { items: items.slice(0, READ_BATCH_MAX) })).json).toEqual({ ok: true, received: READ_BATCH_MAX });
    expect(await readingVersion(cookie, "rcB", "b2")).toBeNull();
  });

  it("a clear advances the reading revision; an ignored stale read advances nothing", async () => {
    await seedSub("rcRev");
    await seedItem("rcRev", "r1", 2);
    await apiJson(cookie, "PUT", "/blyg/api/reading/rcRev/r1/read", { version: 2 });
    const before = await apiJson(cookie, "GET", "/blyg/api/changes");
    await apiJson(cookie, "DELETE", "/blyg/api/reading/rcRev/r1/read");
    const cleared = await apiJson(cookie, "GET", "/blyg/api/changes");
    expect(cleared.json.domains.reading).toBeGreaterThan(before.json.domains.reading);
    for (const d of Object.keys(before.json.domains)) if (d !== "reading") expect(cleared.json.domains[d], d).toBe(before.json.domains[d]);

    await apiJson(cookie, "PUT", "/blyg/api/reading/rcRev/r1/read", { version: 2, readAt: PAST });
    await apiJson(cookie, "POST", "/blyg/api/reading/read", { items: [{ sub: "rcRev", remoteId: "r1", version: 2, readAt: PAST }] });
    expect((await apiJson(cookie, "GET", "/blyg/api/changes")).json).toEqual(cleared.json);

    // A clear of something unknown changes nothing either.
    await apiJson(cookie, "DELETE", "/blyg/api/reading/rcRev/unknown/read");
    expect(await readingRevision(cookie)).toBe(cleared.json.domains.reading);
  });

  it("cascades hold for cleared rows too: read state still goes with its import and its subscription", async () => {
    await seedSub("rcGone");
    await seedItem("rcGone", "g1", 1);
    await seedItem("rcGone", "g2", 1);
    await apiJson(cookie, "PUT", "/blyg/api/reading/rcGone/g1/read", { version: 1 });
    await apiJson(cookie, "DELETE", "/blyg/api/reading/rcGone/g2/read");
    await db().prepare("DELETE FROM imported_items WHERE subscription_id = 'rcGone' AND remote_id = 'g1'").run();
    expect(await row("rcGone", "g1")).toBeNull();
    expect(await row("rcGone", "g2")).not.toBeNull();
    await db().prepare("DELETE FROM subscriptions WHERE id = 'rcGone'").run();
    expect(await row("rcGone", "g2")).toBeNull();
    const triggers = await db().prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name = 'read_state' OR sql LIKE '%read_state%') ORDER BY name").all<{ name: string }>();
    expect(triggers.results.map((t) => t.name)).toEqual([
      "change_read_state_delete",
      "change_read_state_insert",
      "change_read_state_update",
      "read_state_after_import_delete",
      "read_state_after_subscription_delete",
    ]);
  });
});

describe("clearing read state: permissions and budget", () => {
  async function delegated(scope: string[], method: string, path: string, body?: unknown) {
    const app = new Hono().route("/api", createOwnerApi({ scope, clientId: "read-state-clear", userId: "owner" }));
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${BASE}/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("clearing needs reading:state; owner:manage and the other owner scopes are refused", async () => {
    await seedSub("rcScope");
    await seedItem("rcScope", "s1", 1);
    await delegated(["reading:state"], "PUT", "/reading/rcScope/s1/read", { version: 1 });
    for (const scope of [[], ["owner:read"], ["owner:read", "owner:draft", "owner:publish", "owner:manage"]]) {
      const del = await delegated(scope, "DELETE", "/reading/rcScope/s1/read");
      expect(del.status, scope.join(" ")).toBe(403);
      expect(del.headers.get("www-authenticate")).toContain("insufficient_scope");
      expect((await delegated(scope, "POST", "/reading/unread", { items: [{ sub: "rcScope", remoteId: "s1" }] })).status).toBe(403);
    }
    expect((await row("rcScope", "s1"))!.read_version).toBe(1);
    const del = await delegated(["reading:state"], "DELETE", "/reading/rcScope/s1/read");
    expect(await del.json()).toEqual({ ok: true, stored: false, readVersion: null });
    expect((await row("rcScope", "s1"))!.read_version).toBeNull();
  });

  it(`a ${READ_BATCH_MAX}-row unread batch spends one unit of the write budget`, async () => {
    await seedSub("rcBudget");
    await seedItem("rcBudget", "x", 1);
    const app = makeApp("/blyg");
    const bindings = { ...env, API_WRITE_LIMIT: "2", API_READ_LIMIT: "100000" };
    const call = async (path: string, init: RequestInit = {}) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(BASE + path, init), bindings, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    await db().prepare("DELETE FROM security_budgets WHERE key = 'api-write:owner'").run();
    const res = await call(STUDIO + "/login", { method: "POST", redirect: "manual", headers: { "CF-Connecting-IP": "2001:db8:5ead::2" }, body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
    const owner = res.headers.get("set-cookie")!.split(";")[0];
    const items = Array.from({ length: READ_BATCH_MAX }, () => ({ sub: "rcBudget", remoteId: "x" }));
    const post = () => call("/blyg/api/reading/unread", { method: "POST", headers: { cookie: owner, "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    expect([(await post()).status, (await post()).status, (await post()).status]).toEqual([200, 200, 429]);
  });
});
