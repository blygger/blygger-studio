import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture.ts';

// Fragment or thread at a glance: a tinted box, a greyed thread-only tool, and a
// bold count that goes red with the text past the cap, in all three editors.
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path, body });
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const css = (locator: ReturnType<Page['locator']>, property: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

test('the composer tints fragments only, and the tool row does not move between kinds', async ({ page }) => {
  await login(page);
  const box = page.locator('#composer-text');
  const tint = await css(box, 'background-color');
  const quote = page.locator('[data-action="bracket-quote"]');
  await expect(quote).toBeDisabled();
  const before = (await page.locator('[data-action="tk"]').boundingBox())!;
  await page.getByRole('radio', { name: 'thread', exact: true }).click();
  await expect(quote).toBeEnabled();
  const after = (await page.locator('[data-action="tk"]').boundingBox())!;
  expect(after.x).toBe(before.x);
  expect(await css(box, 'background-color')).not.toBe(tint);
});

test('the full editor: tinted, and the count and text go red past the cap', async ({ page }) => {
  await login(page);
  const { json } = await api(page, 'POST', '/api/items', { contentMd: 'short' });
  await page.goto(`/studio/edit/${json.id}`);
  const box = page.locator('#md-input');
  await expect(box).toHaveClass(/is-fragment/);
  const count = page.locator('.ed-foot .counter');
  const ink = await css(count, 'color');
  const text = await css(box, 'color');
  expect(Number(await css(count, 'font-weight'))).toBeGreaterThanOrEqual(700);
  await box.fill('x'.repeat(1001));
  await expect(count).toHaveText('1001 / 1000');
  expect(await css(count, 'color')).not.toBe(ink);
  expect(await css(box, 'color')).not.toBe(text);
});

test('quick edit shows the count, and goes red past the cap', async ({ page }) => {
  await login(page);
  const marker = `Quick ${crypto.randomUUID().slice(0, 8)}`;
  await api(page, 'POST', '/api/items', { contentMd: marker });
  await page.goto('/studio');
  const row = page.locator('.item-row, li, article').filter({ hasText: marker }).first();
  await row.getByText(marker).first().click();
  await page.locator('[data-action="quick-edit"]').first().click();
  const box = page.getByRole('textbox', { name: 'quick edit' });
  await expect(box).toHaveClass(/is-fragment/);
  const count = page.locator('.qe-bar .counter');
  await expect(count).toHaveText(`${marker.length} / 1000`);
  await box.fill('x'.repeat(1001));
  await expect(count).toHaveClass(/over/);
  await expect(box).toHaveClass(/is-over/);
});
