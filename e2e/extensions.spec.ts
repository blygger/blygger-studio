import { test, expect, type Page } from './fixture';

// Studio extensions (docs/extensions.md). The browser suite compiles in every
// extension (playwright.config.ts: BLYG_EXTENSIONS=all), so the rest of the
// suite runs against a Studio whose extensions are compiled in and off. This
// file turns the example extension on, uses each slot, and turns it off again.
async function login(page: Page) {
  await page.goto('/studio/login'); await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const patchSettings = (page: Page, body: Record<string, unknown>) =>
  page.evaluate(async (patch) => {
    const response = await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    if (!response.ok) throw new Error(`settings ${response.status}`);
  }, body);
const setExtensions = (page: Page, extensions: string[]) => patchSettings(page, { extensions });
const timezone = (page: Page) => page.evaluate(async () => ((await (await fetch('/api/settings')).json()) as { timezone: string }).timezone);
const entries = (page: Page) => page.locator('.reading-entry').evaluateAll((elements) => elements.map((element) => element.outerHTML));
async function entryMenu(page: Page, entry: ReturnType<Page['locator']>) {
  await entry.getByRole('button', { name: 'more actions', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'actions' });
  await expect(sheet).toBeVisible();
  return sheet;
}

test('a compiled-in extension starts off, fills its slots once enabled, and leaves no trace when off again', async ({ page }) => {
  await login(page);
  await setExtensions(page, []);
  // Saving the Settings form also stores the browser's timezone when none is
  // set, which changes every date on the page; put it back before comparing.
  const zone = await timezone(page);
  try {
    await page.goto('/studio/reading?sub=parity-native');
    await expect(page.locator('.reading-entry')).toHaveCount(2);
    await expect(page.locator('[data-extension]')).toHaveCount(0);
    const before = await entries(page);
    const native = page.locator('.reading-entry').filter({ hasText: 'Native title' });
    const menu = await entryMenu(page, native);
    await expect(menu.getByRole('button', { name: /^.?example/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.goto('/studio/more');
    await expect(page.getByRole('list', { name: 'extensions' })).toHaveCount(0);

    // Settings lists what this build carries, unchecked; turning it on is a save.
    await page.goto('/studio/settings');
    const toggle = page.locator('#extension-example');
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('#extensions')).toContainText('Example extension');
    await toggle.check();
    await page.getByRole('button', { name: 'save settings' }).click();
    await expect(page.getByRole('status')).toHaveText('saved');

    // The byline slot, and the sheet it opens.
    await page.goto('/studio/reading?sub=parity-native');
    await expect(page.locator('.reading-entry [data-extension=example]')).toHaveCount(2);
    await native.locator('[data-extension=example]').click();
    const sheet = page.getByRole('dialog', { name: 'example extension' });
    await expect(sheet.locator('[data-extension-sheet=example]')).toContainText('parity-native');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // The ⋯ slot: a row after the Studio's own, opening the same sheet.
    const rows = await entryMenu(page, native);
    await expect(rows.getByRole('button').last()).toContainText('example');
    await rows.getByRole('button').last().click();
    await expect(page.getByRole('dialog', { name: 'example extension' })).toBeVisible();
    await page.keyboard.press('Escape');

    // The page slot, reached from More, reading through the SDK.
    await page.goto('/studio/more');
    await page.getByRole('list', { name: 'extensions' }).getByRole('link').click();
    await expect(page).toHaveURL(/\/studio\/ext\/example$/);
    await expect(page.locator('[data-extension-page=example]')).toContainText('Site title, read through the SDK:');
    await expect(page.locator('[data-extension-page=example]')).not.toContainText('…');

    // Off again: the reading view is exactly what it was.
    await patchSettings(page, { extensions: [], timezone: zone });
    await page.goto('/studio/reading?sub=parity-native');
    await expect(page.locator('.reading-entry')).toHaveCount(2);
    expect(await entries(page)).toEqual(before);
    await page.goto('/studio/ext/example');
    await expect(page.getByText('This extension is not enabled here.')).toBeVisible();
  } finally {
    await patchSettings(page, { extensions: [], timezone: zone });
  }
});

test('the extensions releases carry: reading time in the byline, inspect in the ⋯ sheet', async ({ page }) => {
  await login(page);
  const zone = await timezone(page);
  try {
    await setExtensions(page, ['inspect', 'reading-time']);
    await page.goto('/studio/reading?sub=parity-native');
    const native = page.locator('.reading-entry').filter({ hasText: 'Native title' });
    const minutes = native.locator('[data-extension=reading-time]');
    await expect(minutes).toHaveText(/^· (< 1|\d+) min$/);
    await expect(minutes).toHaveAttribute('title', /\d+ words/);

    const rows = await entryMenu(page, native);
    await expect(rows.getByRole('button').last()).toContainText('inspect');
    await rows.getByRole('button').last().click();
    const sheet = page.getByRole('dialog', { name: 'inspect' });
    await expect(sheet.locator('[data-extension-sheet=inspect] dl')).toContainText('version');
    await expect(sheet.locator('.inspect-json')).toContainText('"subscriptionId"');
    await expect(sheet.locator('.inspect-json')).toContainText('characters, not shown');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  } finally {
    await patchSettings(page, { extensions: [], timezone: zone });
  }
});
