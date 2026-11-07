import { test, expect } from './fixture';

test('Studio uses real collection batches for Mentions and preserves the fixture resources', async ({ page }) => {
  const batches: { operation: string; requests: { query?: Record<string, string> }[] }[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/read-batch') batches.push(request.postDataJSON());
  });
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  await page.getByRole('link', { name: 'responses', exact: true }).click();
  const fixture = page.locator('.mention-group').filter({ hasText: 'Mention target fixture' });
  await expect(fixture).toHaveCount(1);
  await expect(fixture.locator('.mention-row')).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(new Set(batches.map(batch => batch.operation))).toEqual(new Set(['getItem', 'listMentionGroups', 'getMentionSummary', 'listMentions']));
  expect(batches.every(batch => batch.requests.length > 0 && batch.requests.length <= 50)).toBe(true);
  expect(batches.filter(batch => batch.operation === 'listMentions').every(batch =>
    batch.requests.every(child => !!child.query?.targetItemId))).toBe(true);
});
