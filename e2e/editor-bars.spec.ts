import { test, expect, type Page } from './fixture';

// The editorBar slot, through extensions/bars-example (with regions-example for held-out text): a
// bar in a row of its own above the text box that inserts at the caret and takes over the
// held-out notice, the bars menu that hides it (remembered), and focus view giving the notice back.
async function login(page: Page) {
  await page.goto('/studio/login'); await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const setExtensions = (page: Page, extensions: string[]) =>
  page.evaluate(async (names) => {
    const response = await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ extensions: names }) });
    if (!response.ok) throw new Error(`settings ${response.status}`);
  }, extensions);
const createDraft = (page: Page, contentMd: string) =>
  page.evaluate(async (contentMd) => {
    const created = await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentMd, kind: 'thread' }) });
    return (await created.json()).id as string;
  }, contentMd);
const draftText = (page: Page, id: string) =>
  page.evaluate(async (id) => (await (await fetch(`/api/items/${id}`)).json()).contentMd as string, id);
const caretAfter = (page: Page, text: string) =>
  page.locator('#md-input').evaluate((el: HTMLTextAreaElement, text) => {
    el.focus();
    const at = el.value.indexOf(text) + text.length;
    el.setSelectionRange(at, at);
  }, text);

test.beforeEach(async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.removeItem('blyg.editorBars.hidden'));
  await setExtensions(page, ['bars-example', 'regions-example']);
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem('blyg.editorBars.hidden'));
  await setExtensions(page, []);
});

test('a bar inserts at the caret and owns the held-out control; hidden from the menu, the Studio notice is back', async ({ page }) => {
  const run = `eb${Date.now().toString(36)}`;
  const held = '\n\n[held]: # generated line';
  const id = await createDraft(page, `Bars ${run}\n\nFirst paragraph.${held}\n\nLast paragraph.`);
  const box = page.locator('#md-input');
  const bar = page.locator('.ext-bars-above [data-extension="bars-example"]');
  const notice = page.locator('.ed-foot .held-out');

  await page.goto(`/studio/edit/${id}`);
  await expect(box).toHaveValue(`Bars ${run}\n\nFirst paragraph.\n\nLast paragraph.`);
  await expect(bar.locator('[data-bar-place]')).toHaveAttribute('data-bar-place', 'above');
  await expect(notice).toHaveCount(0);

  // The bar's own control shows and hides the held paragraph.
  const toggle = bar.locator('[data-action=bar-regions]');
  await expect(toggle).toHaveText('show held paragraph');
  await toggle.click();
  await expect(box).toHaveValue(`Bars ${run}\n\nFirst paragraph.${held}\n\nLast paragraph.`);
  await expect(toggle).toHaveText('hide held paragraph');
  await toggle.click();
  await expect(box).toHaveValue(`Bars ${run}\n\nFirst paragraph.\n\nLast paragraph.`);

  // Insert at the caret: the draft keeps the held paragraph. The toggle puts the caret back on the
  // next frame; let that land first, or it moves the caret set here.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await caretAfter(page, 'First paragraph.');
  await bar.locator('[data-action=bar-insert]').click();
  await expect(box).toHaveValue(`Bars ${run}\n\nFirst paragraph.※\n\nLast paragraph.`);
  await expect.poll(() => draftText(page, id)).toBe(`Bars ${run}\n\nFirst paragraph.※${held}\n\nLast paragraph.`);

  // Hidden from the bars menu: gone, the Studio's notice back, and still hidden after a reload.
  await page.getByRole('button', { name: 'editor bars' }).click();
  const row = page.locator('.ext-bars-list li[data-extension="bars-example"]');
  await expect(row).toContainText('above the text');
  await row.getByRole('checkbox').uncheck();
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(notice).toHaveText('held paragraph hidden show');
  await page.reload();
  await expect(box).toBeVisible();
  await expect(bar).toHaveCount(0);
  await expect(notice).toBeVisible();
  await page.getByRole('button', { name: 'editor bars' }).click();
  await row.getByRole('checkbox').check();
  await page.keyboard.press('Escape');
  await expect(bar).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test('focus view leaves the bars out and gives the held-out notice back', async ({ page }) => {
  const id = await createDraft(page, `Focus ${Date.now().toString(36)}\n\nOne.\n\n[held]: # nav\n\nTwo.`);
  await page.goto(`/studio/edit/${id}`);
  await expect(page.locator('.ext-bars-above')).toBeVisible();
  await page.getByRole('button', { name: 'focus view' }).click();
  await expect(page.locator('.ext-bars-above')).toBeHidden();
  await expect(page.locator('.ed-foot .held-out')).toHaveText('held paragraph hidden show');
});

test('the composer has the bar too, inserting into its text', async ({ page }) => {
  await page.goto('/studio/');
  const box = page.locator('#composer-text');
  await box.fill('Hello ');
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6));
  await page.locator('.composer [data-extension="bars-example"] [data-action=bar-insert]').click();
  await expect(box).toHaveValue('Hello ※');
  await expect(page.locator('.composer [data-action=bar-regions]')).toHaveCount(0);
});

test('with no bar enabled there is no bar row and no bars menu', async ({ page }) => {
  await setExtensions(page, ['regions-example']);
  await page.goto('/studio/');
  await expect(page.locator('#composer-text')).toBeVisible();
  await expect(page.locator('.ext-bars')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'editor bars' })).toHaveCount(0);
});
