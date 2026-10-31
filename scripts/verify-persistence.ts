import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { join, resolve } from "node:path";
import { BlyggerApi, createBlyggerClient, unwrap } from "../sdk/dist/index.js";

async function start(worker: string, storage: string, initialize: boolean) {
  const child = fork(resolve("scripts/persistence-worker.ts"), [worker, storage, initialize ? "initialize" : "restart"], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; child.stderr?.on("data", chunk => { errors += chunk; });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  let baseUrl: string;
  try {
    baseUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Persistence Worker startup timed out: ${errors}`)), 30_000);
      child.once("message", message => { clearTimeout(timeout); const url = (message as { url?: string }).url; if (url) resolve(url); else reject(new Error("Missing fixture URL")); });
      child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Persistence Worker exited ${code}: ${errors}`)); });
    });
  } catch (error) { child.kill(); await exited; throw error; }
  return { baseUrl, async stop() {
    if (child.exitCode !== null) throw new Error(`Persistence Worker exited early: ${errors}`);
    child.send("stop");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try { assert.equal(await exited, 0, `Persistence Worker shutdown failed: ${errors}`); } finally { clearTimeout(timeout); }
  } };
}
export async function verifyPersistence(worker: string, temp: string) {
  let fixture: Awaited<ReturnType<typeof start>> | undefined = await start(worker, join(temp, "persistent-storage"), true);
  try {
    const login = await fetch(`${fixture.baseUrl}/studio/login`, { method: "POST", body: new URLSearchParams({ password: "test" }), redirect: "manual" });
    const token = login.headers.get("set-cookie")?.match(/blyg_session=([^;]+)/)?.[1]; assert.ok(token);
    let client = createBlyggerClient({ baseUrl: fixture.baseUrl + "/api", auth: scheme => scheme.in === 'cookie' ? token : undefined });
    await unwrap(BlyggerApi.updateSettings({ client, body: { siteUrl: "https://restart.example/" } }));
    const draft = await unwrap(BlyggerApi.createItem({ client, body: { contentMd: "Unpublished restart draft" } }));
    const published = await unwrap(BlyggerApi.createItem({ client, body: { kind: "thread", contentMd: "Frozen citation", stubOf: { url: "https://source.example/article" } } }));
    const first = await unwrap(BlyggerApi.publishItem({ client, path: { id: published.id }, body: { expectedRevision: published.revision } }));
    const pin = await unwrap(BlyggerApi.pinItem({ client, path: { id: published.id, version: 1 }, body: { expectedRevision: first.revision } }));
    const edited = await unwrap(BlyggerApi.updateItem({ client, path: { id: published.id }, body: { contentMd: "Second edition", expectedRevision: pin.revision } }));
    await unwrap(BlyggerApi.publishItem({ client, path: { id: published.id }, body: { expectedRevision: edited.revision } }));
    const before = await unwrap(BlyggerApi.getItem({ client, path: { id: published.id } }));
    assert.equal(before.versions.length, 2); assert.equal(before.versions[0].pinned, true);
    assert.ok(before.versions[0].stubCite, "Citation fixture must be present before restart");
    const pinnedResponse = await fetch(`${fixture.baseUrl}/items/${published.id}/v1.json`);
    assert.equal(pinnedResponse.status, 200);
    const pinned = await pinnedResponse.text();
    assert.equal(JSON.parse(pinned).content_md, "Frozen citation");
    const media = await unwrap(BlyggerApi.uploadMedia({ client, body: { file: new File([new Uint8Array([0, 1, 255])], "persistent.png", { type: "image/png" }) } }));
    assert.equal(new URL(media.url).origin, fixture.baseUrl);
    const mediaPath = new URL(media.url).pathname;
    await fixture.stop();
    fixture = undefined;
    fixture = await start(worker, join(temp, "persistent-storage"), false);
    client = createBlyggerClient({ baseUrl: fixture.baseUrl + "/api", auth: scheme => scheme.in === 'cookie' ? token : undefined });
    assert.equal((await unwrap(BlyggerApi.getItem({ client, path: { id: draft.id } }))).contentMd, "Unpublished restart draft");
    assert.deepEqual(await unwrap(BlyggerApi.getItem({ client, path: { id: published.id } })), before);
    const retainedPin = await fetch(`${fixture.baseUrl}/items/${published.id}/v1.json`);
    assert.equal(retainedPin.status, 200);
    assert.equal(await retainedPin.text(), pinned);
    // An unpublished upload is private: the owner reads its bytes, anonymous
    // readers do not, and a restart changes neither.
    // This local restart gets a new ephemeral port. The deployment path and
    // retained bytes stay the same, while the fixture's request origin changes.
    const restartedMediaUrl = new URL(mediaPath, fixture.baseUrl);
    assert.equal((await fetch(restartedMediaUrl)).status, 404);
    const upload = await fetch(restartedMediaUrl, { headers: { cookie: `blyg_session=${token}` } });
    assert.equal(upload.status, 200); assert.equal(upload.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await upload.arrayBuffer()), new Uint8Array([0, 1, 255]));
    console.log("Fresh Worker process retained D1 drafts/history/pins/citations, auth cookie, and R2 upload bytes");
  } finally { if (fixture) await fixture.stop(); }
}
