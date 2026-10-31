import { test, expect } from './fixture.ts';

// The setup wizard (session 46): reachable from Settings, one step at a time,
// each setting beside its default, nothing written until the last step.
// In-page, so the owner cookie (Secure) rides along; page.request would go unauthenticated.
const stored = (page: import('./fixture.ts').Page) =>
  page.evaluate(async () => (await fetch('/api/settings')).json() as Promise<Record<string, unknown>>);

test('the setup wizard walks every step and saves only what changed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  // Both projects share one database; start each from the fresh-install state.
  expect(await page.evaluate(async () => (await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ feedOrder: 'pace-layered', setup: 'pending' }) })).status)).toBe(200);

  await page.goto('/studio/settings');
  await expect(page.locator('#setup-banner')).toBeVisible();
  await page.locator('#run-setup').click();
  await expect(page.locator('#setup [data-step="identity"]')).toBeVisible();
  const title = `Setup walk ${test.info().project.name}`;
  await page.locator('#setup-siteTitle').fill(title);
  await expect(page.locator('[data-setting="siteTitle"] .setup-meta')).toContainText('was');

  // Look, then the home page order, which says which one is recommended.
  await page.locator('#setup-next').click();
  await expect(page.locator('[data-step="look"]')).toBeVisible();
  await page.locator('#setup-next').click();
  await expect(page.locator('[data-step="home"]')).toContainText('Pace-layered (recommended)');
  await page.getByRole('radio', { name: /Newest first/ }).check();
  await expect(page.locator('[data-reset="feedOrder"]')).toBeVisible();
  await page.locator('[data-reset="feedOrder"]').click();
  await expect(page.getByRole('radio', { name: /Pace-layered/ })).toBeChecked();
  await page.getByRole('radio', { name: /Newest first/ }).check();

  await page.locator('#setup-next').click();
  await page.locator('#setup-next').click();
  await page.locator('#setup-next').click();
  const review = page.locator('#setup-review');
  await expect(review.locator('[data-setting="siteTitle"]')).toContainText(title);
  await expect(review.locator('[data-setting="feedOrder"]')).toContainText('Newest first');
  // Nothing is stored before the last step.
  const before = await stored(page);
  expect(before.setup).toBeDefined();
  expect(before.siteTitle).not.toBe(title);

  await page.locator('#setup-finish').click();
  await expect(page.locator('#setup-done')).toBeVisible();
  const saved = await stored(page);
  expect(saved).toMatchObject({ siteTitle: title, feedOrder: 'reverse-chronological', setup: 'done' });
  await page.goto('/studio/settings');
  await expect(page.locator('#setup-banner')).toHaveCount(0);
  expect(errors).toEqual([]);
});
