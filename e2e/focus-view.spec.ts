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
const bar = (page: Page) => page.locator('.focus-bar');
/** Bring the controls back the way a writer would: pointer to the top, or a tap there. */
async function reveal(page: Page) {
  if ((await bar(page).getAttribute('data-shown')) === 'true') return;
  if (page.viewportSize()!.width < 600) await page.locator('.focus-hot').tap();
  else await page.mouse.move(page.viewportSize()!.width / 2, 10);
  await expect(bar(page)).toHaveAttribute('data-shown', 'true');
}
async function exit(page: Page) {
  await reveal(page);
  await page.getByRole('button', { name: 'exit focus view', exact: true }).click();
}
const tab = (page: Page, name: 'write' | 'preview') => page.locator(`.focus-bar [data-tab=${name === 'write' ? 'draft' : 'preview'}]`);
/**
 * How far the last line of the text sits from where it should, in lines. Measured
 * from the scroll geometry rather than by laying the text out again, as the code
 * under test does: with the caret at the end, the caret's line is the last line.
 */
const lastLineOffCentre = (page: Page, middle?: number) =>
  box(page).evaluate((el: HTMLTextAreaElement, middle) => {
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight);
    const y = el.scrollHeight - parseFloat(style.paddingBottom) - lineHeight / 2 - el.scrollTop;
    return Math.abs(y - (middle ?? el.clientHeight / 2)) / lineHeight;
  }, middle);
const longDraft = Array.from({ length: 120 }, (_, i) => `Line ${i}.`).join('\n');
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
  const previewed = page.waitForResponse((r) => r.url().includes('/preview'));
  await box(page).fill('See [[00000000000000000000000000]] and @nobody');
  await previewed;
  await page.waitForTimeout(100);
  await expect(page.locator('#error-banner-slot')).toBeEmpty();
  await page.route(`**/api/items/${id}`, (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 500, json: { code: 'internal', message: 'save rejected' } }) : route.continue());
  await box(page).fill('See [[00000000000000000000000000]] and more.');
  await expect(page.locator('#error-banner-slot')).toContainText('save rejected');
  await expect(box(page)).toHaveValue('See [[00000000000000000000000000]] and more.');
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

test('typewriter: the line being written stays mid-window, across soft wraps and at the end of the text', async ({ page }) => {
  await open(page, longDraft + '\n');
  await enter(page);
  await box(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  const words = 'The ooze hardens slowly and then all at once, which is the whole trouble with it. '.repeat(3);
  for (const char of words) {
    await page.keyboard.type(char);
    expect(await lastLineOffCentre(page)).toBeLessThan(1);
  }
  // It really wrapped: the last logical line takes several lines on screen.
  expect(await box(page).evaluate((el: HTMLTextAreaElement) => {
    const style = getComputedStyle(el);
    const lines = (el.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight);
    return lines - el.value.split('\n').length;
  })).toBeGreaterThan(0);
});

test('typewriter: the caret keys recentre, a click and a selection do not, and scrolling away is left alone', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'mouse and keyboard');
  await open(page, longDraft);
  await enter(page);
  // Going fullscreen resizes the box late, and the view recentres on the caret for
  // that: let it finish, so that what moves the text below is only what each step does.
  await page.waitForTimeout(1600);
  const scrollTop = () => box(page).evaluate((el: HTMLTextAreaElement) => el.scrollTop);
  const caretLine = () => box(page).evaluate((el: HTMLTextAreaElement) => el.value.slice(0, el.selectionEnd).split('\n').length);
  const lineOffCentre = () => box(page).evaluate((el: HTMLTextAreaElement) => {
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight);
    const lines = el.value.slice(0, el.selectionEnd).split('\n').length;
    return Math.abs(parseFloat(style.paddingTop) + (lines - 0.5) * lineHeight - el.scrollTop - el.clientHeight / 2) / lineHeight;
  });
  await box(page).evaluate((el: HTMLTextAreaElement) => { const at = el.value.indexOf('Line 60.'); el.setSelectionRange(at, at); });
  await page.keyboard.press('ArrowDown');
  await expect.poll(lineOffCentre).toBeLessThan(1);
  await page.keyboard.press('ArrowDown');
  await expect.poll(lineOffCentre).toBeLessThan(1);
  expect(await caretLine()).toBe(63);

  // A click places the caret where the pointer is and the text stays put.
  const before = await scrollTop();
  await page.mouse.click(640, 600);
  await page.waitForTimeout(100);
  expect(await scrollTop()).toBe(before);
  expect(await lineOffCentre()).toBeGreaterThan(3);
  // Selecting with shift or the mouse does not move the text either.
  await page.keyboard.press('Shift+ArrowDown');
  await page.waitForTimeout(100);
  expect(await scrollTop()).toBe(before);
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(600, 500, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(await scrollTop()).toBe(before);

  // Scrolling away stays where it was, until the next keystroke brings the caret back.
  await page.keyboard.press('ArrowRight');
  await page.mouse.move(640, 300);
  await page.mouse.wheel(0, -1000);
  await expect.poll(scrollTop).toBeLessThan(before - 500);
  const scrolled = await scrollTop();
  await page.waitForTimeout(300);
  expect(await scrollTop()).toBe(scrolled);
  await page.keyboard.type('x');
  await expect.poll(lineOffCentre).toBeLessThan(1);
});

// No browser here raises a real on-screen keyboard. This stands in for what one
// reports: a visual viewport shorter than the window, and a resize event.
test('typewriter: an on-screen keyboard moves the middle up to what can still be seen', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'only a touch screen keeps the extra space below for this');
  await open(page, longDraft);
  await page.evaluate(() => {
    const view = Object.assign(new EventTarget(), { height: innerHeight, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { value: view, configurable: true });
  });
  await enter(page);
  await box(page).evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  const height = await page.evaluate(() => {
    const view = window.visualViewport as unknown as EventTarget & { height: number };
    view.height = Math.round(innerHeight * 0.45);
    view.dispatchEvent(new Event('resize'));
    return view.height;
  });
  await expect.poll(() => lastLineOffCentre(page, height / 2)).toBeLessThan(1);
  await page.keyboard.type(' more');
  expect(await lastLineOffCentre(page, height / 2)).toBeLessThan(1);
  // Pinch zoom also resizes the viewport, and must not move the text.
  const before = await box(page).evaluate((el: HTMLTextAreaElement) => el.scrollTop);
  await page.evaluate(() => {
    const view = window.visualViewport as unknown as EventTarget & { height: number; scale: number };
    view.scale = 2;
    view.height = 200;
    view.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(100);
  expect(await box(page).evaluate((el: HTMLTextAreaElement) => el.scrollTop)).toBe(before);
});

test('controls: shown on the way in, gone while typing, back when the pointer nears the top', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a phone has no pointer');
  await open(page, 'Controls ');
  await enter(page);
  await expect(bar(page)).toHaveAttribute('data-shown', 'true');
  await box(page).evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await page.keyboard.type('typing');
  await expect(bar(page)).toHaveAttribute('data-shown', 'false');
  await expect(bar(page)).toHaveCSS('opacity', '0');
  await expect(bar(page)).toHaveCSS('pointer-events', 'none');
  await page.mouse.move(640, 300);
  await expect(bar(page)).toHaveAttribute('data-shown', 'false');
  await page.mouse.move(640, 20);
  await expect(bar(page)).toHaveAttribute('data-shown', 'true');
  await expect(bar(page)).toHaveCSS('opacity', '1');
  await page.mouse.move(640, 300);
  await expect(bar(page)).toHaveAttribute('data-shown', 'false');
  // Near the top but typing: typing wins, until the pointer next moves.
  await page.mouse.move(640, 20);
  await box(page).focus();
  await page.keyboard.type(' more');
  await expect(bar(page)).toHaveAttribute('data-shown', 'false');
  await expect(box(page)).toHaveValue('Controls typing more');
});

test('controls: the intro fades by itself', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one pointer case is enough');
  await open(page, 'Intro.');
  await page.mouse.move(640, 400);
  await enter(page);
  await page.mouse.move(640, 400);
  await expect(bar(page)).toHaveAttribute('data-shown', 'false', { timeout: 4000 });
});

test('controls: the keyboard reaches them while they are faded', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a phone has no Tab');
  await open(page, 'Keys ');
  await enter(page);
  await box(page).focus();
  await page.keyboard.type('x');
  await expect(bar(page)).toHaveCSS('opacity', '0');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'exit focus view', exact: true })).toBeFocused();
  await expect(bar(page)).toHaveCSS('opacity', '1');
  await page.keyboard.press('Shift+Tab');
  await expect(tab(page, 'preview')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#preview-pane')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.editor')).not.toHaveClass(/is-focus/);
});

test('controls: a tap near the top shows them without moving the caret, a tap on the text hides them', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'touch');
  await open(page, longDraft);
  await enter(page);
  await box(page).fill('Tap here\nand here');
  await expect(bar(page)).toHaveAttribute('data-shown', 'false');
  await box(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 3));
  await page.locator('.focus-hot').tap();
  await expect(bar(page)).toHaveAttribute('data-shown', 'true');
  expect(await box(page).evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(3);
  await page.touchscreen.tap(195, 400);
  await expect(bar(page)).toHaveAttribute('data-shown', 'false');
  await page.locator('.focus-hot').tap();
  await tab(page, 'preview').tap();
  await expect(page.locator('#preview-pane')).toBeVisible();
  await tab(page, 'write').tap();
  await expect(box(page)).toBeVisible();
});

test('preview tab: the same rendered preview, and write comes back with text, caret, scroll and undo', async ({ page }, info) => {
  await open(page, longDraft + '\n\nThe *ooze* hardens.');
  await enter(page);
  await box(page).evaluate((el: HTMLTextAreaElement) => { el.focus(); const at = el.value.indexOf('Line 80.'); el.setSelectionRange(at, at); });
  if (info.project.name === 'desktop') {
    await page.keyboard.type('edit ');
    await expect(box(page)).toHaveValue(/edit Line 80\./);
    await expect(bar(page)).toHaveAttribute('data-shown', 'false');
  }
  const state = () => box(page).evaluate((el: HTMLTextAreaElement) => ({ value: el.value, caret: el.selectionStart, scrollTop: el.scrollTop }));
  const before = await state();
  await reveal(page);
  await tab(page, 'preview').click();
  await expect(page.locator('#preview-body em')).toHaveText('ooze');
  await expect(page.locator('#preview-pane')).toBeVisible();
  await expect(page.locator('#preview-pane')).toBeFocused();
  await expect(box(page)).toBeHidden();
  await expect(page.locator('.preview-pane')).toHaveCount(1);
  await expect(bar(page)).toHaveAttribute('data-shown', 'true');
  await expect(tab(page, 'preview')).toHaveAttribute('aria-pressed', 'true');
  const rect = (await page.locator('#preview-pane').boundingBox())!;
  expect(rect.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 1);
  await tab(page, 'write').click();
  await expect(box(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
  await expect(page.locator('#preview-pane')).toBeHidden();
  expect(await state()).toEqual(before);
  if (info.project.name === 'desktop') {
    await page.keyboard.press('ControlOrMeta+z');
    await expect(box(page)).not.toHaveValue(/edit Line 80\./);
  }
});

test('preview tab: autosave finishes behind it, and it shows what was just typed', async ({ page }) => {
  const id = await open(page, 'Before.');
  await enter(page);
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/items/${id}`) && r.request().method() === 'PATCH' && r.status() === 200);
  await box(page).fill('Typed *then* switched.');
  await expect(bar(page)).toHaveAttribute('data-shown', 'false');
  await reveal(page);
  await tab(page, 'preview').click();
  await saved;
  await expect(page.locator('#preview-body em')).toHaveText('then');
  const { json } = await api(page, 'GET', `/items/${id}`);
  expect(json.contentMd).toBe('Typed *then* switched.');
});

test('preview tab: its shortcut switches both ways, and link warnings wait for it', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a phone has no chord');
  await open(page, 'See [[00000000000000000000000000]] and @nobody');
  await enter(page);
  await expect(page.locator('#error-banner-slot')).toBeEmpty();
  for (const modifier of ['Control', 'Meta']) {
    await page.keyboard.press(`${modifier}+Alt+Enter`);
    await expect(page.locator('#preview-pane')).toBeVisible();
    await expect(page.locator('#error-banner-slot')).toContainText('unknown item');
    await page.keyboard.press(`${modifier}+Alt+Enter`);
    await expect(box(page)).toBeVisible();
    await expect(page.locator('#error-banner-slot')).toBeEmpty();
  }
  // Outside the view it does nothing.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Alt+Enter');
  await expect(page.locator('.editor')).not.toHaveClass(/is-focus/);
  await expect(page.locator('.editor-grid')).toHaveAttribute('data-pane', 'draft');
});

test('leaving from the preview tab returns to the draft', async ({ page }) => {
  await open(page, 'Round trip.');
  await enter(page);
  await reveal(page);
  await tab(page, 'preview').click();
  await exit(page);
  await expect(page.locator('.editor')).not.toHaveClass(/is-focus/);
  await expect(box(page)).toBeVisible();
  await expect(box(page)).toHaveValue('Round trip.');
});

test('on a phone the picker dock pushes the writing line above it', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'the dock is a phone layout');
  await open(page, longDraft);
  await api(page, 'PATCH', '/settings', { pickerTyping: 'editor' });
  await page.reload();
  await expect(box(page)).toBeVisible();
  await enter(page);
  await box(page).evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await page.keyboard.type(' [[');
  await expect(page.locator('.picker')).toBeVisible();
  await page.keyboard.type('x');
  const dockTop = (await page.locator('.picker').boundingBox())!.y;
  await expect.poll(() => box(page).evaluate((el: HTMLTextAreaElement) => {
    const style = getComputedStyle(el);
    return el.scrollHeight - parseFloat(style.paddingBottom) - el.scrollTop;
  })).toBeLessThan(dockTop);
  await api(page, 'PATCH', '/settings', { pickerTyping: 'auto' });
});
