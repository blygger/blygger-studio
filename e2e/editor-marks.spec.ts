import { test, expect, type Page } from './fixture';

// Editor marks, through extensions/bars-example, which underlines every TODO: a layer laid
// exactly over the text box, following edits and scrolling, handing a click to the bar, and gone
// when the bar is hidden or in focus view.
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
  page.evaluate(async (contentMd) => (await (await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentMd, kind: 'thread' }) })).json()).id as string, contentMd);
/** The layer's text without its trailing zero-width space, and whether its box sits on the text box's. */
const layer = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('.ed-marks') as HTMLElement | null;
    const ta = document.querySelector('#md-input') as HTMLTextAreaElement;
    if (!box) return null;
    const a = box.getBoundingClientRect();
    const b = ta.getBoundingClientRect();
    return { text: box.textContent!.replace(/​$/, ''), value: ta.value, top: Math.abs(a.top - b.top), left: Math.abs(a.left - b.left), width: Math.abs(b.width - a.width) };
  });

test.beforeEach(async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.removeItem('blyg.editorBars.hidden'));
  await setExtensions(page, ['bars-example']);
});
test.afterEach(async ({ page }) => {
  await setExtensions(page, []);
});

test('marks lie on the text, follow an edit, and a click on one reaches the bar', async ({ page }) => {
  const id = await createDraft(page, 'Intro TODO one.\n\nAnd TODO two.');
  await page.goto(`/studio/edit/${id}`);
  const marks = page.locator('.ed-marks .ed-mark-note');
  await expect(marks).toHaveCount(2);
  await expect(marks.first()).toHaveText('TODO');
  let l = (await layer(page))!;
  expect(l.text).toBe(l.value);
  expect(l.top).toBeLessThan(1);
  expect(l.left).toBeLessThan(1);
  // The layer is as wide as the box less any scrollbar.
  expect(l.width).toBeLessThan(20);

  // An edit before them: still two, still on the text.
  await page.locator('#md-input').evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(0, 0); });
  await page.keyboard.type('A ');
  await expect(marks).toHaveCount(2);
  l = (await layer(page))!;
  expect(l.text).toBe(l.value);

  // A click lands on the text box (the layer takes no pointer events) and the bar hears it.
  const at = await marks.nth(1).boundingBox();
  await page.mouse.click(at!.x + at!.width / 2, at!.y + at!.height / 2);
  await expect(page.locator('#md-input')).toBeFocused();
  await expect(page.getByText(/TODO at \d+/)).toBeVisible();

  // The browser's own spellcheck stays: this bar doesn't replace it.
  await expect(page.locator('#md-input')).not.toHaveAttribute('spellcheck', 'false');
});

test('marks scroll with the text box', async ({ page }) => {
  const id = await createDraft(page, `${'Line of text.\n\n'.repeat(80)}Last TODO here.`);
  await page.goto(`/studio/edit/${id}`);
  await expect(page.locator('.ed-mark-note')).toHaveCount(1);
  const offset = await page.evaluate(() => {
    const ta = document.querySelector('#md-input') as HTMLTextAreaElement;
    ta.scrollTop = ta.scrollHeight;
    return ta.scrollTop;
  });
  expect(offset).toBeGreaterThan(0);
  await expect.poll(() => page.locator('.ed-marks-text').evaluate((el) => (el as HTMLElement).style.transform)).toContain(`-${offset}px`);
});

test('hidden from the bars menu or in focus view, the bar marks nothing', async ({ page }) => {
  const id = await createDraft(page, 'A TODO here.');
  await page.goto(`/studio/edit/${id}`);
  await expect(page.locator('.ed-marks')).toHaveCount(1);
  await page.getByRole('button', { name: 'focus view' }).click();
  await expect(page.locator('.ed-marks')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.ed-marks')).toHaveCount(1);
  await page.getByRole('button', { name: 'editor bars' }).click();
  await page.locator('.ext-bars-list li[data-extension="bars-example"]').getByRole('checkbox').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ed-marks')).toHaveCount(0);
});

test('the composer has marks too', async ({ page }) => {
  await page.goto('/studio/');
  await page.locator('#composer-text').fill('Remember the TODO.');
  await expect(page.locator('.composer .ed-mark-note')).toHaveText('TODO');
});
