import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture.ts';

// ControlOrMeta is Cmd on a Mac and Ctrl elsewhere, as the editors are.
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path, body });
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const select = (box: ReturnType<Page['locator']>, from: number, to: number) =>
  box.evaluate((el: HTMLTextAreaElement, [a, b]) => el.setSelectionRange(a, b), [from, to]);

test('the composer: bold, italics and link from the keyboard, and undo takes them back', async ({ page }) => {
  await login(page);
  const box = page.locator('#composer-text');
  await box.fill('one two three');
  await box.focus();
  await select(box, 4, 7);
  await page.keyboard.press('ControlOrMeta+b');
  await expect(box).toHaveValue('one **two** three');
  await page.keyboard.press('ControlOrMeta+i');
  await expect(box).toHaveValue('one ***two*** three');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(box).toHaveValue('one *two* three');
  await page.keyboard.press('ControlOrMeta+i');
  await expect(box).toHaveValue('one two three');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(box).toHaveValue('one *two* three');

  // The state the page keeps, not only the box: a kind switch re-renders from it.
  await page.getByRole('radio', { name: 'thread', exact: true }).click();
  await expect(box).toHaveValue('one *two* three');

  await box.fill('see this');
  await box.focus();
  await select(box, 4, 8);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(box).toHaveValue('see [this]()');
  await page.keyboard.type('https://x.example/');
  await expect(box).toHaveValue('see [this](https://x.example/)');
});

test('the full editor and quick edit take the same keys', async ({ page }) => {
  await login(page);
  const marker = `Keys${crypto.randomUUID().slice(0, 8)}`;
  const { json } = await api(page, 'POST', '/api/items', { contentMd: marker });
  await page.goto(`/studio/edit/${json.id}`);
  const editor = page.locator('#md-input');
  await editor.focus();
  await select(editor, 0, marker.length);
  await page.keyboard.press('ControlOrMeta+i');
  await expect(editor).toHaveValue(`*${marker}*`);
  await page.keyboard.press('ControlOrMeta+i');
  await expect(editor).toHaveValue(marker);

  await page.goto('/studio');
  await page.getByText(marker).first().click();
  await page.locator('[data-action="quick-edit"]').first().click();
  const quick = page.getByRole('textbox', { name: 'quick edit' });
  await quick.focus();
  await select(quick, 0, marker.length);
  await page.keyboard.press('ControlOrMeta+b');
  await expect(quick).toHaveValue(`**${marker}**`);
});
