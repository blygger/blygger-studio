import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture.ts';

// The tab says which studio it is: the blyg's title, and the ❝ icon in the
// theme's accent (src/ui/tab.ts).
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path, body });

test.afterEach(async ({ page }) => {
  await api(page, 'PATCH', '/api/settings', { siteTitle: '', theme: 'auto' });
});

test('the tab names the blyg and wears the theme accent', async ({ page }) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  expect((await api(page, 'PATCH', '/api/settings', { siteTitle: 'Tab Marker', theme: 'nord' })).status).toBe(200);
  await page.reload();
  await expect(page).toHaveTitle('blyg studio — Tab Marker');
  // Nord's accent (pencil) is #88c0d0.
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /^data:image\/svg\+xml,.*%2388c0d0/);
  // Remembered on the device: the title is right before settings load on the next launch.
  expect(await page.evaluate(() => localStorage.getItem('blyg-studio-title'))).toBe('Tab Marker');
});
