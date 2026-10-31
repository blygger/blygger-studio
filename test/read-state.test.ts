// The owner's read state for imported items (migration 0026): PUT
// /reading/{sub}/{remoteId}/read, POST /reading/read, and readVersion with the
// read_state flag on GET /reading. Clients that sync read state across devices
// depend on three things pinned here: the write shapes, 200 (never 404) for a
// row this server does not hold, and the advertised flag.
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createOwnerApi } from "../src/owner-api.ts";
import { makeApp } from "../src/index.ts";
import { READ_BATCH_MAX } from "../src/importer/read-state.ts";
import { BASE, STUDIO, apiJson, getPublic, login } from "./helpers.ts";

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

async function readState(sub: string, remote: string): Promise<number | null> {
  const r = await db()
    .prepare("SELECT read_version FROM read_state WHERE subscription_id = ? AND remote_id = ?")
    .bind(sub, remote)
    .first<{ read_version: number }>();
  return r ? r.read_version : null;
}

async function readingEntry(cookie: string, sub: string, remote: string) {
  const { status, json } = await apiJson(cookie, "GET", `/blyg/api/reading?sub=${sub}&limit=50`);
  expect(status).toBe(200);
  return (json.items as any[]).find((e) => e.imported?.remoteId === remote)?.imported;
}

describe("read state", () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = await login();
    await seedSub("rsA");
    await seedSub("rsB");
    await seedItem("rsA", "a1", 3);
    await seedItem("rsA", "a2", 1);
    await seedItem("rsA", "a/slash", 1);
    await seedItem("rsB", "b1", 2);
    await seedItem("rsB", "b2", 2);
    await seedSub("rsGone");
    await seedItem("rsGone", "g1", 1);
  });

  it("requires owner auth on both writes", async () => {
    expect((await apiJson("", "PUT", "/blyg/api/reading/rsA/a1/read", { version: 1 })).status).toBe(401);
    expect((await apiJson("", "POST", "/blyg/api/reading/read", { items: [] })).status).toBe(401);
    expect(await readState("rsA", "a1")).toBeNull();
  });

  it("GET /reading advertises read_state, and readVersion is null until read", async () => {
    const { status, json } = await apiJson(cookie, "GET", "/blyg/api/reading?limit=50");
    expect(status).toBe(200);
    expect(json.read_state).toBe(true);
    const imported = (json.items as any[]).filter((e) => e.source === "imported");
    expect(imported.length).toBeGreaterThan(0);
    for (const e of imported) expect(e.imported.readVersion).toBeNull();
  });

  it("PUT stores, is idempotent, and never lowers", async () => {
    let r = await apiJson(cookie, "PUT", "/blyg/api/reading/rsA/a1/read", { version: 2 });
    expect(r).toEqual({ status: 200, json: { ok: true, stored: true, read_version: 2 } });
    r = await apiJson(cookie, "PUT", "/blyg/api/reading/rsA/a1/read", { version: 2 });
    expect(r.json.read_version).toBe(2);
    r = await apiJson(cookie, "PUT", "/blyg/api/reading/rsA/a1/read", { version: 1 });
    expect(r).toEqual({ status: 200, json: { ok: true, stored: true, read_version: 2 } });
    r = await apiJson(cookie, "PUT", "/blyg/api/reading/rsA/a1/read", { version: 3 });
    expect(r.json.read_version).toBe(3);
    expect(await readState("rsA", "a1")).toBe(3);
    expect((await readingEntry(cookie, "rsA", "a1")).readVersion).toBe(3);
    expect((await readingEntry(cookie, "rsA", "a2")).readVersion).toBeNull();
  });

  it("moves `updated` only when the stored version rises", async () => {
    const at = () => db().prepare("SELECT updated FROM read_state WHERE subscription_id = 'rsA' AND remote_id = 'a1'").first<{ updated: string }>();
    await db().prepare("UPDATE read_state SET updated = 'pinned' WHERE subscription_id = 'rsA' AND remote_id = 'a1'").run();
    await apiJson(cookie, "PUT", "/blyg/api/reading/rsA/a1/read", { version: 1 });
    await apiJson(cookie, "PUT", "/blyg/api/reading/rsA/a1/read", { version: 3 });
    expect((await at())!.updated).toBe("pinned");
    await apiJson(cookie, "PUT", "/blyg/api/reading/rsA/a1/read", { version: 4 });
    expect((await at())!.updated).not.toBe("pinned");
  });

  it("PUT decodes an escaped remote id", async () => {
    const r = await apiJson(cookie, "PUT", `/blyg/api/reading/rsA/${encodeURIComponent("a/slash")}/read`, { version: 1 });
    expect(r.json).toMatchObject({ stored: true, read_version: 1 });
    expect(await readState("rsA", "a/slash")).toBe(1);
  });

  it("PUT for an unknown item or subscription is acknowledged, not stored, never 404", async () => {
    for (const p of ["/blyg/api/reading/rsA/nope/read", "/blyg/api/reading/nosub/a1/read"]) {
      const r = await apiJson(cookie, "PUT", p, { version: 1 });
      expect(r).toEqual({ status: 200, json: { ok: true, stored: false, read_version: null } });
    }
    expect(await readState("rsA", "nope")).toBeNull();
    expect(await readState("nosub", "a1")).toBeNull();
  });

  it("PUT validates the body and the ids", async () => {
    for (const body of [{}, { version: 0 }, { version: -1 }, { version: 1.5 }, { version: "2" }, { version: 2 ** 33 }, { version: 1, extra: true }, []]) {
      expect((await apiJson(cookie, "PUT", "/blyg/api/reading/rsA/a2/read", body)).status, JSON.stringify(body)).toBe(400);
    }
    const ctx = createExecutionContext();
    const raw = await makeApp("/blyg").fetch(new Request(`${BASE}/blyg/api/reading/rsA/a2/read`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: "not json" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(raw.status).toBe(400);
    expect((await apiJson(cookie, "PUT", `/blyg/api/reading/rsA/${"x".repeat(1025)}/read`, { version: 1 })).status).toBe(400);
    expect(await readState("rsA", "a2")).toBeNull();
  });

  it("POST batch stores the max per row, skips unknown rows, and is all-or-nothing on bad input", async () => {
    let r = await apiJson(cookie, "POST", "/blyg/api/reading/read", {
      items: [
        { sub: "rsB", remote_id: "b1", version: 2 },
        { sub: "rsB", remote_id: "b2", version: 1 },
        { sub: "rsB", remote_id: "b2", version: 2 },
        { sub: "rsB", remote_id: "b2", version: 1 },
        { sub: "rsA", remote_id: "a1", version: 1 }, // lower than the stored value
        { sub: "rsZ", remote_id: "zz", version: 1 }, // unknown: skipped
      ],
    });
    expect(r).toEqual({ status: 200, json: { ok: true, received: 6 } });
    expect(await readState("rsB", "b1")).toBe(2);
    expect(await readState("rsB", "b2")).toBe(2);
    expect(await readState("rsA", "a1")).toBe(4);
    expect(await readState("rsZ", "zz")).toBeNull();

    r = await apiJson(cookie, "POST", "/blyg/api/reading/read", {
      items: [
        { sub: "rsA", remote_id: "a2", version: 1 },
        { sub: "rsA", remote_id: "a2", version: "x" },
      ],
    });
    expect(r.status).toBe(400);
    // The failing entry is named by its index in the list.
    expect(r.json.issues).toEqual([expect.objectContaining({ path: ["items", 1, "version"] })]);
    expect(await readState("rsA", "a2")).toBeNull();

    expect((await apiJson(cookie, "POST", "/blyg/api/reading/read", { items: [] })).json).toEqual({ ok: true, received: 0 });
    expect((await apiJson(cookie, "POST", "/blyg/api/reading/read", {})).status).toBe(400);
    expect((await apiJson(cookie, "POST", "/blyg/api/reading/read", { items: [null] })).status).toBe(400);
  });

  it("version 0 is refused on both routes: items start at version 1", async () => {
    expect((await apiJson(cookie, "PUT", "/blyg/api/reading/rsA/a2/read", { version: 0 })).status).toBe(400);
    const r = await apiJson(cookie, "POST", "/blyg/api/reading/read", { items: [{ sub: "rsA", remote_id: "a2", version: 0 }] });
    expect(r.status).toBe(400);
    expect(r.json.issues).toEqual([expect.objectContaining({ path: ["items", 0, "version"] })]);
    expect(await readState("rsA", "a2")).toBeNull();
  });

  it(`POST batch takes at most ${READ_BATCH_MAX} items`, async () => {
    const items = Array.from({ length: READ_BATCH_MAX + 1 }, () => ({ sub: "rsA", remote_id: "a2", version: 1 }));
    expect((await apiJson(cookie, "POST", "/blyg/api/reading/read", { items })).status).toBe(400);
    expect(await readState("rsA", "a2")).toBeNull();
    const r = await apiJson(cookie, "POST", "/blyg/api/reading/read", { items: items.slice(0, READ_BATCH_MAX) });
    expect(r).toEqual({ status: 200, json: { ok: true, received: READ_BATCH_MAX } });
    expect(await readState("rsA", "a2")).toBe(1);
  });

  it("goes with the import and with the subscription", async () => {
    await apiJson(cookie, "PUT", "/blyg/api/reading/rsGone/g1/read", { version: 1 });
    expect(await readState("rsGone", "g1")).toBe(1);
    expect((await apiJson(cookie, "DELETE", "/blyg/api/subscriptions/rsGone")).status).toBe(200);
    expect(await readState("rsGone", "g1")).toBeNull();
    // A subscription row deleted directly takes its read state too.
    await seedSub("rsDirect");
    await seedItem("rsDirect", "d1", 1);
    await apiJson(cookie, "PUT", "/blyg/api/reading/rsDirect/d1/read", { version: 1 });
    await db().prepare("DELETE FROM subscriptions WHERE id = 'rsDirect'").run();
    expect(await readState("rsDirect", "d1")).toBeNull();
    // An import deleted on its own takes only its own row.
    expect(await readState("rsA", "a2")).toBe(1);
    await db().prepare("DELETE FROM imported_items WHERE subscription_id = 'rsA' AND remote_id = 'a2'").run();
    expect(await readState("rsA", "a2")).toBeNull();
    expect(await readState("rsA", "a1")).toBe(4);
  });

  it("never appears on the public surface", async () => {
    for (const p of ["/blyg/blyg.json", "/blyg/feed.xml", "/blyg/items/index.json"]) {
      const text = await (await getPublic(p)).text();
      expect(text).not.toContain("read_version");
      expect(text).not.toContain("readVersion");
    }
  });
});

describe("read state permissions and budget", () => {
  async function delegated(scope: string[], method: string, path: string, body: unknown) {
    const app = new Hono().route("/api", createOwnerApi({ scope, clientId: "read-state", userId: "owner" }));
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${BASE}/api${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("marking read needs reading:state; owner:manage and the other owner scopes are refused", async () => {
    await seedSub("rsScope");
    await seedItem("rsScope", "s1", 1);
    for (const scope of [[], ["owner:read"], ["owner:read", "owner:draft", "owner:publish", "owner:manage"]]) {
      const put = await delegated(scope, "PUT", "/reading/rsScope/s1/read", { version: 1 });
      expect(put.status, scope.join(" ")).toBe(403);
      expect(put.headers.get("www-authenticate")).toContain("insufficient_scope");
      expect((await delegated(scope, "POST", "/reading/read", { items: [{ sub: "rsScope", remote_id: "s1", version: 1 }] })).status).toBe(403);
    }
    expect(await readState("rsScope", "s1")).toBeNull();
    const put = await delegated(["reading:state"], "PUT", "/reading/rsScope/s1/read", { version: 1 });
    expect(await put.json()).toEqual({ ok: true, stored: true, read_version: 1 });
  });

  it(`a ${READ_BATCH_MAX}-row batch spends one unit of the write budget`, async () => {
    await seedSub("rsBudget");
    await seedItem("rsBudget", "x", 1);
    const app = makeApp("/blyg");
    const bindings = { ...env, API_WRITE_LIMIT: "2", API_READ_LIMIT: "100000" };
    const call = async (path: string, init: RequestInit = {}) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(BASE + path, init), bindings, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    await db().prepare("DELETE FROM security_budgets WHERE key = 'api-write:owner'").run();
    const login = await call(STUDIO + "/login", { method: "POST", redirect: "manual", headers: { "CF-Connecting-IP": "2001:db8:5ead::1" }, body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
    const owner = login.headers.get("set-cookie")!.split(";")[0];
    const items = Array.from({ length: READ_BATCH_MAX }, (_, i) => ({ sub: "rsBudget", remote_id: "x", version: i + 1 }));
    const post = () => call("/blyg/api/reading/read", { method: "POST", headers: { cookie: owner, "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    expect([(await post()).status, (await post()).status, (await post()).status]).toEqual([200, 200, 429]);
    expect(await readState("rsBudget", "x")).toBe(READ_BATCH_MAX);
  });
});
