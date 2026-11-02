import { test, expect, type Page } from './fixture';
import { expandRow } from './editor';

// Speculative authoring (studio-only): typing `[[some text]]` creates a
// placeholder draft and rewrites the text to `[[id | some text]]`; one undo
// puts the brackets back and discards the untouched draft. Asserts on what the
// handlers do — the text, the item on the server, the published output — not
// only on what renders.
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const typing = (page: Page, v: 'auto' | 'editor' | 'panel') =>
  page.evaluate(async (v) => (await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pickerTyping: v }) })).status, v);
const getItem = (page: Page, id: string) =>
  page.evaluate(async (id) => {
    const res = await fetch(`/api/items/${id}`);
    return res.ok ? ((await res.json()) as { placeholder: string | null; contentMd: string; version: number }) : res.status;
  }, id);
const linked = (label: string) => new RegExp(`\\[\\[([0-9a-hjkmnp-tv-z]{26}) \\| ${label}\\]\\]`);

test('typing [[text]] creates a placeholder and rewrites it; one undo restores the text and discards it', async ({ page }, info) => {
  await login(page);
  await typing(page, 'editor');
  try {
    await page.reload();
    const editor = page.locator('#composer-text');
    const label = `the ${info.project.name} maintenance argument`;
    await editor.fill('I will argue ');
    await editor.press('End');
    await editor.pressSequentially(`[[${label}]]`);
    await expect(editor).toHaveValue(new RegExp(`^I will argue ${linked(label).source}$`));
    const id = linked(label).exec(await editor.inputValue())![1];
    expect(await getItem(page, id)).toMatchObject({ placeholder: label, contentMd: '', version: 0 });
    await expect(page.getByRole('status').filter({ hasText: 'is a placeholder, not yet written' })).toBeVisible();

    // One undo, before anything else is typed: the brackets come back and the draft goes.
    await editor.press('ControlOrMeta+z');
    await expect(editor).toHaveValue(`I will argue [[${label}]]`);
    await expect.poll(() => getItem(page, id)).toBe(404);

    // Typing the last ] again mints afresh; the toast's undo does the same as the key.
    await editor.press('End');
    await editor.press('Backspace');
    await editor.pressSequentially(']');
    await expect(editor).toHaveValue(new RegExp(`^I will argue ${linked(label).source}$`));
    const again = linked(label).exec(await editor.inputValue())![1];
    expect(again).not.toBe(id);
    await page.getByRole('status').getByRole('button', { name: 'undo' }).click();
    await expect(editor).toHaveValue(`I will argue [[${label}]]`);
    await expect.poll(() => getItem(page, again)).toBe(404);

    // Not in code, not for a quote: nothing is created, nothing rewritten.
    await editor.fill('');
    await editor.pressSequentially('`[[inert words]]` and ');
    // A negative: give a (wrong) create time to come back before looking.
    await page.waitForTimeout(1000);
    await expect(editor).toHaveValue('`[[inert words]]` and ');
    const open = await page.evaluate(async () => (await (await fetch('/api/items?placeholder=true&limit=100')).json()).items.map((i: { placeholder: string }) => i.placeholder));
    expect(open).not.toContain('inert words');
  } finally {
    await typing(page, 'auto');
  }
});

test('the picker offers to create a placeholder; it is listed as not yet written and a link to it publishes as text', async ({ page }, info) => {
  await login(page);
  await typing(page, 'editor');
  try {
    await page.reload();
    const editor = page.locator('#composer-text');
    const label = `${info.project.name} hedge essay`;
    await editor.fill(`Later: [[${label}`);
    const panel = page.getByRole('complementary', { name: 'link picker' });
    await expect(panel).toBeVisible();
    const create = panel.getByRole('button', { name: `Create placeholder “${label}”` });
    await expect(create).toBeVisible();
    await create.click();
    await expect(editor).toHaveValue(new RegExp(`^Later: ${linked(label).source}$`));
    const id = linked(label).exec(await editor.inputValue())![1];
    expect(await getItem(page, id)).toMatchObject({ placeholder: label, version: 0 });

    // The picker lists it again for another link, marked not yet written.
    await editor.press('End');
    await editor.pressSequentially(` and [[${info.project.name} hedge`);
    const listed = panel.getByRole('option').filter({ hasText: label }).filter({ hasText: 'not yet written' });
    await expect(listed).toBeVisible();
    await editor.press('Escape');
    await editor.fill(`Later: [[${id} | ${label}]] is coming.`);

    // Publish from the composer: the label goes out as plain text.
    await page.locator('#publish-btn').click();
    const find = () =>
      page.evaluate(async (id) => {
        const list = await (await fetch('/api/items?status=public&limit=20')).json();
        return (list.items as { id: string; contentMd: string }[]).find((i) => i.contentMd.includes(`[[${id} |`)) ?? null;
      }, id);
    await expect.poll(find).not.toBeNull();
    const item = (await find())!;
    expect(item.contentMd).toContain(`[[${id} | ${label}]]`); // the working copy keeps the link
    const doc = await page.evaluate(async (pid) => (await fetch(`/items/${pid}.json`)).json(), item.id);
    expect(doc.content_html).toContain(`Later: ${label} is coming.`);
    expect(doc.content_html).not.toContain('<a ');
    expect(JSON.stringify(doc)).not.toContain(id);

    // The list's "not yet written" filter has it; its row opens the editor, which says what it is.
    await page.locator('[data-filter="placeholders"]').click();
    const row = page.locator(`.item-row[data-id="${id}"]`);
    await expect(row).toContainText(label);
    await expect(row).toContainText('not yet written');
    await expandRow(page, id);
    await row.getByRole('link', { name: 'full editor' }).click();
    await expect(page.locator('#placeholder-head')).toContainText(`A placeholder for “${label}”`);
  } finally {
    await typing(page, 'auto');
  }
});
