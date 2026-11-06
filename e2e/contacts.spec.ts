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

test('subscribing to one blyg by hand offers it, prefilled with its author; not now leaves the book alone', async ({ page }) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  const tag = crypto.randomUUID().slice(0, 8);
  const origin = `https://b${tag}.example/`;
  await page.route(`${origin}blyg.json`, (route) => route.fulfill({ json: { author: { name: `Zed${tag} Ruiz`, url: `https://zed${tag}.example/` } }, headers: { 'access-control-allow-origin': '*' } }));
  await page.route('**/api/subscriptions', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 201, json: { id: `sub-${tag}`, kind: 'blyg', origin, feedUrl: `${origin}feed.xml`, title: 'A Title', status: 'active', lastPollAt: null, failCount: 0, lastIndexSyncAt: null, inBlogroll: false, flags: [], created: '2026-11-06T00:00:00Z', titleFollowsSource: true, hopperFeedUrl: null } })
    : route.continue());
  await page.goto('/studio/reading');
  await page.getByRole('button', { name: 'subscribe', exact: true }).first().click();
  await page.locator('#add-sub-url').fill(origin);
  await page.locator('#add-sub-form').getByRole('button', { name: 'subscribe' }).click();

  // The same sheet carries on: it never closes between the two steps.
  const offer = page.getByRole('dialog', { name: 'subscribe' });
  await expect(offer.getByText('Subscribed to A Title.')).toBeVisible();
  await expect(offer.getByText('Add this blyg to your address book?')).toBeVisible();
  await expect(offer.locator('#add-sub-url')).toHaveCount(0);
  await expect(offer.locator('#offer-url')).toHaveValue(`https://zed${tag}.example/`);
  await expect(offer.locator('#offer-name')).toHaveValue(`Zed${tag} Ruiz`);
  await expect(offer.locator('#offer-handle')).toHaveValue(`zed${tag}`);
  await expect(offer.getByText('private to you')).toBeVisible();
  await expect(offer.getByText('Displayed on public page')).toBeVisible();
  await expect(offer.getByText('Where the person can be found, such as a blyg address or social feed profile')).toBeVisible();
  await expect(offer.getByRole('button', { name: /import an OPML/ })).toBeHidden();
  await offer.getByRole('button', { name: 'not now' }).click();
  await expect(offer).toHaveCount(0);
  // Reopened, it starts from the first step again.
  await page.getByRole('button', { name: 'subscribe', exact: true }).first().click();
  await expect(page.locator('#add-sub-url')).toHaveValue('');
  await page.keyboard.press('Escape');
  const contacts = (await api(page, 'GET', '/api/contacts')).json.contacts as { handle: string }[];
  expect(contacts.some((c) => c.handle === `zed${tag}`)).toBe(false);
});

test('Settings saves a contact on its own, by Enter, without the settings form', async ({ page }) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  const handle = `enter${crypto.randomUUID().slice(0, 8)}`;
  await page.goto('/studio/settings#contacts');
  // In the main column beside the sidebar, not squeezed into it.
  expect((await page.locator('#contacts').boundingBox())!.width).toBeGreaterThan(300);
  await expect(page.locator('form').filter({ has: page.getByRole('button', { name: 'save settings' }) }).locator('#contact-handle')).toHaveCount(0);
  await page.locator('#contact-handle').fill(handle);
  await page.locator('#contact-name').fill('Enter Key');
  await page.locator('#contact-url').fill('https://enter.example/');
  await page.locator('#contact-url').press('Enter');
  await expect(page.locator('.contact-list').getByText(`@${handle}`)).toBeVisible();
  await page.getByRole('button', { name: `remove @${handle}` }).click();
});

test("the reading menu offers an entry's author, prefilled", async ({ page }) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  await page.goto('/studio/reading/parity-native/00000000000000000000000001');
  const article = page.locator('.reading-article');
  const open = async () => {
    await article.getByRole('button', { name: 'more actions', exact: true }).click();
    await page.getByRole('button', { name: 'add author to address book' }).click();
  };
  await open();
  const sheet = page.getByRole('dialog', { name: 'Add author to address book' });
  const url = await sheet.locator('#offer-url').inputValue();
  expect(url).toMatch(/^https?:/);
  expect(await sheet.locator('#offer-name').inputValue()).not.toBe('');
  const handle = `author${crypto.randomUUID().slice(0, 8)}`;
  await sheet.locator('#offer-handle').fill(handle);
  if (!url.startsWith('https:')) await sheet.locator('#offer-url').fill('https://parity-author.example/');
  await sheet.getByRole('button', { name: 'add contact' }).click();
  await expect(sheet).toHaveCount(0);
  const contacts = (await api(page, 'GET', '/api/contacts')).json.contacts as { id: string; handle: string }[];
  const made = contacts.find((c) => c.handle === handle)!;
  expect(made).toBeTruthy();
  await api(page, 'DELETE', `/api/contacts/${made.id}`);
});
