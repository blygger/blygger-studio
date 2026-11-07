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

test('unpublished edits show as the draft count beside the published one', async ({ page }) => {
  const run = marker();
  const chapter = await publish(page, `Edited ${run}: one two.`, 'fragment');
  await page.evaluate(async ({ id, contentMd }) => {
    const { revision } = await (await fetch(`/api/items/${id}`)).json();
    const response = await fetch(`/api/items/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentMd, expectedRevision: revision }) });
    if (!response.ok) throw new Error(`edit ${response.status}`);
  }, { id: chapter, contentMd: `Edited ${run}: one two three four five.` });
  await page.goto('/studio/reading?sub=own');
  const count = page.locator('.reading-entry').filter({ hasText: `Edited ${run}` }).locator('[data-extension=word-count]');
  await expect(count).toHaveText(/^· \d+ words \(draft \d+ words\)$/);
  await expect(count).toHaveAttribute('title', /Published: \d+ words\.\nDraft: \d+ words\./);
});

test('the full editor shows the same counts as the byline and follows autosave', async ({ page }) => {
  const run = marker();
  const chapter = await publish(page, `Editor ${run}: one two.`, 'fragment');
  const contents = await publish(page, `Contents ${run}\n\n- [[${chapter} | The chapter]]`, 'thread');

  await page.goto(`/studio/edit/${chapter}`);
  const count = page.locator('.ed-foot [data-extension=word-count]');
  await expect(count).toHaveText('· 4 words');

  // Typing moves the draft count once autosave lands, leaving the published one.
  await page.locator('#md-input').fill(`Editor ${run}: one two three four five.`);
  await expect(count).toHaveText('· 4 words (draft 7 words)');

  // The reading view agrees.
  await page.goto('/studio/reading?sub=own');
  const byline = page.locator('.reading-entry').filter({ hasText: `Editor ${run}` }).locator('[data-extension=word-count]');
  await expect(byline).toHaveText('· 4 words (draft 7 words)');

  // A contents thread's editor carries the roll-up too, with the chapter's draft in it.
  await page.goto(`/studio/edit/${contents}`);
  await expect(page.locator('.ed-foot [data-extension=word-count]')).toHaveText(/^· \d+ words · \d+ words in document \(draft \d+ words\)$/);
});

test('the composer counts as typed, beside the character count', async ({ page }) => {
  await page.goto('/studio/');
  const count = page.locator('.composer-actions [data-extension=word-count]');
  await expect(count).toHaveCount(0);
  await page.locator('#composer-text').fill('one two [the label](https://example.com/a/b) ![alt](https://example.com/i.png) [[abc | three]] [[abc]]');
  await expect(count).toHaveText('· 5 words');
  await expect(page.locator('#composer-count + .counter')).toContainText('5 words');
  // A long count stays on one line and the buttons on one row, at phone width too.
  await page.locator('#composer-text').fill('word '.repeat(1500));
  await expect(count).toHaveText('· 1,500 words');
  const [save, send] = await Promise.all([page.locator('#save-draft-btn').boundingBox(), page.locator('#publish-btn').boundingBox()]);
  expect(save!.y).toBe(send!.y);
  expect((await count.boundingBox())!.height).toBeLessThan(30);
  await page.locator('#composer-text').fill('');
  await expect(count).toHaveCount(0);
});

test('off, the editor carries no count', async ({ page }) => {
  await setExtensions(page, []);
  const run = marker();
  const id = await publish(page, `Off editor ${run}: nothing to show.`, 'fragment');
  await page.goto(`/studio/edit/${id}`);
  await expect(page.locator('.ed-foot .counter')).toContainText('/ 1000');
  await expect(page.locator('[data-extension=word-count]')).toHaveCount(0);
  await page.goto('/studio/');
  await page.locator('#composer-text').fill('one two three');
  await expect(page.locator('#composer-count')).toContainText('13');
  await expect(page.locator('#composer-count + .counter')).toHaveCount(0);
  await page.locator('#composer-text').fill('');
});

test('off, bylines carry no count', async ({ page }) => {
  await setExtensions(page, []);
  const run = marker();
  await publish(page, `Off ${run}: nothing to show.`, 'fragment');
  await page.goto('/studio/reading?sub=own');
  await expect(page.locator('.reading-entry').filter({ hasText: `Off ${run}` })).toBeVisible();
  await expect(page.locator('[data-extension=word-count]')).toHaveCount(0);
});
