import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture.ts';
import { editorMenu, expandRow } from './editor.ts';

// The shelf (#135): own items (sub '~own') in the owner's order at the top of the compose
// list, added and removed from an item's actions, reordered with up and down.
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path, body });

test('items go on the shelf, reorder, and come off again', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  const { revision } = (await api(page, 'GET', '/api/shelf')).json as { revision: number };
  expect((await api(page, 'PUT', '/api/shelf', { entries: [], expectedRevision: revision })).status).toBe(200);
  const tag = crypto.randomUUID().slice(0, 8);
  const a = (await api(page, 'POST', '/api/items', { contentMd: `Now page ${tag}` })).json.id as string;
  const b = (await api(page, 'POST', '/api/items', { contentMd: `Reading log ${tag}` })).json.id as string;

  await page.goto('/studio/');
  const shelf = page.locator('section.shelf');
  await expect(shelf).toHaveCount(0);
  const rowA = await expandRow(page, a);
  await rowA.locator('[data-action="shelf"]').click();
  await expect(rowA.locator('[data-action="shelf"]')).toHaveText('remove from shelf');
  await expect(shelf.locator('.shelf-row')).toHaveCount(1);

  // The editor's ⋯ menu offers the same action.
  await page.goto(`/studio/edit/${b}`);
  await editorMenu(page, 'add to shelf');
  await page.goto('/studio/');

  const rows = shelf.locator('.shelf-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(`Now page ${tag}`);
  await expect(rows.nth(1)).toContainText(`Reading log ${tag}`);
  await rows.nth(1).getByRole('button', { name: 'move up' }).click();
  await expect(rows.nth(0)).toContainText(`Reading log ${tag}`);
  await expect.poll(async () => (await api(page, 'GET', '/api/shelf')).json.entries).toEqual([{ sub: '~own', remoteId: b }, { sub: '~own', remoteId: a }]);

  await rows.nth(0).getByRole('button', { name: 'remove from shelf' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText(`Now page ${tag}`);
  await expect.poll(async () => (await api(page, 'GET', '/api/shelf')).json.entries).toEqual([{ sub: '~own', remoteId: a }]);

  const again = await expandRow(page, a);
  await again.locator('[data-action="shelf"]').click();
  await expect(shelf).toHaveCount(0);
  expect((await api(page, 'GET', '/api/shelf')).json.entries).toEqual([]);
  expect(errors).toEqual([]);
});
