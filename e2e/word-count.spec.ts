import { test, expect, type Page } from './fixture';

// The word-count extension (extensions/word-count): each entry's words in its
// byline, and a contents thread's words over its whole outline. The browser
// suite compiles every extension in (playwright.config.ts); each test here
// turns this one on and off again.
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
/** Create and publish an item, returning its id. */
const publish = (page: Page, contentMd: string, kind: 'fragment' | 'thread') =>
  page.evaluate(async ({ contentMd, kind }) => {
    const created = await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentMd, kind }) });
    const { id, revision } = await created.json();
    const published = await fetch(`/api/items/${id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision }) });
    if (!published.ok) throw new Error(`publish ${published.status}`);
    return id as string;
  }, { contentMd, kind });

test.beforeEach(async ({ page }) => {
  await login(page);
  await setExtensions(page, ['word-count']);
});
test.afterEach(async ({ page }) => {
  await setExtensions(page, []);
});

// Both projects share one server, so each run's items carry its own marker.
const marker = () => `wc${Date.now().toString(36)}`;

test('a contents thread shows its own words and the words of its outline', async ({ page }) => {
  const run = marker();
  const chapter = await publish(page, `Chapter ${run}: one two three four five.`, 'fragment');
  await publish(page, `Contents ${run}\n\n- [[${chapter} | The chapter]]`, 'thread');
  await page.goto('/studio/reading?sub=own');
  const contents = page.locator('.reading-entry').filter({ hasText: `Contents ${run}` });
  const count = contents.locator('[data-extension=word-count]');
  await expect(count).toHaveText(/^· \d+ words · \d+ words in document$/);
  await expect(count).toHaveAttribute('title', /across the 2 items of its outline/);
  const chapterCount = page.locator('.reading-entry').filter({ hasText: `Chapter ${run}` }).locator('[data-extension=word-count]');
  await expect(chapterCount).toHaveText(/^· \d+ words$/);
});

test('off, bylines carry no count', async ({ page }) => {
  await setExtensions(page, []);
  const run = marker();
  await publish(page, `Off ${run}: nothing to show.`, 'fragment');
  await page.goto('/studio/reading?sub=own');
  await expect(page.locator('.reading-entry').filter({ hasText: `Off ${run}` })).toBeVisible();
  await expect(page.locator('[data-extension=word-count]')).toHaveCount(0);
});
