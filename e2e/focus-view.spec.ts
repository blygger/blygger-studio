import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture';

// The editor's focus view: only the text, filling the screen. It is the same
// textarea in another state, so what matters is what survives the toggle (text,
// caret, undo, autosave) and that a failed save can still be seen.
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path: `/api${path}`, body });
async function open(page: Page, contentMd: string) {
  await login(page);
  const { json } = await api(page, 'POST', '/items', { contentMd, kind: 'thread' });
  await page.goto(`/studio/edit/${json.id}`);
  await expect(page.locator('#md-input')).toBeVisible();
  return json.id as string;
}
const enter = (page: Page) => page.getByRole('button', { name: 'focus view', exact: true }).click();
const exit = (page: Page) => page.getByRole('button', { name: 'exit focus view', exact: true }).click();
const box = (page: Page) => page.locator('#md-input');
/** Whether the caret's line is inside the textarea's visible window. */
const caretInView = (page: Page) =>
  box(page).evaluate((el: HTMLTextAreaElement) => {
    const lines = el.value.slice(0, el.selectionEnd).split('\n').length;
    const y = lines * parseFloat(getComputedStyle(el).lineHeight);
    return y >= el.scrollTop && y <= el.scrollTop + el.clientHeight + parseFloat(getComputedStyle(el).paddingTop);
  });

test('focus view shows only the text, fills the window, and leaves everything as it was', async ({ page }) => {
  await open(page, 'Only the text.');
  await enter(page);
  const size = page.viewportSize()!;
  await expect(page.locator('.editor')).toHaveClass(/is-focus/);
  const rect = (await box(page).boundingBox())!;
  expect(rect.width).toBeGreaterThanOrEqual(size.width - 1);
  expect(rect.height).toBeGreaterThanOrEqual(size.height - 1);
  for (const hidden of ['.topbar', '.ed-head', '.ed-tools', '.ed-foot', '.preview-pane', '.ed-cards', '.actionbar', '.pane-toggle', '.syntax-help']) await expect(page.locator(hidden)).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await exit(page);
  await expect(page.locator('.editor')).not.toHaveClass(/is-focus/);
  for (const shown of ['.topbar', '.ed-head', '.ed-tools', '.actionbar']) await expect(page.locator(shown)).toBeVisible();
  await expect(box(page)).toHaveValue('Only the text.');
});

test('the text measure is centred on a wide window', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a phone has no margins to centre in');
  await open(page, 'Centred.');
  await enter(page);
  const measure = await box(page).evaluate((el) => {
    const style = getComputedStyle(el);
    return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight), width: el.clientWidth };
  });
  expect(measure.left).toBe(measure.right);
  expect(measure.left).toBeGreaterThan(100);
  expect(measure.width - measure.left - measure.right).toBeLessThanOrEqual(800);
});

test('text, caret and undo carry through, and the writer keeps typing where they were', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the caret is placed by keyboard');
  await open(page, 'Before after');
  await box(page).evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(7, 7); });
  await page.keyboard.type('middle ');
  await enter(page);
  await expect(box(page)).toBeFocused();
  expect(await box(page).evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(14);
  await page.keyboard.type('and ');
  await expect(box(page)).toHaveValue('Before middle and after');
  await page.keyboard.press('Escape');
  await expect(page.locator('.editor')).not.toHaveClass(/is-focus/);
  await expect(box(page)).toBeFocused();
  expect(await box(page).evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(18);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(box(page)).not.toHaveValue('Before middle and after');
});

test('the keyboard chord goes in and out; Escape does nothing outside the view', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a phone has no chord');
  await open(page, 'Chord.');
  await box(page).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.editor')).not.toHaveClass(/is-focus/);
  for (const modifier of ['Control', 'Meta']) {
    await page.keyboard.press(`${modifier}+Shift+Enter`);
    await expect(page.locator('.editor')).toHaveClass(/is-focus/);
    await page.keyboard.press(`${modifier}+Shift+Enter`);
    await expect(page.locator('.editor')).not.toHaveClass(/is-focus/);
  }
  await expect(box(page)).toHaveValue('Chord.');
});

test('autosave keeps working inside the view', async ({ page }) => {
  const id = await open(page, 'Saved ');
  await enter(page);
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/items/${id}`) && r.request().method() === 'PATCH' && r.status() === 200);
  await box(page).fill('Saved from focus view.');
  await saved;
  const { json } = await api(page, 'GET', `/items/${id}`);
  expect(json.contentMd).toBe('Saved from focus view.');
});

test('a failed autosave shows in the view; half-typed link errors do not', async ({ page }) => {
  const id = await open(page, 'Fails.');
  await enter(page);
  await box(page).fill('See [[nothing-here]]');
  await expect(page.locator('#preview-body')).toBeAttached();
  await page.waitForResponse((r) => r.url().includes('/preview'));
  await expect(page.locator('#error-banner-slot .banner')).toHaveCount(0);
  await page.route(`**/api/items/${id}`, (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 500, json: { code: 'internal', message: 'save rejected' } }) : route.continue());
  await box(page).fill('See [[nothing-here]] and more.');
  await expect(page.locator('#error-banner-slot')).toContainText('save rejected');
  await expect(box(page)).toHaveValue('See [[nothing-here]] and more.');
  await page.unroute(`**/api/items/${id}`);
});

test('Escape closes the picker first, and only the next one leaves the view', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a phone has no Escape');
  await open(page, 'Linking ');
  await enter(page);
  await box(page).focus();
  await box(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(8, 8));
  await page.keyboard.type('[[');
  await expect(page.locator('.picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.picker')).toBeHidden();
  await expect(page.locator('.editor')).toHaveClass(/is-focus/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.editor')).not.toHaveClass(/is-focus/);
});

test('the caret stays on screen through the toggle in a long draft', async ({ page }) => {
  const lines = Array.from({ length: 300 }, (_, i) => `Line ${i}.`).join('\n');
  await open(page, lines);
  await box(page).evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(el.value.length - 3, el.value.length - 3); });
  await enter(page);
  await expect.poll(() => caretInView(page)).toBe(true);
  await exit(page);
  await expect.poll(() => caretInView(page)).toBe(true);
});

test('entering from the phone preview pane shows the draft, not nothing', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'desktop shows both panes');
  await open(page, 'Back to the draft.');
  await page.locator('.pane-toggle [data-pane=preview]').click();
  await expect(box(page)).toBeHidden();
  await enter(page);
  await expect(box(page)).toBeVisible();
  await exit(page);
  await expect(box(page)).toBeVisible();
  await expect(page.locator('.pane-toggle [data-pane=draft]')).toHaveAttribute('aria-pressed', 'true');
});

test('leaving the editor does not strand the studio in the view', async ({ page }) => {
  await open(page, 'Back.');
  await enter(page);
  await expect(page.locator('body')).toHaveClass(/focus-view/);
  await page.goBack();
  await expect(page.locator('body')).not.toHaveClass(/focus-view/);
  await expect(page.locator('.topbar')).toBeVisible();
});

test('the exit and enter controls are full-size targets', async ({ page }) => {
  await open(page, 'Targets.');
  const enterBox = (await page.getByRole('button', { name: 'focus view', exact: true }).boundingBox())!;
  expect(enterBox.height).toBeGreaterThanOrEqual(40);
  await enter(page);
  const exitBox = (await page.getByRole('button', { name: 'exit focus view', exact: true }).boundingBox())!;
  expect(exitBox.height).toBeGreaterThanOrEqual(40);
  expect(exitBox.x + exitBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

// A real browser keeps Escape for itself in fullscreen and the page sees only the
// exit, so exitFullscreen() here stands in for that key.
test('the view goes browser-fullscreen, and leaving fullscreen leaves the view', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'iPhone has no Fullscreen API; the view works without it');
  await open(page, 'Fullscreen ');
  const fullscreen = () => page.evaluate(() => !!document.fullscreenElement);
  await enter(page);
  await expect.poll(fullscreen).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.locator('.editor')).not.toHaveClass(/is-focus/);
  // The exit button gives fullscreen back too.
  await enter(page);
  await expect.poll(fullscreen).toBe(true);
  await exit(page);
  await expect.poll(fullscreen).toBe(false);
  // With the picker open, that Escape was for the picker: the view stays.
  await enter(page);
  await expect.poll(fullscreen).toBe(true);
  await box(page).focus();
  await page.keyboard.press('End');
  await page.keyboard.type('[[');
  await expect(page.locator('.picker')).toBeVisible();
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(fullscreen).toBe(false);
  await expect(page.locator('.editor')).toHaveClass(/is-focus/);
});
