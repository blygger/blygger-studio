import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture.ts';

const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path, body });

test('the text box and preview start level, and a quote looks and reads as on the public page', async ({ page }, info) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  const source = (await api(page, 'POST', '/api/items', { contentMd: 'Quoted words' })).json.id;
  expect((await api(page, 'POST', `/api/items/${source}/publish`, {})).status).toBe(200);
  const thread = (await api(page, 'POST', '/api/items', { contentMd: `Mine\n\n![[${source}]]\n`, kind: 'thread' })).json.id;
  await page.goto(`/studio/edit/${thread}`);
  const quote = page.locator('#preview-pane blockquote.blyg-transclusion');
  if (info.project.name === 'mobile') await page.getByRole('group', { name: 'pane' }).getByRole('button', { name: 'preview' }).click();
  await expect(quote).toContainText('Quoted words');
  await expect(quote.locator('.provenance a')).toBeVisible();
  const css = await quote.evaluate((el) => { const s = getComputedStyle(el); return [s.borderLeftWidth, s.backgroundColor]; });
  expect(css).toEqual(['2px', 'rgba(0, 0, 0, 0)']);
  if (info.project.name === 'desktop') {
    const box = (await page.locator('#md-input').boundingBox())!;
    const preview = (await page.locator('#preview-pane').boundingBox())!;
    expect(preview.y).toBe(box.y);
  }
});
