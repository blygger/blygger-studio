import { fixtureJson } from './api-fixture';
import { test, expect } from "./fixture";
import { answerSheet } from "./sheets.ts";
import { editorMenu, expandRow, openCard } from "./editor.ts";

test("owner can compose, publish and change settings through the SDK", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/studio");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator("#composer-text")).toBeVisible();
  await page.locator("#composer-text").fill("Browser SDK **round trip**");
  await page.locator("#save-draft-btn").click();
  await expect(page.locator("#composer-state")).toHaveText("saved");
  await page.locator("#publish-btn").click();
  await expect(page.locator("#composer-text")).toHaveValue("");
  await expect(page.locator("body")).toContainText("Browser SDK round trip");
  await page.goto("/studio/reading?sub=all");
  await expect(page.locator("body")).toContainText("Browser SDK round trip");
  await page.goto("/studio/settings");
  const title = `Browser SDK site ${testInfo.project.name} ${testInfo.repeatEachIndex} ${testInfo.retry}`;
  await page.locator("#site_title").fill(title);
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "PATCH");
  await page.locator('#settings-form button[type="submit"]').focus();
  await page.locator('#settings-form button[type="submit"]').press('Enter');
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("saved");
  await page.reload();
  await expect(page.locator("#site_title")).toHaveValue(title);
  expect(errors).toEqual([]);
});

test("editor autosave, preview, image upload and history use the SDK", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/studio/login");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  await expect(page.locator("#composer-text")).toBeVisible();
  await page.locator("#composer-text").fill("Editor fixture");
  await page.locator("#composer-full").click();
  await expect(page.locator("#md-input")).toHaveValue("Editor fixture");
  await page.locator("#md-input").fill("Autosaved **preview**");
  await expect(page.locator("#preview-body strong")).toHaveText("preview");
  await expect(page.locator(".save-state")).toHaveText("saved");
  await page.reload();
  await expect(page.locator("#md-input")).toHaveValue("Autosaved **preview**");
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#attach-btn").click();
  const uploaded = page.waitForResponse((response) => response.url().endsWith("/api/media"));
  await (await chooser).setFiles({ name: "fixture.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>') });
  expect((await uploaded).status()).toBe(201);
  await expect(page.locator("body")).toContainText("attached:");
  await page.locator("#publish-btn").click();
  await expect(page.locator('[data-action="view-version"]')).toHaveCount(1);
  await openCard(page, "history");
  await page.locator('[data-action="view-version"]').click();
  await expect(page.locator("#h-viewer-body")).toContainText("Autosaved preview");
  expect(errors).toEqual([]);
});


test('owner can pin and restore an empty publication', async ({ page }) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  const api = (method: string, path: string, data?: unknown) =>
    page.evaluate(fixtureJson, { method, path, body: data }).then(result => ({ status: result.status, body: result.json }));
  const created = await api('POST', '/api/items', { kind: 'thread', content_md: '' });
  expect(created.status).toBe(201);
  const { id } = created.body;
  expect((await api('POST', `/api/items/${id}/publish`, {})).status).toBe(200);
  await page.goto(`/studio/edit/${id}`);
  await openCard(page, 'history');
  await expect(page.locator('[data-action="pin"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'restore → v2', exact: true })).toBeVisible();
  await page.locator('[data-action="pin"]').click();
  await answerSheet(page, { name: /^Pin v1\?/ });
  await expect(page.locator('#history .badge-pencil')).toBeVisible();
  expect((await api('PATCH', `/api/items/${id}`, { content_md: 'unsaved replacement' })).status).toBe(200);
  await page.reload();
  await openCard(page, 'history');
  await page.getByRole('button', { name: 'restore → v2', exact: true }).click();
  await answerSheet(page, { name: /^Restore v1 into/ });
  await expect(page.locator('#md-input')).toHaveValue('');
  const detail = (await api('GET', `/api/items/${id}`)).body;
  expect(detail).toMatchObject({ content_md: '', dirty: false, version: 1 });
  await page.locator('#history').getByRole('link', { name: 'fork', exact: true }).click();
  const forked = page.waitForResponse(response => response.url().endsWith('/api/items') && response.request().method() === 'POST');
  await page.locator('[data-action="fork"]').click();
  expect((await forked).status()).toBe(201);
  await expect(page.locator('#md-input')).toHaveValue('');
});

test("owner can pin and fork through resource creation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/studio/login");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  await page.locator("#composer-text").fill("Browser fork source");
  await page.locator("#composer-full").click();
  const sourceUrl = page.url();
  await page.locator("#publish-btn").click();
  await expect(page.locator('[data-action="pin"]')).toHaveCount(1);
  await openCard(page, "history");
  await page.locator('[data-action="pin"]').first().click();
  await answerSheet(page, { name: /^Pin v1\?/ });
  await page.locator('a[href^="/studio/fork?"]').click();
  const created = page.waitForResponse((response) => response.url().endsWith("/api/items") && response.request().method() === "POST");
  await page.locator('[data-action="fork"]').click();
  const forkResponse = await created;
  expect(forkResponse.status()).toBe(201);
  expect(forkResponse.request().postDataJSON()).toMatchObject({ mode: "fork", source: { version: 1 } });
  await expect(page.locator("#md-input")).toHaveValue("Browser fork source");
  expect(page.url()).not.toBe(sourceUrl);
  expect(errors).toEqual([]);
});

test("stale quotes are listed, explained, and refreshed as one republish", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/studio/login");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  await expect(page.locator("#composer-text")).toBeVisible();
  // In-page fetch: the session cookie is Secure, which Playwright's request
  // context will not send over the fixture's plain http.
  const api = async (method: string, path: string, data?: unknown) => {
    const res = await page.evaluate(fixtureJson, { method, path: `/api${path}`, body: data });
    expect(res.ok, `${method} ${path}`).toBe(true);
    return res.json;
  };
  const marker = `Quoted source ${Date.now()}`;
  const title = `Stale quote fixture ${Date.now()}`;
  const source = (await api("POST", "/items", { content_md: `${marker}, first version.` })).id;
  await api("POST", `/items/${source}/publish`, {});
  const thread = (await api("POST", "/items", { content_md: `# ${title}\n\n![[${source}]]\n\nMy commentary.`, kind: "thread" })).id;
  await api("POST", `/items/${thread}/publish`, {});
  await api("PATCH", `/items/${source}`, { content_md: `${marker}, second version.` });
  await api("POST", `/items/${source}/publish`, {});

  // Compose no longer nags; the updates tab lists the thread, stalest first,
  // under the batching note, and links to its snapshots.
  await page.reload();
  await expect(page.locator("#composer-text")).toBeVisible();
  await expect(page.locator(".stale-notice")).toHaveCount(0);
  await page.locator(".tabbar").getByRole("link", { name: "updates" }).click();
  await expect(page.locator(".updates-note")).toContainText("descending order of staleness");
  const entry = page.locator(".updates-list li").filter({ hasText: title });
  await expect(entry).toContainText("1 version behind · 1 stale quote");
  await entry.getByRole("link").click();
  await expect(page.locator("#md-input")).toBeVisible();

  // The panel says what is stale and by how much.
  const row = page.locator('#snapshots [data-status="refreshable"]');
  await expect(row).toContainText("v1 → v2 available");

  // Unpublished edits block the refresh, and the panel says why.
  await page.locator("#md-input").fill(`# ${title}\n\n![[${source}]]\n\nHalf-written edit.`);
  await expect(page.locator("#snapshots")).toContainText("unpublished edits");
  await expect(page.locator('[data-action="refresh-quotes"]')).toHaveCount(0);
  await editorMenu(page, "discard changes");
  await answerSheet(page, { name: /^Discard unpublished changes/ });
  await expect(page.locator("#md-input")).toHaveValue(`# ${title}\n\n![[${source}]]\n\nMy commentary.`);

  // One click republishes with the new quote.
  const refreshed = page.waitForResponse((r) => r.url().endsWith(`/api/items/${thread}/refresh`));
  await page.locator('[data-action="refresh-quotes"]').click();
  expect((await refreshed).status()).toBe(200);
  await expect(page.locator("#snapshots > summary")).toContainText("all current");
  const doc = await page.evaluate(async (id) => (await fetch(`/items/${id}.json`)).json(), thread);
  expect(doc.version).toBe(2);
  expect(doc.content_html).toContain(`${marker}, second version.`);
  expect(doc.changelog.at(-1).note).toBe("refreshed quoted snapshots");
  expect(errors).toEqual([]);
});

test("pasted generated text is marked from a selection and published disclosed", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/studio/login");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  const pasted = `A model wrote this ${Date.now()}.`;
  await page.locator("#composer-text").fill(`Mine first. ${pasted} Mine after.`);
  await page.locator("#composer-full").click();
  const input = page.locator("#md-input");
  await expect(input).toHaveValue(`Mine first. ${pasted} Mine after.`);
  await input.evaluate((el: HTMLTextAreaElement, text) => {
    const start = el.value.indexOf(text);
    el.focus();
    el.setSelectionRange(start, start + text.length);
  }, pasted);
  await page.locator("#tk-impyrt-btn").click();
  await expect(input).toHaveValue(`Mine first. [TK]impyrt=${pasted}[/TK] Mine after.`);
  await expect(page.locator(".tk-imported")).toBeVisible();
  await expect(page.locator(".save-state")).toHaveText("saved");
  await page.locator("#publish-btn").click();
  await expect(page.locator('[data-action="view-version"]')).toHaveCount(1);
  const id = new URL(page.url()).pathname.split("/").pop();
  const doc = await page.evaluate(async (id) => (await fetch(`/items/${id}.json`)).json(), id);
  expect(doc.content_html).toContain(`<span class="blyg-tk-gen">${pasted}</span>`);
  expect(doc.generated).toEqual([{ sources: [] }]);
  expect(errors).toEqual([]);
});

test("a drafted note is editable, flagged only while unedited, and cleared after publish", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/studio/login");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  await page.locator("#composer-text").fill(`Note fixture ${Date.now()}`);
  await page.locator("#composer-full").click();
  await page.locator("#publish-btn").click();
  await expect(page.locator('[data-action="view-version"]')).toHaveCount(1);
  // The fixture has no model; the route's behaviour is covered by the Worker suite.
  await page.route("**/note-draft", (route) => route.fulfill({ json: { note: "Added a second sentence.", model: "test", pinned_prior: false } }));
  const publishes: unknown[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/publish")) publishes.push(r.postDataJSON()); });

  await page.locator("#md-input").fill(`${await page.locator("#md-input").inputValue()} A second sentence.`);
  await page.locator("#draft-note-btn").click();
  await expect(page.locator("#note-input")).toHaveValue("Added a second sentence.");
  await expect(page.locator("#note-generated-hint")).toBeVisible();
  await page.locator("#publish-btn").click();
  // Every note is confirmed before a new version publishes (session 33).
  await expect(page.locator("#note-confirm-text")).toHaveValue("Added a second sentence.");
  await expect(page.locator("#note-confirm-generated")).toBeVisible();
  await page.locator("#note-confirm-ok").click();
  await expect(page.locator('[data-action="view-version"]')).toHaveCount(2);
  expect(publishes.at(-1)).toMatchObject({ note: "Added a second sentence.", note_generated: true });
  await expect(page.locator("#history .badge", { hasText: "generated" })).toHaveCount(1);
  await expect(page.locator("#note-input")).toHaveValue("");

  // Edited before publishing: the words are the author's.
  await page.locator("#md-input").fill(`${await page.locator("#md-input").inputValue()} A third.`);
  await page.locator("#draft-note-btn").click();
  await expect(page.locator("#note-generated-hint")).toBeVisible();
  await page.locator("#note-input").fill("Added a third sentence, by hand.");
  await expect(page.locator("#note-generated-hint")).toHaveCount(0);
  await page.locator("#publish-btn").click();
  await expect(page.locator("#note-confirm-text")).toHaveValue("Added a third sentence, by hand.");
  await expect(page.locator("#note-confirm-generated")).toHaveCount(0);
  await page.locator("#note-confirm-ok").click();
  await expect(page.locator('[data-action="view-version"]')).toHaveCount(3);
  expect(publishes.at(-1)).toMatchObject({ note_generated: false });
  expect(errors).toEqual([]);
});

test("an imported item's history shows notes, and diffs only public versions", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const ID = "00000000000000000000000001";
  // The fixture cannot reach an origin; stub the two owner routes it would use.
  await page.route(`**/api/imports/parity-native/${ID}/history`, (route) => route.fulfill({ json: { current: 3, withdrawn: false, changelog: [
    { version: 1, at: "2026-09-01T00:00:00Z", note: null, pinned: true, generated: false },
    { version: 2, at: "2026-09-02T00:00:00Z", note: "private middle edit", pinned: false, generated: false },
    { version: 3, at: "2026-09-03T00:00:00Z", note: "Narrowed the claim.", pinned: false, generated: true },
  ] } }));
  await page.route(`**/api/imports/parity-native/${ID}/versions/*`, (route) => {
    const v = Number(route.request().url().split("/").pop());
    route.fulfill({ json: { version: v, content_md: v === 1 ? "The claim was broad." : "The claim is narrow.", note: null, pinned: v === 1 } });
  });
  await page.goto("/studio/login");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  // Filtered to the seeded source: other tests fill the first page of "all".
  await page.goto("/studio/reading?sub=parity-native");
  const entry = page.locator(".reading-entry").filter({ hasText: "Frozen source text." });
  await entry.getByRole("button", { name: "more actions", exact: true }).click();
  await page.getByRole("dialog", { name: "actions" }).getByRole("button", { name: "history", exact: true }).click();
  await expect(entry.locator(".entry-history .h-row")).toHaveCount(3);
  await expect(entry.locator(".entry-history")).toContainText("Narrowed the claim.");
  await expect(entry.locator(".entry-history .tc-chip", { hasText: "generated" })).toHaveCount(1);
  // v2 is neither pinned nor current: it is never offered as a side of a diff.
  const buttons = entry.locator('[data-action="see-change"]');
  await expect(buttons).toHaveCount(1);
  await expect(buttons).toHaveText("see the change v1 → v3");
  await buttons.click();
  await expect(entry.locator(".entry-diff del")).toContainText("was broad.");
  await expect(entry.locator(".entry-diff ins")).toContainText("is narrow.");
  expect(errors).toEqual([]);
});

test("an uploaded image leaves with its line, and an unused attachment can be removed", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/studio/login");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  await page.locator("#composer-text").fill(`Attachment fixture ${Date.now()}`);
  await page.locator("#composer-full").click();
  const input = page.locator("#md-input");
  const before = await input.inputValue();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#attach-btn").click();
  await (await chooser).setFiles({ name: "fig.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") });
  await expect(input).toHaveValue(/!\[\]\(\/media\/\w+\.png\)/);
  const row = page.locator(".attachment");
  await expect(row).toContainText("in the text");
  await expect(row.locator('[data-action="remove-media"]')).toHaveCount(0);
  // Delete the image line: the attachment is no longer shown, and can be removed.
  await input.fill(before);
  await expect(row).toContainText("not in the text, so not shown");
  const removed = page.waitForResponse((r) => r.url().includes("/api/media/") && r.request().method() === "DELETE");
  await row.locator('[data-action="remove-media"]').click();
  expect((await removed).status()).toBe(200);
  await expect(page.locator(".attachment")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("an attachment the live version lists is dropped from the next version only", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/studio/login");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  await expect(page.locator("#composer-text")).toBeVisible();
  // An appended attachment (another tool's upload, not placed in the text),
  // published. In-page fetches, so the owner cookie (Secure) rides along.
  const id = await page.evaluate(async (stamp) => {
    const json = (method: string, path: string, body: unknown) =>
      fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const { id, revision } = await (await json("POST", "/api/items", { content_md: `Per-version fixture ${stamp}` })).json();
    const form = new FormData();
    form.set("item_id", id);
    form.set("expectedRevision", String(revision));
    form.set("alt", "the figure");
    form.set("file", new File([`PNG fixture ${stamp}`], "fig.png", { type: "image/png" }));
    const uploaded = await fetch("/api/media", { method: "POST", body: form });
    if (uploaded.status !== 201) throw new Error("upload failed");
    const attachment = await uploaded.json();
    if ((await json("POST", `/api/items/${id}/publish`, { expectedRevision: attachment.revision })).status !== 200) throw new Error("publish failed");
    return id as string;
  }, `${test.info().project.name} ${Date.now()}`);
  await page.goto(`/studio/edit/${id}`);
  await openCard(page, "attachments");
  const row = page.locator('.media:not([data-dropped]) .attachment');
  await expect(row).toContainText("shown below the post");
  const drop = row.locator('[data-action="remove-media"]');
  await expect(drop).toHaveText("drop from the next version");
  const removed = page.waitForResponse((r) => r.url().includes("/api/media/") && r.request().method() === "DELETE");
  await drop.click();
  expect((await removed).status()).toBe(200);
  const dropped = page.locator("[data-dropped] .attachment");
  await expect(dropped).toContainText("the figure");
  await expect(dropped).toContainText("leaves with the next one");
  expect(errors).toEqual([]);
});

test("the composer autosaves real text, and not a stray keystroke", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/studio/login");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  const creates: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/api/items")) creates.push(r.url()); });
  await page.locator("#composer-text").fill("ab");
  await page.waitForTimeout(3600);
  expect(creates).toHaveLength(0);
  const marker = `Autosaved composer text ${Date.now()}`;
  await page.locator("#composer-text").fill(marker);
  await expect(page.locator("#composer-state")).toHaveText("saved", { timeout: 6000 });
  expect(creates).toHaveLength(1);
  // A further edit saves into the same draft, not a new one.
  await page.locator("#composer-text").fill(`${marker} and more`);
  await page.waitForTimeout(1200);
  expect(creates).toHaveLength(1);
  await page.reload();
  await expect(page.locator(".item-row").filter({ hasText: `${marker} and more` })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("auto change notes: a draft is shown for editing before a new version publishes, and cancel publishes nothing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/studio/login");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  const api = (m: string, p: string, d?: unknown) => page.evaluate(fixtureJson, { method: m, path: '/api' + p, body: d }).then(result => result.json);
  await api("PATCH", "/settings", { auto_change_notes: true });
  await page.route("**/note-draft", (route) => route.fulfill({ json: { note: "Tightened the second line.", model: "test", pinned_prior: false } }));
  const publishes: unknown[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/publish")) publishes.push(r.postDataJSON()); });
  const id = (await api("POST", "/items", { content_md: `Auto note fixture ${Date.now()}` })).id;
  await api("POST", `/items/${id}/publish`, {});
  await page.goto(`/studio/edit/${id}`);
  const input = page.locator("#md-input");
  await input.fill(`${await input.inputValue()} Second line.`);

  // Cancel: nothing is published.
  await page.locator("#publish-btn").click();
  await expect(page.locator("#note-confirm-text")).toHaveValue("Tightened the second line.");
  await page.locator("#note-confirm-cancel").click();
  await expect(page.locator("#note-confirm")).toHaveCount(0);
  expect(publishes.filter((b: any) => b && "note_generated" in b)).toHaveLength(0);
  await expect(page.locator('[data-action="view-version"]')).toHaveCount(1);

  // Edit the draft and confirm: published with the author's words, not marked generated.
  await page.locator("#publish-btn").click();
  await expect(page.locator("#note-confirm-text")).toHaveValue("Tightened the second line.");
  await page.locator("#note-confirm-text").fill("Tightened the second line, by hand.");
  await expect(page.locator("#note-confirm-generated")).toHaveCount(0);
  await page.locator("#note-confirm-ok").click();
  await expect(page.locator('[data-action="view-version"]')).toHaveCount(2);
  expect(publishes.at(-1)).toMatchObject({ note: "Tightened the second line, by hand.", note_generated: false });

  // With the setting off and no note, a new version publishes without asking.
  await api("PATCH", "/settings", { auto_change_notes: false });
  await page.reload();
  await input.fill(`${await input.inputValue()} Third.`);
  await page.locator("#publish-btn").click();
  await expect(page.locator('[data-action="view-version"]')).toHaveCount(3);
  await expect(page.locator("#note-confirm")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the composer list's publish asks for the note on a new version too", async ({ page }) => {
  await page.goto("/studio/login");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  const api = (m: string, p: string, d?: unknown) => page.evaluate(fixtureJson, { method: m, path: '/api' + p, body: d }).then(result => result.json);
  await api("PATCH", "/settings", { auto_change_notes: true });
  try {
    await page.route("**/note-draft", (route) => route.fulfill({ json: { note: "Reworded the opening.", model: "test", pinned_prior: false } }));
    const marker = `Row publish fixture ${Date.now()}`;
    const id = (await api("POST", "/items", { content_md: marker })).id;
    await api("POST", `/items/${id}/publish`, {});
    await api("PATCH", `/items/${id}`, { content_md: `${marker}, reworded` });
    await page.reload();
    const row = page.locator(`.item-row[data-id="${id}"]`);
    const published = page.waitForRequest((r) => r.url().endsWith(`/items/${id}/publish`));
    await expandRow(page, id);
    await row.getByRole("button", { name: "publish", exact: true }).click();
    await expect(page.locator("#note-confirm-text")).toHaveValue("Reworded the opening.");
    await expect(page.locator(".dialog-popup")).toContainText("Version 2");
    await page.locator("#note-confirm-ok").click();
    expect((await published).postDataJSON()).toMatchObject({ note: "Reworded the opening.", note_generated: true });
  } finally {
    await api("PATCH", "/settings", { auto_change_notes: false });
  }
});
