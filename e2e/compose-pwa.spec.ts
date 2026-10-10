import { test, expect, type Page } from './fixture';
import { answerSheet } from './sheets.ts';
import { expandRow, openCard } from './editor.ts';

/* Compose and the editor, PWA redesign phase 2A: list filters and rows, the
 * published banner, ⧉ copy + link and share…, link from clipboard, pour-over,
 * scan text, the editor's panes and its ⋯ menu. */

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const api = (page: Page, method: string, path: string, data?: unknown) =>
  page.evaluate(async ([method, path, data]) => {
    const r = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
    return r.json();
  }, [method, path, data] as const);
const create = async (page: Page, content_md: string, kind: 'fragment' | 'thread' = 'fragment') =>
  (await api(page, 'POST', '/items', { content_md, kind })).id as string;
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const setClipboard = (page: Page, text: string) => page.evaluate((text) => navigator.clipboard.writeText(text), text);
const select = (page: Page, selector: string, text: string) =>
  page.locator(selector).evaluate((el: HTMLTextAreaElement, text) => {
    const start = el.value.indexOf(text);
    el.focus();
    el.setSelectionRange(start, start + text.length);
  }, text);
const origin = 'http://127.0.0.1:8787';

test('the filters show drafts, unpublished changes, public and withdrawn items', async ({ page }) => {
  await login(page);
  const tag = `filter-${test.info().project.name}-${Date.now()}`;
  const draft = await create(page, `${tag} draft`);
  const pub = await create(page, `${tag} public`);
  await api(page, 'POST', `/items/${pub}/publish`, {});
  const changed = await create(page, `${tag} changed`);
  await api(page, 'POST', `/items/${changed}/publish`, {});
  await api(page, 'PATCH', `/items/${changed}`, { content_md: `${tag} changed, edited` });
  const gone = await create(page, `${tag} withdrawn`);
  await api(page, 'POST', `/items/${gone}/publish`, {});
  await api(page, 'POST', `/items/${gone}/withdraw`, {});
  await page.reload();
  const rows = (id: string) => page.locator(`.item-row[data-id="${id}"]`);
  const shows = async (filter: string, visible: string[]) => {
    await page.locator(`[data-filter="${filter}"]`).click();
    await expect(page.locator(`[data-filter="${filter}"]`)).toHaveAttribute('aria-pressed', 'true');
    for (const id of [draft, pub, changed, gone]) await expect(rows(id)).toHaveCount(visible.includes(id) ? 1 : 0);
  };
  await shows('drafts', [draft]);
  await shows('changes', [changed]);
  await shows('public', [pub, changed]);
  await shows('withdrawn', [gone]);
  await shows('all', [draft, pub, changed, gone]);
  // Each count is the number of rows its filter shows.
  for (const filter of ['drafts', 'changes', 'public', 'withdrawn', 'all']) {
    await page.locator(`[data-filter="${filter}"]`).click();
    await expect(page.locator('.item-row')).toHaveCount(Number(await page.locator(`[data-filter="${filter}"] .n`).textContent()));
  }
  // The row says what it is without opening.
  await expect(rows(changed).locator('.item-meta')).toContainText('public · v1 · unpublished changes');
  await expect(rows(changed).locator('.dot')).toHaveClass(/dirty/);
  await expect(rows(gone).locator('.dot')).toHaveClass(/withdrawn/);
});

test('a row expands to its preview, facts and actions, and quick edit and full editor work from it', async ({ page }) => {
  await login(page);
  const marker = `Row fixture ${test.info().project.name} ${Date.now()}`;
  const id = await create(page, `**${marker}** body`);
  await api(page, 'POST', `/items/${id}/publish`, {});
  await page.reload();
  const row = page.locator(`.item-row[data-id="${id}"]`);
  await expect(row.locator('.item-head')).toHaveAttribute('aria-expanded', 'false');
  await expect(row.getByRole('button', { name: 'withdraw', exact: true })).toHaveCount(0);
  await expandRow(page, id);
  await expect(row.locator('.item-detail strong')).toHaveText(marker);
  await expect(row).toContainText('Created:');
  await expect(row.locator('.version-summary')).toContainText('1 version');
  for (const name of ['quick edit', 'full editor', '⧉ copy + link', 'share…', 'pin v1…', 'withdraw'])
    await expect(row.getByRole(name === 'full editor' ? 'link' : 'button', { name, exact: true })).toBeVisible();
  // A public item with no unpublished changes offers no publish and no discard.
  await expect(row.getByRole('button', { name: 'publish', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'discard', exact: true })).toHaveCount(0);
  await row.getByRole('button', { name: 'quick edit', exact: true }).click();
  await row.getByRole('textbox', { name: 'quick edit' }).fill(`${marker} edited`);
  await row.getByRole('button', { name: 'save draft', exact: true }).click();
  await expect(row.locator('.save-state')).toHaveText('saved');
  await row.getByRole('link', { name: 'full editor', exact: true }).click();
  await expect(page.locator('#md-input')).toHaveValue(`${marker} edited`);
});

test('publishing shows the banner, and ⧉ copy + link copies plain text and the permalink', async ({ page }) => {
  await login(page);
  const marker = `Banner ${test.info().project.name} ${Date.now()}`;
  await page.locator('#composer-text').fill(`# ${marker}\n\nSome **bold** words and a [link](https://example.com/x).\n\n> a quoted line`);
  await page.locator('#publish-btn').click();
  const banner = page.locator('#published-banner');
  await expect(banner).toContainText('published v1');
  const href = (await banner.getByRole('link', { name: 'public permalink ↗' }).getAttribute('href'))!;
  expect(href).toMatch(/^\/f\/[0-9a-z]{26}\/$/);
  expect((await page.request.get(href)).status()).toBe(200);
  await banner.getByRole('button', { name: '⧉ copy + link' }).click();
  await expect(page.locator('.toast')).toHaveText('copied text + link');
  expect(await clipboard(page)).toBe(`${marker}\n\nSome bold words and a link.\n\n“a quoted line”\n\n${origin}${href}`);
  await banner.getByRole('button', { name: 'dismiss' }).click();
  await expect(banner).toHaveCount(0);
});

test('share… hands the share sheet the title, text and permalink, and falls back to copying', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as unknown as { shared: unknown[] };
    host.shared = [];
    Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: async (data: unknown) => void host.shared.push(data) });
  });
  await login(page);
  const marker = `Share ${test.info().project.name} ${Date.now()}`;
  const id = await create(page, `${marker} with [TK]impyrt=generated words[/TK].`);
  await api(page, 'POST', `/items/${id}/publish`, {});
  await page.reload();
  const row = await expandRow(page, id);
  await row.getByRole('button', { name: 'share…', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { shared: unknown[] }).shared)).toEqual([
    { title: `${marker} with generated words.`, text: `${marker} with generated words.`, url: `${origin}/f/${id}/` },
  ]);
  // No share sheet: the same text + link goes to the clipboard instead.
  await page.evaluate(() => Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: undefined }));
  await row.getByRole('button', { name: 'share…', exact: true }).click();
  await expect(page.locator('.toast')).toHaveText('no share sheet here — copied text + link instead');
  expect(await clipboard(page)).toBe(`${marker} with generated words.\n\n${origin}/f/${id}/`);
});

test('link from clipboard strips trackers and links the selection, or asks for a URL', async ({ page }) => {
  await login(page);
  const box = page.locator('#composer-text');
  await box.fill('Read the essay today.');
  await setClipboard(page, 'https://www.example.com/essay?id=7&utm_source=newsletter&fbclid=IwAR0x');
  await select(page, '#composer-text', 'the essay');
  await page.locator('[data-action="link-clipboard"]').click();
  await expect(box).toHaveValue('Read [the essay](https://www.example.com/essay?id=7) today.');
  await expect(page.locator('.toast')).toHaveText('linked selection · 2 trackers removed');
  // Not a URL on the clipboard: a sheet asks for one; nothing selected makes an autolink.
  await setClipboard(page, 'just some words');
  await box.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await page.locator('[data-action="link-clipboard"]').click();
  await answerSheet(page, { name: 'link from clipboard', text: 'https://example.org/p?gclid=1' });
  await expect(box).toHaveValue('Read [the essay](https://www.example.com/essay?id=7) today.<https://example.org/p>');
});

test('pasting a lone URL over a selection links it, in the composer and the editor', async ({ page }) => {
  await login(page);
  const paste = (selector: string, text: string) =>
    page.locator(selector).evaluate((el, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      return el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
  const box = page.locator('#composer-text');
  await box.fill('see this page');
  await select(page, '#composer-text', 'this page');
  expect(await paste('#composer-text', 'https://example.com/p?utm_medium=x')).toBe(false);
  await expect(box).toHaveValue('see [this page](https://example.com/p)');
  // No selection, or not a URL: an ordinary paste the browser performs.
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
  expect(await paste('#composer-text', 'https://example.com/q')).toBe(true);
  await select(page, '#composer-text', 'see');
  expect(await paste('#composer-text', 'not a url')).toBe(true);
  await page.locator('#composer-full').click();
  const editor = page.locator('#md-input');
  await expect(editor).toHaveValue('see [this page](https://example.com/p)');
  await select(page, '#md-input', 'see');
  expect(await paste('#md-input', 'https://example.net/')).toBe(false);
  await expect(editor).toHaveValue('[see](https://example.net/) [this page](https://example.com/p)');
});

test('the composer tools: kind pills, the over-length hint, [[ and [TK]', async ({ page }) => {
  await login(page);
  const box = page.locator('#composer-text');
  await expect(page.getByRole('radio', { name: 'fragment', exact: true })).toBeChecked();
  await expect(page.locator('[data-action="bracket-quote"]')).toHaveCount(0);
  await box.fill('x'.repeat(1001));
  await expect(page.locator('#composer-count')).toHaveClass(/over/);
  await page.getByRole('button', { name: 'make this a thread', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'thread', exact: true })).toBeChecked();
  await expect(page.locator('#composer-count')).not.toHaveClass(/over/);
  await expect(page.locator('[data-action="bracket-quote"]')).toHaveCount(1);
  await box.fill('Summarise this');
  await select(page, '#composer-text', 'Summarise this');
  await page.locator('[data-action="tk"]').click();
  await expect(box).toHaveValue('[TK]Summarise this[/TK]');
  await box.fill('Linking ');
  await box.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await page.locator('[data-action="bracket-link"]').click();
  await expect(box).toHaveValue('Linking [[');
  await expect(page.getByRole('listbox', { name: 'items' })).toBeVisible();
});

test('a composer tool leaves the caret where it belongs before anything else can type', async ({ page }) => {
  // The tools used to place the caret on the next animation frame. Until it
  // came, React had reset the caret to the end, and when it came it moved the
  // caret under whatever had selected or typed meanwhile — CI's fill() got
  // "[TK]Summarise this[/TK]Linking [[" (studio, 2026-10). Each check below
  // reads the textarea before the task that clicked ends: no frame can run.
  await login(page);
  await page.getByRole('radio', { name: 'thread', exact: true }).click();
  const box = page.locator('#composer-text');
  const clickNow = (text: string, from: number, to: number, action: string) =>
    box.evaluate(async (el: HTMLTextAreaElement, [text, from, to, action]) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setValue.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      el.setSelectionRange(from, to);
      (document.querySelector(`[data-action="${action}"]`) as HTMLButtonElement).click();
      // Let React finish its microtask work; a frame cannot run in between.
      for (let i = 0; i < 10; i++) await null;
      return { value: el.value, selected: el.value.slice(el.selectionStart, el.selectionEnd), caret: el.selectionStart, focused: document.activeElement === el };
    }, [text, from, to, action] as const);
  expect(await clickNow('Summarise this', 0, 14, 'tk')).toEqual({ value: '[TK]Summarise this[/TK]', selected: '', caret: 23, focused: true });
  expect(await clickNow('Before after', 7, 7, 'tk')).toEqual({ value: 'Before [TK]an instruction[/TK]after', selected: 'an instruction', caret: 11, focused: true });
  expect(await clickNow('Linking  here', 8, 8, 'bracket-link')).toEqual({ value: 'Linking [[ here', selected: '', caret: 10, focused: true });
  expect(await clickNow('Quote\nthis', 5, 5, 'bracket-quote')).toEqual({ value: 'Quote\n![[\nthis', selected: '', caret: 9, focused: true });
});

test.describe('scan text', () => {
  test('instructs for this platform and loads no OCR unless opted in and a photo is chosen', async ({ page }) => {
    const cdn: string[] = [];
    page.on('request', (r) => { if (r.url().includes('jsdelivr')) cdn.push(r.url()); });
    await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* not the pinned file */' }));
    await login(page);
    await page.locator('#composer-text').fill('before after');
    await page.locator('#composer-text').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
    await page.locator('[data-action="scan"]').click();
    const sheet = page.getByRole('dialog', { name: 'scan text' });
    await expect(sheet).toBeVisible();
    if (test.info().project.name === 'mobile') {
      // iPhone: the iOS scanner only.
      await expect(sheet.locator('[data-platform="ios"]')).toContainText('Long-press the text box and tap Scan Text');
      await expect(sheet.locator('[data-platform="android"]')).toHaveCount(0);
    } else {
      await expect(sheet.locator('[data-platform="ios"]')).toContainText('Scan Text');
      await expect(sheet.locator('[data-platform="android"]')).toContainText('Google Lens');
    }
    // Opting in shows the photo buttons, and still fetches nothing.
    await expect(sheet.getByRole('button', { name: 'choose a photo' })).toHaveCount(0);
    await sheet.getByRole('checkbox', { name: /read a photo on this device/ }).check();
    await expect(sheet.getByRole('button', { name: 'choose a photo' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(cdn).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('blyg-studio-ocr'))).toBe('on');
    // Choosing a photo loads the pinned script, and SRI refuses anything else.
    const chooser = page.waitForEvent('filechooser');
    await sheet.getByRole('button', { name: 'choose a photo' }).click();
    await (await chooser).setFiles({ name: 'page.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
    await expect(sheet.getByRole('status')).toHaveText('could not load the text reader');
    expect(cdn).toEqual(['https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js']);
    expect(await page.locator('script[src*="tesseract"]').count()).toBe(0);
    await page.getByRole('button', { name: 'close', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    // Off again: nothing offered.
    await page.locator('[data-action="scan"]').click();
    await sheet.getByRole('checkbox', { name: /read a photo on this device/ }).uncheck();
    await expect(sheet.getByRole('button', { name: 'choose a photo' })).toHaveCount(0);
    // show me where: back to the text box at the saved cursor, with a coach mark.
    await sheet.getByRole('button', { name: 'show me where' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.coach')).toBeVisible();
    await expect(page.locator('#composer-text')).toBeFocused();
    expect(await page.locator('#composer-text').evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(7);
  });

  test.describe('on Android', () => {
    test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' });
    test('points at the keyboard scanner or Google Lens', async ({ page }) => {
      const cdn: string[] = [];
      page.on('request', (r) => { if (r.url().includes('jsdelivr')) cdn.push(r.url()); });
      await login(page);
      await page.locator('[data-action="scan"]').click();
      const sheet = page.getByRole('dialog', { name: 'scan text' });
      await expect(sheet.locator('[data-platform="android"]')).toContainText('Otherwise open Google Lens, point it at the text, tap Copy text, and paste here.');
      await expect(sheet.locator('[data-platform="ios"]')).toHaveCount(0);
      await sheet.getByRole('button', { name: 'show me where' }).click();
      await expect(page.locator('.coach')).toHaveText('Look for scan text / Lens on your keyboard');
      expect(cdn).toEqual([]);
    });
  });
});

test('the editor shows one pane at a time on a phone and both side by side on a desktop', async ({ page }) => {
  await login(page);
  const id = await create(page, 'Pane **fixture**');
  await page.goto(`/studio/edit/${id}`);
  const draft = page.locator('#md-input');
  const preview = page.locator('#preview-pane');
  await expect(page.locator('#preview-body strong')).toHaveText('fixture');
  // No tab bar in the editor: its own action bar instead.
  await expect(page.locator('nav.tabbar')).toHaveCount(0);
  await expect(page.locator('.actionbar #publish-btn')).toBeVisible();
  await expect(page.locator('.ed-head')).toContainText('fragment · draft · v0');
  if (test.info().project.name === 'mobile') {
    await expect(draft).toBeVisible();
    await expect(preview).toBeHidden();
    await page.getByRole('button', { name: 'preview', exact: true }).click();
    await expect(preview).toBeVisible();
    await expect(draft).toBeHidden();
    await page.getByRole('button', { name: 'draft', exact: true }).click();
    await expect(draft).toBeVisible();
  } else {
    await expect(page.locator('.pane-toggle')).toBeHidden();
    await expect(draft).toBeVisible();
    await expect(preview).toBeVisible();
    const [a, b] = [await draft.boundingBox(), await preview.boundingBox()];
    expect(b!.x).toBeGreaterThan(a!.x + a!.width - 1);
  }
});

test('the editor ⋯ menu copies, pins and withdraws, and the Version-N dialog still asks', async ({ page }) => {
  await login(page);
  const marker = `Menu ${test.info().project.name} ${Date.now()}`;
  const id = await create(page, marker);
  await page.goto(`/studio/edit/${id}`);
  const menuRow = async (label: string) => {
    await page.getByRole('button', { name: 'more actions' }).click();
    const sheet = page.getByRole('dialog', { name: 'actions' });
    await sheet.getByRole('button', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click();
  };
  // A draft: make this a…, discard draft — nothing that needs a public item.
  await page.getByRole('button', { name: 'more actions' }).click();
  const sheet = page.getByRole('dialog', { name: 'actions' });
  await expect(sheet.locator('.ml')).toHaveText(['make this a thread', 'discard draft']);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await page.locator('#publish-btn').click();
  await expect(page.locator('#published-banner')).toContainText('published v1');
  await expect(page.locator('.ed-head')).toContainText('public · v1');
  await page.getByRole('button', { name: 'more actions' }).click();
  await expect(sheet.locator('.ml')).toContainText(['public permalink ↗', 'copy + link', 'share…', 'pin v1…', 'withdraw']);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await menuRow('copy + link');
  await expect.poll(() => clipboard(page)).toBe(`${marker}\n\n${origin}/f/${id}/`);
  await menuRow('pin v1…');
  const pinned = page.waitForResponse((r) => r.url().endsWith(`/api/items/${id}/versions/1/pin`));
  await answerSheet(page, { name: /^Pin v1\? This is irrevocable/ });
  expect((await pinned).ok()).toBe(true);
  await openCard(page, 'history');
  await expect(page.getByRole('link', { name: '📌 pinned', exact: true })).toBeVisible();
  // An edit with a note: the Version-N confirmation still opens before publishing.
  await page.locator('#md-input').fill(`${marker}, edited`);
  await expect(page.locator('#unpublished-badge')).toBeVisible();
  await expect(page.locator('#note-card')).toHaveAttribute('open', '');
  await page.locator('#note-input').fill('Edited the sentence.');
  await page.locator('#publish-btn').click();
  await expect(page.getByRole('dialog', { name: 'Version 2' })).toBeVisible();
  await expect(page.locator('#note-confirm-text')).toHaveValue('Edited the sentence.');
  await page.locator('#note-confirm-ok').click();
  await expect(page.locator('#published-banner')).toContainText('published v2');
  await menuRow('withdraw');
  await answerSheet(page, { name: /^Withdraw this item\?/ });
  await expect(page.locator('.ed-head')).toContainText('withdrawn');
  await expect(page.locator('#publish-btn')).toHaveText('republish');
});
