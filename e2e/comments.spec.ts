import { test, expect, type Page } from './fixture';

// Comments to self (src/comments.ts) as an author meets them: typed in the
// editor, gone from the preview and everything public, still there afterwards.
const shots = process.env.COMMENT_SHOTS;
const shot = (page: Page, name: string) =>
  shots ? page.screenshot({ path: `${shots}/${name}-${test.info().project.name}.png` }) : Promise.resolve(undefined);

async function login(page: Page) {
  await page.goto('/studio/login'); await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  }, { method, path, body });
const draft = async (page: Page, contentMd: string) => {
  const { text } = await api(page, 'POST', '/api/items', { contentMd, kind: 'fragment' });
  return JSON.parse(text).id as string;
};
const marker = () => `note${Date.now().toString(36)}`;
const editor = (page: Page) => page.locator('textarea').first();

test('a comment stays in the editor and off every public surface', async ({ page }) => {
  const secret = marker();
  await login(page);
  const id = await draft(page, 'Words the reader sees.');
  await page.goto(`/studio/edit/${id}`);
  await editor(page).fill(`Words the reader sees.\n\n/* ${secret}: check this claim */\n\nAnd the rest.`);

  // The preview is what readers get.
  const preview = page.locator('#preview-body');
  if (await preview.isVisible()) {
    await expect(preview).toContainText('And the rest.');
    await expect(preview).not.toContainText(secret);
  }
  // The counter measures what would publish, as the fragment cap does.
  await expect(page.getByText('37 / 1000')).toBeVisible();
  await shot(page, 'editor-with-comment');

  await page.getByRole('button', { name: /^publish/i }).first().click();
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) await dialog.getByRole('button', { name: /publish/i }).last().click();
  await expect.poll(async () => JSON.parse((await api(page, 'GET', `/api/items/${id}`)).text).version).toBe(1);

  // Raw wire output, read over HTTP as a subscriber does.
  const wire = await page.request.get(`/items/${id}.json`);
  expect(wire.status()).toBe(200);
  const body = await wire.text();
  expect(body).toContain('And the rest.');
  expect(body).not.toContain(secret);
  expect(await (await page.request.get('/feed.xml')).text()).not.toContain(secret);

  const pub = await page.context().newPage();
  await pub.goto(`/f/${id}/`);
  await expect(pub.locator('body')).toContainText('And the rest.');
  await expect(pub.locator('body')).not.toContainText(secret);
  if (shots) await pub.screenshot({ path: `${shots}/public-page-${test.info().project.name}.png` });
  await pub.close();

  // The note is still the author's.
  await page.goto(`/studio/edit/${id}`);
  await expect(editor(page)).toHaveValue(new RegExp(secret));
  await shot(page, 'editor-after-publish');
});

test('editing only a comment shows no unpublished changes and makes no version', async ({ page }) => {
  const secret = marker();
  await login(page);
  const id = await draft(page, 'Settled words.');
  expect((await api(page, 'POST', `/api/items/${id}/publish`, { expectedRevision: JSON.parse((await api(page, 'GET', `/api/items/${id}`)).text).revision })).status).toBe(200);
  await page.goto(`/studio/edit/${id}`);
  await editor(page).fill(`Settled words. /* ${secret} */`);
  await expect.poll(async () => JSON.parse((await api(page, 'GET', `/api/items/${id}`)).text).contentMd).toContain(secret);
  const item = JSON.parse((await api(page, 'GET', `/api/items/${id}`)).text);
  expect(item.dirty).toBe(false);
  expect(item.version).toBe(1);
  await expect(page.locator('#unpublished-badge')).toHaveCount(0);

  // A real edit still counts.
  await editor(page).fill(`Changed words. /* ${secret} */`);
  await expect(page.locator('#unpublished-badge')).toBeVisible();
});

test('an unclosed comment warns in the preview and blocks publish, saying why', async ({ page }) => {
  const secret = marker();
  await login(page);
  const id = await draft(page, 'Words.');
  await page.goto(`/studio/edit/${id}`);
  await editor(page).fill(`Words.\n\n/* ${secret} never closed`);
  // On a phone the preview is behind a tab, so this asks only that it says so.
  await expect(page.getByText(/never closed with/).first()).toBeAttached();
  await shot(page, 'unclosed-warning');

  await page.getByRole('button', { name: /^publish/i }).first().click();
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) await dialog.getByRole('button', { name: /publish/i }).last().click();
  await expect(page.getByText(/line 3 is never closed/).first()).toBeVisible();
  await shot(page, 'unclosed-blocked');
  expect(JSON.parse((await api(page, 'GET', `/api/items/${id}`)).text).version).toBe(0);
  expect((await page.request.get(`/items/${id}.json`)).status()).toBe(404);
});
