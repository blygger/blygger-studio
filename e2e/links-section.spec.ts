import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture.ts';

// The links section (session 47): chosen in Settings, shown on every public
// page. The form sends every field back, so it must save with the section set.
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path, body });

test('threads and links chosen in Settings show on the public page', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  // Both projects share one database.
  await api(page, 'PATCH', '/api/settings', { linksThreads: [], linksExternal: [], linksPosition: 'bottom', frontPage: '' });
  const label = `Colophon ${test.info().project.name}`;
  const created = await api(page, 'POST', '/api/items', { contentMd: `# ${label}\n\nHow this blyg is made.`, kind: 'thread' });
  const id = created.json.id as string;
  expect((await api(page, 'POST', `/api/items/${id}/publish`, {})).status).toBe(200);

  await page.goto('/studio/settings');
  const card = page.locator('#links-section');
  await card.getByRole('radio', { name: 'On the right' }).check();
  await card.getByRole('searchbox', { name: 'find a thread to add' }).fill(label);
  await card.getByRole('list', { name: 'matching threads: find a thread to add' }).getByRole('button', { name: label }).click();
  await expect(card.locator('.linked-threads')).toContainText(label);
  await card.locator('#linksExternal').fill('Résumé | https://example.org/resume.pdf');
  await page.getByRole('button', { name: 'save settings' }).click();
  await expect.poll(async () => (await api(page, 'GET', '/api/settings')).json.linksThreads).toEqual([id]);

  // A desktop reader: in the mobile project a bare context would be narrow, with the menu folded.
  const reader = await browser.newContext({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
  const pub = await reader.newPage();
  // The thread's own page: the home page may still be the other project's, from the edge cache.
  await pub.goto(`/t/${id}/`);
  const links = pub.locator('nav.blyg-links');
  await expect(links.getByRole('link', { name: label })).toHaveAttribute('href', `/t/${id}/`);
  await expect(links.getByRole('link', { name: 'Résumé' })).toHaveAttribute('href', 'https://example.org/resume.pdf');
  await expect(links.getByRole('link', { name: 'Made with Blygger' })).toBeVisible();
  await reader.close();

  // On a phone the side menu folds behind a Menu button under the masthead.
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const small = await phone.newPage();
  await small.goto(`/t/${id}/`);
  const menu = small.getByRole('button', { name: 'Menu' });
  await expect(menu).toBeVisible();
  await expect(small.locator('nav.blyg-links')).toBeHidden();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(small.locator('nav.blyg-links').getByRole('link', { name: label })).toBeVisible();
  await phone.close();

  await api(page, 'PATCH', '/api/settings', { linksThreads: [], linksExternal: [], linksPosition: 'bottom' });
  expect(errors).toEqual([]);
});
