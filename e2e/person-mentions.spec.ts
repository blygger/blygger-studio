import { test, expect, type Page } from './fixture.ts';

// The server's half is test/person-mentions.test.ts. Here: the lens, no tally, the
// highlight in the card and the reader, and a quote's h-card left alone. The feed
// row is rewritten in the browser, because the fixture's items name nobody.
const NATIVE = '00000000000000000000000001';
const ME = 'https://me-mention.example/';
const FILL = Array.from({ length: 14 }, (_, i) => `<p>Filler paragraph ${i + 1}, long enough to wrap onto more lines at any width, which is what moves the mention when the card's width settles after the first paint, and to push what follows past the clamp.</p>`).join('');
const MENTION = `<span class="h-card"><a class="u-url" href="${ME}">@<span class="p-name">Me Named</span></a></span>`;
const QUOTED = `<blockquote class="blyg-transclusion"><p><span class="h-card"><a class="u-url" href="${ME}">@<span class="p-name">Quoted Me</span></a></span></p></blockquote>`;
// Text after it too: at the very end, the card's scroll limit would hide a wrong position.
const HTML = `${QUOTED}${FILL}<p>Thanks to ${MENTION} for this.</p>${FILL}`;

async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}

test('the Mentions lens shows only finds, with no tally, and highlights the mention where the card can show it', async ({ page }) => {
  await login(page);
  const saved = await page.evaluate(async (authorUrl) => {
    const before = await (await fetch('/api/settings')).json();
    await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorUrl }) });
    return before.authorUrl as string;
  }, ME);
  try {
    let asked = false;
    await page.route('**/api/reading?*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('mentions') !== 'true') return route.continue();
      asked = true;
      url.searchParams.delete('mentions');
      const response = await route.fetch({ url: url.toString() });
      const body = await response.json();
      body.items = body.items.filter((e: { imported?: { remoteId: string } }) => e.imported?.remoteId === NATIVE);
      for (const item of body.items) item.imported.contentHtml = item.contentHtml = HTML;
      await route.fulfill({ response, json: body });
    });
    await page.goto('/studio/reading?sub=all');
    await page.getByRole('group', { name: 'reading lens' }).getByRole('button', { name: 'Mentions', exact: true }).click();
    await expect(page).toHaveURL(/lens=mentions/);
    await expect(page.getByText(/A find, not a notification/)).toBeVisible();
    expect(asked).toBe(true);

    const entry = page.locator('.reading-entry').first();
    const mine = entry.locator('.mention-you');
    const inCard = async () => {
      await expect(mine).toHaveCount(1);
      await expect(mine).toContainText('Me Named');
      await expect(async () => {
        const box = (await entry.locator('.entry-body').boundingBox())!;
        const card = (await mine.boundingBox())!;
        expect(card.y).toBeGreaterThanOrEqual(box.y);
        expect(card.y + card.height).toBeLessThanOrEqual(box.y + box.height);
      }).toPass({ timeout: 5000 });
    };
    await inCard();
    // Loaded directly too, where the text reflows after the first paint.
    await page.goto('/studio/reading?sub=all&lens=mentions');
    await inCard();
    await expect(entry.locator('blockquote .mention-you')).toHaveCount(0);
    // It behaves as any other entry.
    await expect(entry.getByRole('button', { name: 'more actions' })).toBeVisible();
  } finally {
    await page.evaluate(async (authorUrl) => {
      await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorUrl }) });
    }, saved);
  }
});

test('the old mentions tab is called responses, at the same address', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'responses', exact: true }).first().click();
  await expect(page).toHaveURL(/\/studio\/mentions$/);
  await expect(page.getByRole('heading', { name: 'responses', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'mentions', exact: true })).toHaveCount(0);
});
