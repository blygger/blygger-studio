import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture.ts';

// Search on the reading and compose pages (docs/search.md): the picker's
// route, the query in the URL, hits that open where they belong.
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path, body });

async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}

test('reading search finds a published item, opens it, and back returns to the results', async ({ page }) => {
  await login(page);
  const word = `vorpalsearch${test.info().project.name}`;
  const created = await api(page, 'POST', '/api/items', { contentMd: `Reading search target: ${word} here.` });
  const id = created.json.id as string;
  expect((await api(page, 'POST', `/api/items/${id}/publish`, {})).status).toBe(200);

  await page.goto('/studio/reading');
  await page.getByRole('searchbox', { name: 'search reading' }).fill(word);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${word}`));
  const results = page.getByRole('region', { name: 'search results' });
  const hit = results.getByRole('link', { name: new RegExp(word) });
  await expect(hit).toHaveCount(1);
  await expect(hit.locator('mark')).toHaveText(word);
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/reading/~own/${id}$`));
  await page.goBack();
  await expect(page.getByRole('region', { name: 'search results' }).getByRole('link', { name: new RegExp(word) })).toHaveCount(1);
});

test('compose search finds drafts by default and opens own items in the editor', async ({ page }) => {
  await login(page);
  const word = `snarkdraft${test.info().project.name}`;
  const draft = (await api(page, 'POST', '/api/items', { contentMd: `A draft holding ${word}.` })).json.id as string;

  await page.goto(`/studio/?q=${word}`);
  await expect(page.getByRole('button', { name: 'this blyg only' })).toHaveAttribute('aria-pressed', 'true');
  const hit = page.getByRole('region', { name: 'search results' }).getByRole('link', { name: new RegExp(word) });
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText('draft');
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/edit/${draft}$`));
});

test('the picker still never offers a draft', async ({ page }) => {
  await login(page);
  const word = `pickerdraft${test.info().project.name}`;
  await api(page, 'POST', '/api/items', { contentMd: `Unpublished ${word}.` });
  const search = await api(page, 'GET', `/api/search?q=${word}`);
  expect((search.json.items as unknown[]).length).toBe(0);
});
