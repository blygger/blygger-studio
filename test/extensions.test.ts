// Studio extensions, server side (docs/extensions.md). What these pin:
//   1. Every extension starts disabled, and Settings only turns on one this
//      build carries.
//   2. An extension's routes sit behind the owner API's own middleware —
//      session or token, scope, CORS policy, work budget — and answer 404 on a
//      node that has not enabled the extension.
//   3. An extension can add owner reads only: GET, under /api/ext/<name>/,
//      classified owner:read. Anything else is refused when it registers.
//   4. The suite compiles in every extension in the repository.
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "@hono/zod-openapi";
import { apiJson, login } from "./helpers.ts";
import { createOwnerApi } from "../src/owner-api.ts";
import { extensionApi, type ServerExtension } from "../src/extensions/server.ts";
import { extensionRoute } from "../src/extensions/contract.ts";
import { parseEnabledExtensions } from "../src/extensions/names.ts";
import { putSettings } from "../src/model.ts";
import { routes } from "../src/contract/routes.ts";
import { operationScopes } from "../src/permissions.ts";
import { EXTENSIONS, extensionRoutes } from "../extensions/catalog.ts";
import { compiledServerExtensions } from "../build/extensions.server.ts";

const probe = extensionRoute("probe", "status", "/status", z.object({ extension: z.string(), owner: z.boolean() }), z.object({ echo: z.string().optional() }));
const fixture: ServerExtension = {
  name: "probe",
  routes(router) {
    router.get(probe, (c) => c.json({ extension: "probe", owner: true, ...(c.req.query("echo") ? { echo: c.req.query("echo") } : {}) }, 200));
  },
};
const enable = (names: string[]) => putSettings(env.DB, { extensions: JSON.stringify(names) });
async function receive(app: Hono<any>, path: string, init: RequestInit = {}, limits: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request("https://example.com/api" + path, init), { ...env, API_READ_LIMIT: "10000", API_WRITE_LIMIT: "10000", API_DELEGATED_READ_LIMIT: "10000", API_DELEGATED_WRITE_LIMIT: "10000", ...limits }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const ownerApp = () => new Hono().route("/api", createOwnerApi(undefined, [fixture]));
const delegatedApp = (scope: string[], grantId = crypto.randomUUID()) => new Hono().route("/api", createOwnerApi({ scope, clientId: "extension-test", userId: "owner", grantId }, [fixture]));

describe("the per-node setting", () => {
  it("starts with every extension disabled", async () => {
    await enable([]);
    const cookie = await login();
    const got = await apiJson(cookie, "GET", "/api/settings");
    expect(got.json.extensions).toEqual([]);
  });

  it("turns on only extensions compiled into this build, deduped and sorted", async () => {
    const cookie = await login();
    expect(EXTENSIONS).toContain("example");
    const on = await apiJson(cookie, "PATCH", "/api/settings", { extensions: ["example", "example"] });
    expect(on.status).toBe(200);
    expect(on.json.extensions).toEqual(["example"]);
    const unknown = await apiJson(cookie, "PATCH", "/api/settings", { extensions: ["example", "not-compiled"] });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toContain("not-compiled");
    expect((await apiJson(cookie, "GET", "/api/settings")).json.extensions).toEqual(["example"]);
    expect((await apiJson(cookie, "PATCH", "/api/settings", { extensions: [] })).json.extensions).toEqual([]);
  });

  it("reads a malformed stored value as nothing enabled", () => {
    expect(parseEnabledExtensions(undefined)).toEqual([]);
    expect(parseEnabledExtensions("not json")).toEqual([]);
    expect(parseEnabledExtensions('{"example":true}')).toEqual([]);
    expect(parseEnabledExtensions('["b-ext","a-ext",3,"Bad Name","a-ext"]')).toEqual(["a-ext", "b-ext"]);
  });
});

describe("extension routes behind the owner API", () => {
  it("answer 404 until the extension is enabled on this node", async () => {
    await enable([]);
    const cookie = await login();
    const off = await receive(ownerApp(), "/ext/probe/status", { headers: { cookie } });
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: "extension probe is not enabled" });
    await enable(["probe"]);
    const on = await receive(ownerApp(), "/ext/probe/status?echo=hi", { headers: { cookie } });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ extension: "probe", owner: true, echo: "hi" });
    await enable([]);
  });

  it("need the owner's session, and refuse a cross-site request carrying it", async () => {
    await enable(["probe"]);
    expect((await receive(ownerApp(), "/ext/probe/status")).status).toBe(401);
    const cookie = await login();
    expect((await receive(ownerApp(), "/ext/probe/status", { headers: { cookie, origin: "https://elsewhere.example" } })).status).toBe(403);
    await enable([]);
  });

  it("are owner reads for a delegated token: owner:read admits, nothing else does", async () => {
    await enable(["probe"]);
    for (const scope of [[], ["owner:draft"], ["owner:publish"], ["owner:manage"], ["owner:draft", "owner:publish", "owner:manage"]]) {
      const denied = await receive(delegatedApp(scope), "/ext/probe/status");
      expect(denied.status, scope.join(" ") || "(none)").toBe(403);
      expect(denied.headers.get("www-authenticate")).toContain("insufficient_scope");
    }
    expect((await receive(delegatedApp(["owner:read"]), "/ext/probe/status")).status).toBe(200);
    // A write to an extension prefix is unclassified, so denied before any handler.
    expect((await receive(delegatedApp(["owner:read", "owner:draft", "owner:publish", "owner:manage"]), "/ext/probe/status", { method: "POST" })).status).toBe(403);
    await enable([]);
  });

  it("spend the read budget like any other read", async () => {
    await enable(["probe"]);
    const app = delegatedApp(["owner:read"]);
    expect((await receive(app, "/ext/probe/status", {}, { API_READ_LIMIT: "1" })).status).toBe(200);
    const refused = await receive(app, "/ext/probe/status", {}, { API_READ_LIMIT: "1" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    await enable([]);
  });

  it("are refused at registration unless they are GETs under the extension's own prefix", () => {
    const write = { ...probe, method: "post" as const };
    expect(() => extensionApi([{ name: "probe", routes: (router) => router.get(write, (c) => c.json({}, 200)) }])).toThrow(/only add GET routes/);
    const elsewhere = extensionRoute("other", "status", "/status", z.object({}));
    expect(() => extensionApi([{ name: "probe", routes: (router) => router.get(elsewhere, (c) => c.json({}, 200)) }])).toThrow(/under \/api\/ext\/probe\//);
  });
});

describe("extension contract", () => {
  it("derives a namespaced operation and path", () => {
    expect(probe.operationId).toBe("extProbeStatus");
    expect(probe.path).toBe("/ext/probe/status");
    expect(probe.method).toBe("get");
    expect(probe.tags).toEqual(["extension", "extension:probe"]);
    expect(() => extensionRoute("Bad Name", "x", "/x", z.object({}))).toThrow(/invalid extension name/);
  });

  it("every catalogued extension route is an owner read under its own prefix, and in the contract", () => {
    for (const [operation, route] of Object.entries(extensionRoutes) as [string, { method: string; path: string; tags?: string[] }][]) {
      const name = EXTENSIONS.find((candidate) => route.path.startsWith(`/ext/${candidate}/`));
      expect(name, operation).toBeDefined();
      expect(route.method, operation).toBe("get");
      expect((route as { operationId?: string }).operationId, operation).toBe(operation);
      expect(route.tags, operation).toContain(`extension:${name}`);
      expect(operationScopes(operation), operation).toEqual(["owner:read"]);
      expect(routes[operation as keyof typeof routes], operation).toBe(route);
    }
  });

  it("the suite compiles in every extension that has a server half", () => {
    // import.meta.glob, not node:fs: the Workers pool sandboxes the filesystem.
    const withServer = Object.keys(import.meta.glob("../extensions/*/server.ts", { query: "?raw", import: "default", eager: true })).map((path) => path.split("/")[2]).sort();
    expect(compiledServerExtensions.map((extension) => extension.name).sort()).toEqual(withServer);
    for (const name of withServer) expect(EXTENSIONS as readonly string[]).toContain(name);
  });
});
