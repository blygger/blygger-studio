import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture.ts';
import { editorMenu } from './editor.ts';

// Own items in hoppers (session 47): added from the editor's ⋯ menu, listed in
// the studio's hopper view with an edit link, removable there.
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path, body });

test('an own post goes in a hopper from its menu and shows in the hopper', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  const project = test.info().project.name;
  const hopper = (await api(page, 'POST', '/api/hoppers', { name: `Own picks ${project}` })).json as { id: string };
  const created = await api(page, 'POST', '/api/items', { content_md: `# Own pick ${project}\n\nmine` });
  const id = created.json.id as string;
  expect((await api(page, 'POST', `/api/items/${id}/publish`, {})).status).toBe(200);

  await page.goto(`/studio/edit/${id}`);
  await editorMenu(page, 'add to hopper…');
  await page.getByRole('dialog').getByRole('button', { name: new RegExp(`Own picks ${project}`) }).click();
  await expect(page.getByRole('status').filter({ hasText: `added to Own picks ${project}` })).toBeVisible();

  await page.goto(`/studio/hoppers/${hopper.id}`);
  const entry = page.locator(`[data-own="${id}"]`);
  await expect(entry).toContainText(`Own pick ${project}`);
  await expect(entry.getByRole('link', { name: 'edit' })).toHaveAttribute('href', new RegExp(`/edit/${id}$`));
  await entry.getByRole('button', { name: 'remove' }).click();
  await expect(entry).toHaveCount(0);
  expect(errors).toEqual([]);
});
