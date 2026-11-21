import { test, expect, type Page } from './fixture';

// The dictionary in Settings: the author's words added and removed, an installed set shown and removed.
async function login(page: Page) {
  await page.goto('/studio/login'); await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const dictionary = (page: Page) => page.evaluate(async () => (await (await fetch('/api/dictionary')).json()) as { sources: { source: string; words: string[] }[]; revision: number });
const putSource = (page: Page, source: string, words: string[]) =>
  page.evaluate(async ({ source, words }) => {
    const { revision } = await (await fetch('/api/dictionary')).json();
    const r = await fetch(`/api/dictionary/${source}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ words, expectedRevision: revision }) });
    if (!r.ok) throw new Error(`dictionary ${r.status}`);
  }, { source, words });

test.beforeEach(async ({ page }) => {
  await login(page);
  await putSource(page, 'owner', []);
  await putSource(page, 'e2e-terms', []);
});

test('words added in Settings are on the server; a set can be shown and removed', async ({ page }) => {
  await putSource(page, 'e2e-terms', ['anamnesis', 'tachycardia']);
  await page.goto('/studio/settings');
  const card = page.locator('#dictionary-card');
  await card.getByLabel('add words to the dictionary').fill('blyg Venkatesh');
  await card.getByRole('button', { name: 'add', exact: true }).click();
  await expect(card.locator('.dictionary-words li')).toHaveCount(2);
  expect((await dictionary(page)).sources.find((s) => s.source === 'owner')?.words).toEqual(['blyg', 'Venkatesh']);
  await card.getByRole('button', { name: 'remove blyg' }).click();
  await expect(card.locator('.dictionary-words li')).toHaveCount(1);

  const set = card.locator('li[data-source="e2e-terms"]');
  await expect(set).toContainText('2 words');
  await set.getByRole('button', { name: 'show' }).click();
  await expect(set).toContainText('anamnesis, tachycardia');
  await set.getByRole('button', { name: 'remove' }).click();
  await page.getByRole('button', { name: 'remove', exact: true }).last().click();
  await expect(set).toHaveCount(0);
  expect((await dictionary(page)).sources.map((s) => s.source)).toEqual(['owner']);
});

test('a word that is not one is refused with the reason', async ({ page }) => {
  await page.goto('/studio/settings');
  const card = page.locator('#dictionary-card');
  await card.getByLabel('add words to the dictionary').fill('1234');
  await card.getByRole('button', { name: 'add', exact: true }).click();
  await expect(page.getByText('holds no letter')).toBeVisible();
  await expect(card.locator('.dictionary-words li')).toHaveCount(0);
});
