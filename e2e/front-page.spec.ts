import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture.ts';
import { editorMenu } from './editor.ts';

// The static front page (session 47): a thread's ⋯ menu makes it the public
// root; the latest items move to /posts/, which every public page links to.
// In-page fetches, so the owner cookie (Secure) rides along.
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path, body });

test('a thread becomes the front page from its menu, and back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  // Both projects share one database.
  await api(page, 'PATCH', '/api/settings', { frontPage: '', postsPath: 'posts' });

  const project = test.info().project.name;
  const created = await api(page, 'POST', '/api/items', { contentMd: `# Welcome (${project})\n\nThe front page, written as a thread.`, kind: 'thread' });
  const id = created.json.id as string;
  expect((await api(page, 'POST', `/api/items/${id}/publish`, {})).status).toBe(200);

  await page.goto(`/studio/edit/${id}`);
  await editorMenu(page, 'set as front page');
  await expect(page.getByRole('status').filter({ hasText: 'now your front page' })).toBeVisible();
  expect((await api(page, 'GET', '/api/settings')).json.frontPage).toBe(id);

  await page.goto('/');
  await expect(page.locator('article')).toContainText('The front page, written as a thread.');
  await page.locator('a.posts-link').click();
  await expect(page).toHaveURL(/\/posts\/$/);
  await expect(page.locator(`a[href*="/t/${id}/"]`)).toHaveCount(0);

  await page.goto(`/studio/edit/${id}`);
  await editorMenu(page, 'stop using as front page');
  await expect(page.getByRole('status').filter({ hasText: 'latest items again' })).toBeVisible();
  expect((await api(page, 'GET', '/api/settings')).json.frontPage).toBe('');

  // Settings finds the thread by search, and can go back to the latest items.
  await page.goto('/studio/settings#feed');
  await page.getByRole('searchbox', { name: 'find a thread for the front page' }).fill(`Welcome (${project})`);
  await page.getByRole('list', { name: 'matching threads: find a thread for the front page' }).getByRole('button', { name: `Welcome (${project})` }).click();
  await expect(page.locator('#frontPage')).toContainText(`Welcome (${project})`);
  await page.getByRole('button', { name: 'save settings' }).click();
  await expect.poll(async () => (await api(page, 'GET', '/api/settings')).json.frontPage).toBe(id);
  await page.getByRole('button', { name: 'use latest items' }).click();
  await page.getByRole('button', { name: 'save settings' }).click();
  await expect.poll(async () => (await api(page, 'GET', '/api/settings')).json.frontPage).toBe('');
  expect(errors).toEqual([]);
});
