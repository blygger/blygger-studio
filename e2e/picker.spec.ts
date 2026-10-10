import { test, expect, type Page } from './fixture';

// The [[ / ![[ picker panel (0.29): a non-modal panel at the right (bottom on
// a phone) with source and sort, and a per-device choice of where you type.
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
async function publish(page: Page, texts: string[]) {
  return page.evaluate(async (texts) => {
    const ids: string[] = [];
    for (const content_md of texts) {
      const item = await (await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content_md }) })).json();
      await fetch(`/api/items/${item.id}/publish`, { method: 'POST' });
      ids.push(item.id);
      // Distinct publish times, so newest/oldest has an order to show.
      await new Promise((r) => setTimeout(r, 1100));
    }
    return ids;
  }, texts);
}
const options = (page: Page) => page.getByRole('listbox', { name: 'items' }).getByRole('option');
const typing = (page: Page, picker_typing: 'auto' | 'editor' | 'panel') =>
  page.evaluate(async (v) => (await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ picker_typing: v }) })).status, picker_typing);

test('typing [[ opens the panel; source, sort, Escape and Enter work from the editor', async ({ page }, info) => {
  await login(page);
  await page.evaluate(() => localStorage.clear());
  await typing(page, 'editor');
  const token = `${info.project.name}pickertoken`;
  // The word sits past the old 70-character excerpt: the old search could not find it.
  const [first, second] = await publish(page, [
    `First of two, with an opening long enough to push the token well past any excerpt the old picker searched. ${token}`,
    `Second of two, equally long, so that only the full-text search finds the token that follows here. ${token}`,
  ]);
  await page.reload();
  const editor = page.locator('#composer-text');
  await editor.fill(`see [[${token}`);
  const panel = page.getByRole('complementary', { name: 'link picker' });
  await expect(panel).toBeVisible();
  await expect(options(page)).toHaveCount(2);
  await expect(options(page).first()).toContainText('mine');
  // Newest first by default; oldest first reverses.
  await expect(options(page).first()).toContainText('Second of two');
  await panel.getByRole('combobox', { name: 'sort' }).selectOption('oldest');
  await expect(options(page).first()).toContainText('First of two');
  // Imported only: these are both ours, so nothing.
  await panel.getByRole('radio', { name: 'imported' }).check();
  await expect(panel.getByText('0 items')).toBeVisible();
  await panel.getByRole('radio', { name: 'both' }).check();
  await expect(options(page)).toHaveCount(2);
  await page.screenshot({ path: info.outputPath(`picker-${info.project.name}.png`) });
  // The keyboard never left the editor: arrows and Enter pick.
  await editor.focus();
  await editor.press('End');
  await editor.press('ArrowDown');
  await editor.press('Enter');
  await expect(editor).toHaveValue(`see [[${second}]]`);
  await expect(panel).toHaveCount(0);
  // Escape closes without touching the text.
  await editor.fill(`again [[${token}`);
  await expect(page.getByRole('complementary', { name: 'link picker' })).toBeVisible();
  await editor.press('Escape');
  await expect(page.getByRole('complementary', { name: 'link picker' })).toHaveCount(0);
  await expect(editor).toHaveValue(`again [[${token}`);
  expect(first).toBeTruthy();
  await typing(page, 'auto');
});

test('the picker setting: panel mode searches in the picker, and automatic follows the device', async ({ page }, info) => {
  await login(page);
  const token = `${info.project.name}panelmode`;
  const [id] = await publish(page, [`Panel mode target ${token}`]);
  try {
    await typing(page, 'panel');
    await page.reload();
    const editor = page.locator('#composer-text');
    await editor.fill('x [[');
    const search = page.getByRole('complementary', { name: 'link picker' }).getByRole('searchbox', { name: 'search items' });
    await expect(search).toBeFocused();
    await search.fill(token);
    await expect(options(page)).toHaveCount(1);
    await search.press('Enter');
    await expect(editor).toHaveValue(`x [[${id}]]`);
    await expect(editor).toBeFocused();
    // Automatic: the editor with a mouse, the picker's own search on a touch screen.
    await typing(page, 'auto');
    await page.reload();
    await page.locator('#composer-text').fill('y [[');
    await expect(page.getByRole('complementary', { name: 'link picker' })).toBeVisible();
    if (info.project.name === 'mobile') await expect(page.getByRole('searchbox', { name: 'search items' })).toBeFocused();
    else {
      await expect(page.getByRole('searchbox', { name: 'search items' })).toHaveCount(0);
      await expect(page.locator('#composer-text')).toBeFocused();
    }
  } finally {
    await typing(page, 'auto');
  }
});

test('on a phone the picker fills the screen in panel mode and docks at the bottom in editor mode', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'phone layout only');
  await login(page);
  const viewport = page.viewportSize()!;
  const panel = page.getByRole('complementary', { name: 'link picker' });
  const box = async () => { const b = await panel.boundingBox(); return b && { top: Math.round(b.y), bottom: Math.round(b.y + b.height), width: Math.round(b.width) }; };
  try {
    await page.locator('#composer-text').fill('[[');
    await expect.poll(box).toEqual({ top: 0, bottom: viewport.height, width: viewport.width });
    await page.screenshot({ path: info.outputPath('picker-full-mobile.png') });
    await typing(page, 'editor');
    await page.reload();
    await page.locator('#composer-text').fill('[[');
    // Measured once the slide-in animation has finished.
    await expect.poll(async () => (await box())?.bottom).toBe(viewport.height);
    expect((await box())!.top).toBeGreaterThan(viewport.height / 3);
  } finally {
    await typing(page, 'auto');
  }
});

test('Settings → writing sets where the picker search is typed', async ({ page }) => {
  await login(page);
  try {
    await page.goto('/studio/settings');
    const group = page.getByRole('radiogroup', { name: /search by typing in/ });
    await expect(group.getByRole('radio', { name: /Automatic/ })).toBeChecked();
    await group.getByRole('radio', { name: /The picker/ }).check();
    await page.getByRole('button', { name: 'save settings', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(async () => (await fetch('/api/settings')).json())).picker_typing).toBe('panel');
    expect(await typing(page, 'sideways' as 'auto')).toBe(400);
  } finally {
    await typing(page, 'auto');
  }
});

test('![[ inside a [TK] instruction opens a source picker and inserts the id in place (#44)', async ({ page }, info) => {
  await login(page);
  await typing(page, 'editor');
  const token = `${info.project.name}sourcetoken`;
  const [id] = await publish(page, [`A source for the generator ${token}`]);
  try {
    await page.reload();
    const editor = page.locator('#composer-text');
    await editor.fill(`[TK]summarize ![[${token}`);
    const panel = page.getByRole('complementary', { name: 'source picker' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('feeds the item to the generator');
    await expect(options(page)).toHaveCount(1);
    await editor.press('Enter');
    await expect(editor).toHaveValue(`[TK]summarize ![[${id}]]`);
    // Outside a scope an inline ![[ still opens nothing.
    await editor.fill(`plain ![[${token}`);
    await expect(page.getByRole('complementary')).toHaveCount(0);
  } finally {
    await typing(page, 'auto');
  }
});
