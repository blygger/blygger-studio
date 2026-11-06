import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture.ts';

const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path, body });

test('a contact added in Settings is offered at @, and an unknown one gets a soft warning', async ({ page }) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  const handle = `ada${crypto.randomUUID().slice(0, 8)}`;

  await page.goto('/studio/settings#contacts');
  await page.locator('#contact-handle').fill(handle);
  await page.locator('#contact-name').fill('Ada Ruiz');
  await page.locator('#contact-url').fill('https://ada.example/');
  await page.getByRole('button', { name: 'add contact' }).click();
  await expect(page.locator('.contact-list').getByText(`@${handle}`)).toBeVisible();

  const created = await api(page, 'POST', '/api/items', { contentMd: 'draft' });
  await page.goto(`/studio/edit/${created.json.id}`);
  const editor = page.locator('textarea').first();
  await editor.fill('');
  await editor.pressSequentially(`Thanks @${handle.slice(0, 6)}`);
  const picker = page.getByRole('complementary', { name: 'mention picker' });
  await expect(picker.getByRole('button', { name: new RegExp(handle) })).toBeVisible();
  await editor.press('Enter');
  await expect(editor).toHaveValue(`Thanks @${handle} `);
  await expect(picker).toHaveCount(0);

  await editor.pressSequentially(`and @nobody${handle}`);
  await expect(page.getByRole('status').filter({ hasText: `@nobody${handle} is not in your` })).toBeVisible();

  const contacts = await api(page, 'GET', '/api/contacts');
  const contact = contacts.json.contacts.find((c: { handle: string }) => c.handle === handle);
  await page.goto('/studio/settings#contacts');
  await page.getByRole('button', { name: `remove @${handle}` }).click();
  await expect(page.locator('.contact-list').getByText(`@${handle}`)).toHaveCount(0);
  expect(contact.ids).toEqual([]);
});
