import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture';

// The full view (/reading/{sub}/{id}): "more" on a card opens the whole
// entry full screen instead of expanding it inside the feed; reload stays on
// it; back returns to the timeline at the same entry. It carries the card's
// action row and marks the entry read on open. Own items, imported blyg
// items, threads and legacy RSS entries all open in it.
const NATIVE = '00000000000000000000000001';
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path: `/api${path}`, body });
const paragraphs = (tag: string) =>
  Array.from({ length: 14 }, (_, i) => `${tag} paragraph ${i + 1}, long enough that the card clamps it and needs a way in to the rest.`).join('\n\n');
/** Publish own threads long enough to clamp; returns their ids, newest last. */
async function longThreads(page: Page, tags: string[]) {
  const ids: string[] = [];
  for (const tag of tags) {
    const { json } = await api(page, 'POST', '/items', { contentMd: `# ${tag} heading\n\n${paragraphs(tag)}`, kind: 'thread' });
    expect((await api(page, 'POST', `/items/${json.id}/publish`)).status).toBe(200);
    ids.push(json.id);
  }
  return ids;
}
const card = (page: Page, text: string) => page.locator('.reading-entry').filter({ hasText: text });

test('"more" opens the full view; reload stays; back returns to the same entry', async ({ page }) => {
  await login(page);
  const tags = [`Alpha${Date.now()}`, `Bravo${Date.now()}`, `Charlie${Date.now()}`];
  // Left published, as other suites leave theirs: withdrawing them would put
  // url-less tombstones in the feed that reading-pwa's every-card check counts.
  const ids = await longThreads(page, tags);
  {
    await page.goto('/studio/reading');
    // The oldest of the three sits below the other two: scroll it into the middle.
    const target = card(page, `${tags[0]} heading`);
    await expect(target).toBeVisible();
    await target.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(150);
    const before = (await target.boundingBox())!.y;
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);
    // Clamped, with a fade, and "more" offered; the end of the post is not in the card.
    await expect(target.locator('.entry-body')).toHaveClass(/overflowing/);
    await expect(target.getByText(`${tags[0]} paragraph 14`)).not.toBeInViewport();
    await target.getByRole('button', { name: 'more', exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/studio/reading/~own/${ids[0]}$`));
    const article = page.locator('.reading-article');
    await expect(article.getByRole('heading', { name: `${tags[0]} heading` })).toBeVisible();
    await expect(article.getByText(`${tags[0]} paragraph 14`)).toBeVisible();
    await expect(article.locator('.entry-body')).not.toHaveClass(/clamped/);
    // The card's action row and citation line come along.
    await expect(article.getByRole('link', { name: 'edit', exact: true })).toHaveAttribute('href', `/studio/edit/${ids[0]}`);
    await expect(article.getByRole('button', { name: 'more actions', exact: true })).toBeVisible();
    await expect(article.locator('.entry-src')).toHaveAttribute('href', new RegExp(`/t/${ids[0]}/$`));
    // The reading tab stays current.
    await expect(page.getByRole('navigation', { name: 'studio' }).locator('a[aria-current=page]')).toHaveAccessibleName('reading');

    // Deep-linkable: a reload stays on the full view.
    await page.reload();
    await expect(article.getByText(`${tags[0]} paragraph 14`)).toBeVisible();
    // The browser's back after that reload still lands on the entry.
    await page.goBack();
    await expect(page).toHaveURL(/\/studio\/reading$/);
    await expect.poll(async () => Math.abs((await target.boundingBox())!.y - before)).toBeLessThan(40);
    await target.getByRole('button', { name: 'more', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/studio/reading/~own/${ids[0]}$`));

    // Back returns to the feed with the same entry where it was.
    await page.getByRole('button', { name: 'back', exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/reading$/);
    await expect(target).toBeInViewport();
    await expect.poll(async () => Math.abs((await target.boundingBox())!.y - before)).toBeLessThan(40);

    // The browser's own back (the phone's back gesture) does the same.
    await target.getByRole('button', { name: 'more', exact: true }).click();
    await expect(article.getByText(`${tags[0]} paragraph 14`)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/studio\/reading$/);
    await expect.poll(async () => Math.abs((await target.boundingBox())!.y - before)).toBeLessThan(40);

    // A tap on the clamped text opens it too.
    await target.locator('.entry-body p').first().click();
    await expect(page).toHaveURL(new RegExp(`/studio/reading/~own/${ids[0]}$`));
  }
});

test('an imported blyg entry opens by its address with the action row, and opening marks it read', async ({ page }) => {
  await login(page);
  const clear = () => api(page, 'DELETE', `/reading/parity-native/${NATIVE}/read`);
  await clear();
  try {
    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/api/reading/parity-native/${NATIVE}/read`));
    await page.goto(`/studio/reading/parity-native/${NATIVE}`);
    const article = page.locator('.reading-article');
    await expect(article.getByRole('heading', { name: 'Native title' })).toBeVisible();
    await expect(article).toContainText('Frozen source text.');
    await expect(article).toContainText('Frozen quote from a prior version.');
    await expect(article.locator('.byline')).toContainText('Native source');
    await expect(article.locator('.entry-src')).toHaveAttribute('href', 'https://source.example/native');
    for (const name of ['thumbs up', 'thumbs down', 'stub ↗', 'add to hopper', 'more actions'])
      await expect(article.getByRole('button', { name, exact: true })).toBeVisible();
    expect((await put).postDataJSON()).toEqual({ version: 1 });
    // The ⋯ sheet carries the card's rows, history among them.
    await article.getByRole('button', { name: 'more actions', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'actions' }).getByRole('button', { name: 'history', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    // Back with no feed behind it goes to the feed.
    await page.getByRole('button', { name: 'back', exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/reading$/);
    // The read reached the server (the feed's first page may not hold this entry).
    const { json } = await api(page, 'GET', '/reading?sub=parity-native&limit=50');
    expect(json.items.find((e: { imported?: { remoteId: string } }) => e.imported?.remoteId === NATIVE).imported.readVersion).toBe(1);
  } finally {
    await clear();
  }
});

test('a legacy RSS entry opens in the full view from its timeline', async ({ page }) => {
  await login(page);
  // Short entries are not clamped; the full view is still at their address.
  await page.goto('/studio/reading?sub=parity-rss');
  await expect(card(page, 'Legacy title').getByRole('button', { name: 'more', exact: true })).toHaveCount(0);
  await page.goto('/studio/reading/parity-rss/l0-parity');
  const article = page.locator('.reading-article');
  await expect(article.getByRole('heading', { name: 'Legacy title' })).toBeVisible();
  await expect(article).toContainText('Legacy body.');
  await expect(article.locator('.byline')).toContainText('legacy rss');
  await article.getByRole('button', { name: 'more actions', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'actions' });
  await expect(menu).toContainText('https://legacy.example/post');
  await expect(menu.getByRole('button', { name: 'history' })).toHaveCount(0);
});

test('the card action row is compact: line-icon thumbs, quiet labels, 40px targets', async ({ page }) => {
  await login(page);
  await page.goto('/studio/reading?sub=parity-native');
  const bar = card(page, 'Native title').locator('.entry-bar');
  // The wording is unchanged.
  await expect(bar.getByRole('button', { name: 'stub ↗', exact: true })).toHaveText('stub ↗');
  await expect(bar.getByRole('button', { name: 'add to hopper', exact: true })).toHaveText('+ add to hopper…');
  // Thumbs are icons now, not emoji, still named.
  const up = bar.getByRole('button', { name: 'thumbs up', exact: true });
  await expect(up.locator('svg')).toHaveCount(1);
  await expect(up).not.toContainText('👍');
  for (const button of await bar.locator('button, a').all()) {
    const box = (await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.width).toBeGreaterThanOrEqual(40);
    // Borderless: the size is the target, not a box drawn around it.
    expect(await button.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
  }
  expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(46);
});
