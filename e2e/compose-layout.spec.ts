import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture';

// The composer and the editor after Substack's composer: one row of small
// line-icon tools that keep their words (accessible name) and hover text
// (title), a compact kind / pane switch, compact save draft and publish, and
// the syntax paragraph folded behind "syntax help" (remembered per device).
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path: `/api${path}`, body });
/** Every control in `row` sits inside the viewport and is a 40px target. */
async function fits(page: Page, selector: string) {
  const width = page.viewportSize()!.width;
  const row = page.locator(selector);
  await expect(row).toBeVisible();
  for (const control of await row.locator('button').all()) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.width).toBeGreaterThanOrEqual(40);
  }
  expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

test('the composer: icon tools keep their names and titles, compact actions, folded syntax help', async ({ page }) => {
  await login(page);
  const tools = page.locator('.composer-tools');
  for (const [name, title] of [
    ['attach image', 'Upload an image and insert it at the cursor'],
    ['link from clipboard', /^Read a URL from the clipboard/],
    ['scan text', /^Scan printed text/],
    ['[[ link an item', /^Link to an item/],
    ['[TK] instruction', /^Write an instruction for the model/],
    ['Full Editor →', 'Full Editor →'],
  ] as const) {
    const button = tools.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('title', title);
  }
  await expect(tools.getByRole('button', { name: 'attach image', exact: true }).locator('svg')).toHaveCount(1);
  await expect(tools.getByRole('button', { name: '[[ link an item', exact: true })).toHaveText('[[');
  await fits(page, '.composer-tools');
  // Compact segmented kind switch, compact buttons.
  await expect(page.getByRole('radiogroup', { name: 'kind' })).toHaveClass(/compact/);
  for (const id of ['#save-draft-btn', '#publish-btn']) expect((await page.locator(id).boundingBox())!.height).toBeLessThanOrEqual(36);
  // Syntax help is folded by default, text intact, and the choice is remembered.
  const help = page.locator('details.syntax-help');
  await expect(help).not.toHaveAttribute('open');
  await expect(help.getByText(/^Markdown supported\./)).toBeHidden();
  await help.locator('summary').click();
  await expect(help.getByText(/^Markdown supported\./)).toBeVisible();
  // <details> fires toggle asynchronously; reload only once the choice is stored.
  const stored = () => page.evaluate(() => localStorage.getItem('studio.syntaxHelpOpen'));
  await expect.poll(stored).toBe('1');
  await page.reload();
  await expect(page.locator('details.syntax-help')).toHaveAttribute('open');
  await page.locator('details.syntax-help summary').click();
  await expect.poll(stored).toBe('0');
  await page.reload();
  await expect(page.locator('details.syntax-help')).not.toHaveAttribute('open');
  // A thread adds ![[; the row still fits.
  await page.getByRole('radio', { name: 'thread' }).click();
  await expect(tools.getByRole('button', { name: '![[ quote an item', exact: true })).toBeVisible();
  await fits(page, '.composer-tools');
});

test('the editor: one row of tools that fits, its own items named as before', async ({ page }) => {
  await login(page);
  const { json } = await api(page, 'POST', '/items', { contentMd: 'Layout draft.', kind: 'thread' });
  try {
    await page.goto(`/studio/edit/${json.id}`);
    await expect(page.locator('#md-input')).toBeVisible();
    await fits(page, '.ed-tools');
    const tools = page.locator('.ed-tools');
    await expect(tools.getByRole('button', { name: 'make this a fragment', exact: true })).toHaveAttribute('title', 'make this a fragment');
    await expect(tools.getByRole('button', { name: 'mark selection as generated', exact: true })).toHaveAttribute('title', /^Wrap the selected text/);
    await expect(page.locator('details.syntax-help')).toBeVisible();
    for (const id of ['#save-draft-btn', '#publish-btn']) expect((await page.locator(id).boundingBox())!.height).toBeLessThanOrEqual(36);
  } finally {
    await api(page, 'DELETE', `/items/${json.id}`);
  }
});
