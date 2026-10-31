/**
 * Saving must preserve the owner's newest text when HTTP delivery fails or lags.
 * Publishing must wait for a successful save. An old acknowledgment must not reload
 * an editor over newer input. Happy-path saving cannot expose those distinctions.
 *
 * Contract: the established Studio save behavior documented in docs/testing.md.
 * These UI ordering and recovery laws are local policy, not an HTTP retry guarantee.
 * Model: submitted text order, acknowledged text and publication-request count.
 * Failure can precede commit or follow it; an error does not imply that D1 rolled back.
 * History grammar: fragment/thread, four rejected statuses, lost response after real
 * commit, failed autosave/publication and a held older save before newer input.
 * Driver: real Chromium UI against the compiled Worker. Playwright controls HTTP
 * failure/delivery and browser time; successful neighboring requests still reach D1.
 * Refinement: editor text, save/error UI, observed PATCH bodies and subsequent API
 * reads. Publication count and version remain zero when save fails. The ordering
 * probe records fetch invocation before delivery, so queued requests remain visible.
 * Limits: controlled HTTP schedules, not concurrent D1 writers, every network
 * failure or independent browser engines. Desktop/mobile are Chromium profiles.
 */
import { test, expect, type Page } from "./fixture";
import { acceptSheets } from "./sheets.ts";

// Each case represents an independent browser, with one stable fixture edge IP.
// Preserve its real login budget throughout the case; do not disable throttling.


async function editor(page: Page, kind: "fragment" | "thread") {
  await page.goto("/studio/login");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  await expect(page.locator("#composer-text")).toBeVisible();
  const created = await page.evaluate(async kind => { const response = await fetch("/api/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, content_md: "persisted" }) }); return { status: response.status, body: await response.json() as { id: string } }; }, kind);
  expect(created.status).toBe(201);
  const { id } = created.body;
  await page.goto(`/studio/edit/${id}`);
  await expect(page.locator("#md-input")).toHaveValue("persisted");
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 10_000));
  return id as string;
}
for (const kind of ["fragment", "thread"] as const) {
  for (const status of [400, 401, 500, 503]) test(`${kind} keeps text after save ${status} and can recover`, async ({ page }) => {
    const id = await editor(page, kind);
    await acceptSheets(page);
    await page.route(`**/api/items/${id}`, route => route.request().method() === "PATCH" ? route.fulfill({ status, json: { error: "save rejected" } }) : route.continue());
    await page.locator("#md-input").fill("unsaved text");
    const failed = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}`) && response.status() === status);
    await page.locator("#save-draft-btn").click();
    await failed;
    // Flush browser event handlers without advancing the autosave debounce.
    await page.clock.runFor(17);
    await expect(page.locator("#md-input")).toHaveValue("unsaved text");
    expect((await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json() as Promise<{ content_md: string; version: number }>, id)).content_md).toBe("persisted");
    await page.unroute(`**/api/items/${id}`);
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}`) && response.request().method() === "PATCH" && response.status() === 200);
    const acknowledged = expect(page.locator(".save-state")).toHaveText("saved");
    await page.locator("#save-draft-btn").click();
    await saved; await acknowledged;
    await expect(page.locator("#md-input")).toHaveValue("unsaved text");
    expect((await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json() as Promise<{ content_md: string; version: number }>, id)).content_md).toBe("unsaved text");
  });
  // Commit and acknowledgment are separate events. route.fetch commits through the
  // real Worker, then route.abort withholds the response. Preserve local text and
  // reject a later save at the unacknowledged revision. The owner must reconcile it.
  test(`${kind} retains text when a committed save loses its response`, async ({ page }) => {
    const id = await editor(page, kind);
    await acceptSheets(page);
    let calls = 0;
    let capturedRevision: number | undefined;
    await page.route(`**/api/items/${id}`, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      calls++;
      capturedRevision = route.request().postDataJSON().expectedRevision;
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort("failed");
    });
    await page.locator("#md-input").fill("committed but unacknowledged");
    await page.locator("#save-draft-btn").click();
    await expect(page.locator("#error-banner-slot")).toContainText(/failed|fetch|network/i);
    await expect(page.locator("#md-input")).toHaveValue("committed but unacknowledged");
    expect(calls).toBe(1);
    const committed = await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json() as Promise<{ content_md: string; revision: number }>, id);
    expect(committed.content_md).toBe("committed but unacknowledged");
    expect(committed.revision).toBe(capturedRevision! + 1);
    await page.unroute(`**/api/items/${id}`);
    const conflict = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}`) && response.request().method() === "PATCH" && response.status() === 409);
    await page.locator("#save-draft-btn").click();
    const rejected = await conflict;
    expect(rejected.request().postDataJSON().expectedRevision).toBe(capturedRevision);
    expect(await rejected.json()).toMatchObject({ code: 'revision-conflict', expectedRevision: capturedRevision });
    await expect(page.locator("#error-banner-slot")).toContainText('item revision conflict; reload and try again');
    await expect(page.locator(".save-state")).toHaveCount(0);
    await expect(page.locator("#md-input")).toHaveValue("committed but unacknowledged");
    expect(await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json(), id)).toEqual(committed);
  });
  // Publication is gated by save acknowledgment. Count actual publish requests,
  // not just a hidden UI button, and read version zero after the rejected PATCH.
  test(`${kind} never publishes after a failed save`, async ({ page }) => {
    const id = await editor(page, kind);
    await acceptSheets(page);
    let published = 0;
    await page.route(`**/api/items/${id}/publish`, async route => { published++; await route.continue(); });
    await page.route(`**/api/items/${id}`, route => route.request().method() === "PATCH" ? route.fulfill({ status: 503, json: { error: "save rejected" } }) : route.continue());
    await page.locator("#md-input").fill("must not lose this");
    const failed = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}`) && response.status() === 503);
    await page.locator("#publish-btn").click(); await failed;
    await page.clock.runFor(17);
    expect(published).toBe(0);
    await expect(page.locator("#md-input")).toHaveValue("must not lose this");
    expect((await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json() as Promise<{ content_md: string; version: number }>, id)).version).toBe(0);
  });
  test(`${kind} retains a failed autosave and recovers on the next save`, async ({ page }) => {
    const id = await editor(page, kind);
    await acceptSheets(page);
    await page.route(`**/api/items/${id}`, route => route.request().method() === "PATCH" ? route.fulfill({ status: 503, json: { error: "autosave rejected" } }) : route.continue());
    await page.locator("#md-input").fill("failed autosave");
    const failed = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}`) && response.status() === 503);
    await page.clock.runFor(401); await failed;
    await expect(page.locator("#md-input")).toHaveValue("failed autosave");
    expect((await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json() as Promise<{ content_md: string }>, id)).content_md).toBe("persisted");
    await page.unroute(`**/api/items/${id}`);
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}`) && response.status() === 200);
    const acknowledged = expect(page.locator(".save-state")).toHaveText("saved");
    await page.locator("#save-draft-btn").click(); await saved; await acknowledged;
    expect((await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json() as Promise<{ content_md: string }>, id)).content_md).toBe("failed autosave");
  });
  test(`${kind} keeps the editor after publication fails following a successful save`, async ({ page }) => {
    const id = await editor(page, kind);
    await page.route(`**/api/items/${id}/publish`, route => route.fulfill({ status: 503, json: { error: "publication rejected" } }));
    await page.locator("#md-input").fill("saved but unpublished");
    const failed = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}/publish`) && response.status() === 503);
    await page.locator("#publish-btn").click(); await failed;
    await expect(page.locator("#error-banner-slot")).toContainText("publication rejected");
    await expect(page.locator("#md-input")).toHaveValue("saved but unpublished");
    const item = await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json() as Promise<{ content_md: string; version: number }>, id);
    expect(item).toMatchObject({ content_md: "saved but unpublished", version: 0 });
    await page.unroute(`**/api/items/${id}/publish`);
    await page.locator("#publish-btn").click();
    await expect(page.locator('[data-action="view-version"]')).toHaveCount(1);
  });
  // Hold an older save until newer editor input exists. Releasing that save must
  // not replace the newer input; the next autosave must persist that newer text.
  // The held-request promise establishes order without relying on network timing.
  test(`${kind} does not reload over edits entered while manual save is pending`, async ({ page }) => {
    const id = await editor(page, kind);
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = new Promise<void>(resolve => { started = resolve; });
    await page.route(`**/api/items/${id}`, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      if (route.request().postDataJSON().content_md === "older") { started(); await held; }
      await route.continue();
    });
    try {
      await page.locator("#md-input").fill("older");
      await page.locator("#save-draft-btn").click(); await first;
      await page.locator("#md-input").fill("newer");
      const saved = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}`) && response.request().postDataJSON()?.content_md === "older");
      release(); await saved; await page.clock.runFor(17);
      await expect(page.locator("#md-input")).toHaveValue("newer");
      const next = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}`) && response.request().postDataJSON()?.content_md === "newer");
      await page.clock.runFor(401); await next;
      expect((await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json() as Promise<{ content_md: string }>, id)).content_md).toBe("newer");
    } finally { release(); }
  });
  // Serialization is a work law as well as a final-value law. While the first PATCH
  // is held, only one fetch may start. After release, record both bodies in order
  // and compare the final API text. Correct final text alone would miss overlap.
  test(`${kind} serializes an older pending autosave before the next edit`, async ({ page }) => {
    const id = await editor(page, kind);
    const bodies: string[] = [];
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = new Promise<void>(resolve => { started = resolve; });
    await page.route(`**/api/items/${id}`, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      bodies.push(route.request().postDataJSON().content_md);
      if (bodies.length === 1) { started(); await held; }
      await route.continue();
    });
    // Count fetch calls before delivery, independently of the SDK.
    await page.evaluate(() => {
      const host = globalThis as unknown as { fetch: typeof fetch; patchCalls: number };
      const original = host.fetch; host.patchCalls = 0;
      host.fetch = (input, init) => { if (init?.method === 'PATCH' || (input instanceof Request && input.method === 'PATCH')) host.patchCalls++; return original(input, init); };
    });
    try {
      await page.locator("#md-input").fill("older"); await page.clock.runFor(401); await first;
      await page.locator("#md-input").fill("newer"); await page.clock.runFor(401);
      expect(await page.evaluate(() => (globalThis as unknown as { patchCalls: number }).patchCalls)).toBe(1);
      const saved = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}`) && response.request().postDataJSON()?.content_md === "newer");
      release(); await saved;
      expect(bodies).toEqual(["older", "newer"]);
      expect((await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json() as Promise<{ content_md: string; version: number }>, id)).content_md).toBe("newer");
    } finally { release(); }
  });
}

// Session 47 (Venkat): autosave while typing disabled publish and save draft,
// because it ran through the editor's busy flag. A held autosave must leave
// both buttons usable, and a publish clicked meanwhile must still publish the
// newest text, after the save.
for (const kind of ["fragment", "thread"] as const) test(`${kind} autosave in flight leaves publish usable, and publish waits for it`, async ({ page }) => {
  const id = await editor(page, kind);
  await acceptSheets(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  await page.route(`**/api/items/${id}`, async route => {
    if (route.request().method() !== "PATCH" || !first) return route.continue();
    first = false;
    await held;
    await route.continue();
  });
  const autosaving = page.waitForRequest(request => request.url().endsWith(`/api/items/${id}`) && request.method() === "PATCH");
  await page.locator("#md-input").fill("typed while saving");
  await page.clock.runFor(450);
  await autosaving;
  await expect(page.locator("#publish-btn")).toBeEnabled();
  await expect(page.locator("#save-draft-btn")).toBeEnabled();
  const published = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}/publish`) && response.status() === 200);
  await page.locator("#publish-btn").click();
  release();
  await published;
  const item = await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json() as Promise<{ content_md: string; version: number }>, id);
  expect(item).toMatchObject({ content_md: "typed while saving", version: 1 });
});
