import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture';

// "The page zooms in randomly and has to be resized" (iOS Safari / the
// installed PWA). Two causes, each pinned here at the phone viewport:
//  - a form field under 16px zooms the page when it takes focus and the page
//    does not zoom back, so every visible field on every screen and sheet is
//    asserted at ≥ 16px;
//  - content wider than the viewport makes iOS lay the page out wider and
//    show it zoomed out, so reading a post with a long URL, a wide <pre>, a
//    wide table, a wide image and a wide embed must not scroll sideways.
// User zoom itself stays enabled (no maximum-scale / user-scalable=no).

test.beforeEach(({}, info) => test.skip(info.project.name !== 'mobile', 'phone viewport only'));

async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path: `/api${path}`, body });
/** Every visible text field whose computed font-size is under 16px. */
const smallFields = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('input, textarea, select, [contenteditable]:not([contenteditable=false])')]
      .filter((el) => {
        const type = (el as HTMLInputElement).type;
        if (['checkbox', 'radio', 'hidden', 'file', 'color', 'range', 'submit', 'button', 'reset', 'image'].includes(type)) return false;
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      })
      .map((el) => ({ field: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className ? '.' + String(el.className).split(' ').join('.') : ''}`, size: getComputedStyle(el).fontSize }))
      .filter((field) => parseFloat(field.size) < 16),
  );
async function noSmallFields(page: Page, where: string, needsField = true) {
  // Where a screen has fields, at least one must be on screen, or the check proves nothing.
  if (needsField) await expect(page.locator('input:visible, textarea:visible, select:visible').first(), `${where} shows a field`).toBeVisible();
  expect(await smallFields(page), where).toEqual([]);
}
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('the viewport keeps user zoom', async ({ page }) => {
  await login(page);
  const viewport = await page.locator('meta[name=viewport]').getAttribute('content');
  expect(viewport).toContain('width=device-width');
  expect(viewport).not.toMatch(/maximum-scale|user-scalable/);
  // No double-tap zoom on buttons: the body's touch-action allows pan and pinch only.
  expect(await page.evaluate(() => getComputedStyle(document.body).touchAction)).toBe('manipulation');
});

test('every field on the main screens is at least 16px', async ({ page }) => {
  await login(page);
  await noSmallFields(page, 'compose');
  // The [[ picker: its search box and filters.
  await page.locator('#composer-text').fill('[[');
  await expect(page.locator('.picker')).toBeVisible();
  await noSmallFields(page, 'picker');
  await page.keyboard.press('Escape');
  await page.locator('#composer-text').fill('');
  for (const [path, where, needsField] of [
    ['/studio/settings', 'settings', true],
    ['/studio/setup', 'setup', false],
    ['/studio/access', 'access', false],
    ['/studio/hoppers', 'hoppers', true],
    ['/studio/hoppers/parity-hopper', 'hopper', false],
    ['/studio/mentions', 'mentions', false],
    ['/studio/signals', 'signals', false],
    ['/studio/reading?view=sources', 'sources', false],
  ] as const) {
    await page.goto(path);
    await expect(page.locator('main .screen > *').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await noSmallFields(page, where, needsField);
  }
  // Settings → appearance → Custom opens the colour editor and its hex fields.
  await page.goto('/studio/settings');
  const custom = page.locator('.theme-opt').filter({ hasText: /custom/i }).first();
  if (await custom.count()) {
    await custom.click();
    await expect(page.locator('.theme-colour-text input').first()).toBeVisible();
    await noSmallFields(page, 'custom theme editor');
    await page.reload();
  }
});

test('every field in the editor and in sheets is at least 16px', async ({ page }) => {
  await login(page);
  const { json } = await api(page, 'POST', '/items', { contentMd: 'Zoom audit draft.', kind: 'fragment' });
  try {
    await page.goto(`/studio/edit/${json.id}`);
    await expect(page.locator('#md-input')).toBeVisible();
    await noSmallFields(page, 'editor');
    await page.locator('#md-input').fill('Zoom audit draft. [[');
    await expect(page.locator('.picker')).toBeVisible();
    await noSmallFields(page, 'editor picker');
    await page.keyboard.press('Escape');
    await page.locator('#md-input').fill('Zoom audit draft.');
    // A prompt sheet: link from clipboard asks for a URL when the clipboard has none.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('not a url'));
    await page.locator('[data-action="link-clipboard"]').click();
    const sheet = page.getByRole('dialog', { name: 'link from clipboard' });
    await expect(sheet.getByRole('textbox')).toBeVisible();
    await noSmallFields(page, 'prompt sheet');
    await sheet.locator('[data-sheet=cancel]').click();
    // The subscribe sheet on reading.
    await page.goto('/studio/reading');
    await page.getByRole('button', { name: 'subscribe', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'subscribe' }).getByRole('textbox').first()).toBeVisible();
    await noSmallFields(page, 'subscribe sheet');
  } finally {
    await api(page, 'DELETE', `/items/${json.id}`);
  }
});

const WIDE_IMAGE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="300"><rect width="1600" height="300" fill="#888"/></svg>')}`;
const WIDE_HTML =
  '<h2>Wide fixture post</h2>' +
  '<p>A long link: https://example.com/a/really/long/path/that/never/breaks/' + 'segment'.repeat(30) + '?query=' + 'x'.repeat(120) + '</p>' +
  '<pre><code>' + 'const wide = "' + 'w'.repeat(400) + '";' + '</code></pre>' +
  '<table><tr>' + Array.from({ length: 14 }, (_, i) => `<td>column_${i}_wide_cell_content</td>`).join('') + '</tr></table>' +
  `<p><img src="${WIDE_IMAGE}" width="1600" height="300" alt="wide"></p>` +
  '<iframe width="1200" height="300" title="wide embed" srcdoc="<p>embed</p>"></iframe>' +
  Array.from({ length: 6 }, (_, i) => `<p>Filler paragraph ${i} so the card clamps.</p>`).join('');
/** Serve the feed with one more legacy-RSS entry at the top: the wide post. */
async function injectWidePost(page: Page) {
  await page.route(/\/api\/reading(\?|$)/, async (route) => {
    const response = await route.fetch();
    const page0 = await response.json();
    if (page0.offset === 0) {
      const at = '2026-10-17T00:00:00Z';
      page0.items.unshift({
        key: 'imported:["parity-rss","wide-fixture"]', source: 'imported', kind: 'fragment', withdrawn: false, l0: true, contentHtml: WIDE_HTML, displayAt: at,
        imported: { subscriptionId: 'parity-rss', subscriptionTitle: 'Legacy source', remoteId: 'wide-fixture', kind: 'fragment', withdrawn: false, l0: true, updated: at, observedAt: at, contentHtml: WIDE_HTML, pinnedVersionRetained: null, sourceUrl: 'https://legacy.example/' + 'very-long-path-segment/'.repeat(12), version: 1, readVersion: 1 },
      });
    }
    await route.fulfill({ response, json: page0 });
  });
}

test('reading a post with wide content never scrolls the page sideways', async ({ page }) => {
  await login(page);
  await injectWidePost(page);
  await page.goto('/studio/reading');
  const entry = page.locator('.reading-entry').filter({ hasText: 'Wide fixture post' });
  await expect(entry).toBeVisible();
  await expect(entry.locator('img[alt=wide]')).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  // The full view shows the whole post unclamped: still no sideways scroll.
  await entry.getByRole('button', { name: 'more', exact: true }).click();
  await expect(page.locator('.reading-article')).toContainText('Filler paragraph 5');
  await expect(page.locator('.reading-article table')).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  // The table and the code scroll inside their own boxes.
  for (const selector of ['.reading-article table', '.reading-article pre']) {
    const box = await page.locator(selector).boundingBox();
    expect(box!.x + box!.width, selector).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
});
