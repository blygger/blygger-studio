import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifySdkConsumer } from "./verify-sdk-consumer.ts";
import { verifyPersistence } from "./verify-persistence.ts";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readD1Migrations } from "@cloudflare/vitest-plugin";

const output = "build/release";
const manifest = JSON.parse(readFileSync(join(output, "release.json"), "utf8"));
for (const line of readFileSync(join(output, "SHA256SUMS"), "utf8").trim().split("\n")) {
  const [expected, name] = line.split("  ");
  assert.equal(createHash("sha256").update(readFileSync(join(output, name))).digest("hex"), expected);
}
const temp = mkdtempSync(join(tmpdir(), "blygger-release-"));
let mf: Miniflare | undefined;
try {
  const workerArchive = manifest.artifacts.find((file: string) => file.endsWith(".tar.gz"));
  const sdkArchive = manifest.artifacts.find((file: string) => file.endsWith(".tgz"));
  execFileSync("tar", ["-xzf", resolve(output, workerArchive), "-C", temp]);
  execFileSync("tar", ["-xzf", resolve(output, sdkArchive), "-C", temp]);
  const worker = join(temp, `blygger-worker-${manifest.studioVersion}`);
  const config = readFileSync(join(worker, "wrangler.jsonc"), "utf8");
  assert.match(config, /"main": "worker.js"/);
  assert.match(config, /"no_bundle": true/);
  assert.match(config, /FILL-ME-run-npm-run-init/);
  assert.match(config, /"PublicHtml": \{ "type": "worker", "cache": \{ "enabled": true \} \}/);
  mf = new Miniflare(convertV4MiniflareOptions({ modules: [{ type: "ESModule", path: "worker.mjs", contents: readFileSync(join(worker, "worker.js"), "utf8") }], compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"], bindings: { MOUNT: "", OWNER_PASSWORD: "test", COOKIE_SECRET: "release-smoke-test-secret" }, d1Databases: ["DB"], r2Buckets: ["MEDIA"] }));
  assert.equal((await mf.dispatchFetch("http://localhost/api/openapi.json")).status, 401);
  const browser = await mf.dispatchFetch("http://localhost/studio/app.js");
  assert.equal(browser.status, 200);
  assert.match(await browser.text(), /blygger/);
  const css = await mf.dispatchFetch("http://localhost/studio/app.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("Content-Type") || "", /text\/css/);
  const sdk = await import(pathToFileURL(join(temp, "package/dist/index.js")).href);
  assert.equal(typeof sdk.createBlyggerClient, "function");
  const db = await mf.getD1Database("DB");
  for (const migration of await readD1Migrations(join(worker, "migrations"))) {
    await db.batch(migration.queries.map((query) => db.prepare(query)));
  }
  const homepage = await mf.dispatchFetch('http://localhost/');
  assert.equal(homepage.status, 200);
  assert.equal(homepage.headers.get('cache-control'), 'no-cache');
  const htmlEtag = homepage.headers.get('etag');
  assert.ok(htmlEtag);
  assert.match(await homepage.text(), /<!doctype html>/);
  const validated = await mf.dispatchFetch('http://localhost/', { headers: { 'if-none-match': htmlEtag } });
  assert.equal(validated.status, 304);
  assert.equal(await validated.text(), '');
  const baseUrl = (await mf.ready).origin;
  const login = await fetch(`${baseUrl}/studio/login`, { method: "POST", body: new URLSearchParams({ password: "test" }), redirect: "manual" });
  assert.equal(login.status, 302);
  const token = login.headers.get("set-cookie")?.match(/blyg_session=([^;]+)/)?.[1];
  assert.ok(token);
  const client = sdk.createBlyggerClient({ baseUrl: baseUrl + "/api", auth: (scheme: { in?: string }) => scheme.in === 'cookie' ? token : undefined });
  const draft = await sdk.unwrap(sdk.BlyggerApi.createItem({ client, body: { content_md: "Packaged Node SDK" } }));
  const detail = await sdk.unwrap(sdk.BlyggerApi.getItem({ client, path: { id: draft.id } }));
  assert.equal(detail.content_md, "Packaged Node SDK");
  const media = await sdk.unwrap(sdk.BlyggerApi.uploadMedia({ client, body: { file: new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" }) } }));
  assert.equal(media.mime, "image/png");
  const unauthorized = await sdk.BlyggerApi.getSettings({ client: sdk.createBlyggerClient({ baseUrl: baseUrl + "/api" }) });
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.error.error, "unauthorized");
  assert.ok(readFileSync(join(temp, "package/LICENSE"), "utf8").includes("MIT"));
  assert.equal(JSON.parse(readFileSync(join(temp, "package/package.json"), "utf8")).version, manifest.sdkVersion);
  await verifySdkConsumer(temp, join(output, sdkArchive), baseUrl + "/api", token, baseUrl + "/studio");
  await verifyPersistence(worker, temp);
  console.log("Release checksums, extracted Worker, and packaged Node SDK auth/read/write/upload verified");
} finally {
  await mf?.dispose();
  rmSync(temp, { recursive: true, force: true });
}
