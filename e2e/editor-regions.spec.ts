import { test, expect, type Page } from './fixture';

// The editorRegions slot, through extensions/regions-example: a paragraph that starts with
// `[held]: #` is kept out of the full editor's text box, hidden each time the editor opens and
// read-only when shown, while the draft keeps the whole text.
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
/** Put the caret just after `text` in the box. */
const caretAfter = (page: Page, text: string) =>
  page.locator('#md-input').evaluate((el: HTMLTextAreaElement, text) => {
    el.focus();
    const at = el.value.indexOf(text) + text.length;
    el.setSelectionRange(at, at);
  }, text);

test.beforeEach(async ({ page }) => {
  await login(page);
  await setExtensions(page, ['regions-example']);
});
test.afterEach(async ({ page }) => {
  await setExtensions(page, []);
});

test('held-out text: hidden in the box, kept in the draft, read-only when shown, hidden again on reopening', async ({ page }) => {
  const run = `rg${Date.now().toString(36)}`;
  const held = '\n\n[held]: # generated line';
  const id = await createDraft(page, `Regions ${run}\n\nFirst paragraph.${held}\n\nLast paragraph.`);
  const box = page.locator('#md-input');
  const notice = page.locator('.ed-foot .held-out');

  await page.goto(`/studio/edit/${id}`);
  await expect(box).toHaveValue(`Regions ${run}\n\nFirst paragraph.\n\nLast paragraph.`);
  await expect(notice).toHaveText('held paragraph hidden show');
  await expect(notice).toHaveAttribute('data-held-out', 'hidden');

  // Typed where the paragraph was cut: the text joins the paragraph above, before the held one.
  await caretAfter(page, 'First paragraph.');
  await page.keyboard.type(' Added.');
  // And at the end of the box.
  await caretAfter(page, 'Last paragraph.');
  await page.keyboard.type(' More.');
  await expect.poll(() => draftText(page, id)).toBe(`Regions ${run}\n\nFirst paragraph. Added.${held}\n\nLast paragraph. More.`);

  // Shown: the whole text, and the held paragraph refuses edits; text around it still edits.
  await notice.getByRole('button', { name: 'show' }).click();
  await expect(notice).toHaveAttribute('data-held-out', 'shown');
  await expect(notice).toHaveText('held paragraph read-only hide');
  await expect(box).toHaveValue(`Regions ${run}\n\nFirst paragraph. Added.${held}\n\nLast paragraph. More.`);
  await caretAfter(page, 'generated');
  await page.keyboard.type('X');
  await expect(page.getByText('The held paragraph is read-only here.')).toBeVisible();
  await expect(box).toHaveValue(`Regions ${run}\n\nFirst paragraph. Added.${held}\n\nLast paragraph. More.`);
  await caretAfter(page, 'More.');
  await page.keyboard.type(' End.');
  await expect.poll(() => draftText(page, id)).toBe(`Regions ${run}\n\nFirst paragraph. Added.${held}\n\nLast paragraph. More. End.`);

  // Hide, then reopen: hidden again, since showing is not remembered.
  await notice.getByRole('button', { name: 'hide' }).click();
  await expect(box).toHaveValue(`Regions ${run}\n\nFirst paragraph. Added.\n\nLast paragraph. More. End.`);
  await notice.getByRole('button', { name: 'show' }).click();
  await page.reload();
  await expect(box).toHaveValue(`Regions ${run}\n\nFirst paragraph. Added.\n\nLast paragraph. More. End.`);
  await expect(notice).toHaveAttribute('data-held-out', 'hidden');

  // The preview has the whole text.
  await expect(page.locator('.editor-pane, .preview, #preview').getByText('generated line').first()).toBeAttached();
});

test('with the extension off, the editor is the reference editor', async ({ page }) => {
  await setExtensions(page, []);
  const id = await createDraft(page, `Off ${Date.now().toString(36)}\n\n[held]: # generated line`);
  await page.goto(`/studio/edit/${id}`);
  await expect(page.locator('#md-input')).toHaveValue(/\[held\]: # generated line$/);
  await expect(page.locator('.ed-foot .held-out')).toHaveCount(0);
});
