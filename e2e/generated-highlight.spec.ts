import { test, expect, type Page } from './fixture';

// Highlight generated portions (0.27.0): the blyg-wide default in settings
// and an item's own override in the editor's TK card. Public rendering is
// covered by test/generated-highlight.test.ts.
async function login(page: Page) {
  await page.goto('/studio/login'); await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const settings = (page: Page) => page.evaluate(async () => (await fetch('/api/settings')).json());

// Leave the shared fixture as found, even when a test fails half-way: a retry that
// starts with the default already on fails at the first assertion instead.
test.afterEach(async ({ page }) => {
  await page.evaluate(async () => fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ highlight_generated_default: false }) })).catch(() => {});
});

test('the default is a settings checkbox, and an item overrides it from its TK card', async ({ page }) => {
  await login(page);
  await page.goto('/studio/settings');
  const box = page.getByRole('checkbox', { name: 'Highlight generated portions by default' });
  await expect(box).not.toBeChecked();
  await box.check();
  await page.getByRole('button', { name: 'save settings', exact: true }).click();
  await expect.poll(async () => (await settings(page)).highlight_generated_default).toBe(true);

  const id = await page.evaluate(async () => (await (await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content_md: 'mine [TK]impyrt=generated[/TK]' }) })).json()).id);
  await page.goto(`/studio/edit/${id}`);
  const card = page.locator('details#tk');
  if (!(await card.getAttribute('open'))) await card.locator('summary').click();
  const group = card.getByRole('group', { name: 'Highlight generated portions on the public page:' });
  await expect(group.getByRole('button')).toHaveText(['default (on)', 'on', 'off']);
  await expect(group.locator('[aria-pressed=true]')).toHaveText('default (on)');
  await group.getByRole('button', { name: 'off', exact: true }).click();
  await expect(group.locator('[aria-pressed=true]')).toHaveText('off');
  expect(await page.evaluate(async (id) => (await (await fetch(`/api/items/${id}`)).json()).highlight, id)).toBe('hide');
});

test('the robot opens what the author disclosed: hover peeks, a click keeps it, Escape closes', async ({ page }) => {
  await login(page);
  const md = 'Mine, then [TK]impyrt gpt-5=an inline generated clause[/TK].\n\n[TK]impyrt claude-sonnet-5-5=A generated paragraph.[/TK]\n\nMine again.';
  const id = await page.evaluate(async (md) => {
    const json = { 'content-type': 'application/json' };
    const item = await (await fetch('/api/items', { method: 'POST', headers: json, body: JSON.stringify({ content_md: md }) })).json();
    const published = await (await fetch(`/api/items/${item.id}/publish`, { method: 'POST', headers: json, body: JSON.stringify({ expectedRevision: item.revision }) })).json();
    await fetch(`/api/items/${item.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ highlight: 'show', expectedRevision: published.revision }) });
    return item.id as string;
  }, md);
  await page.goto(`/f/${id}/`);
  const badges = page.locator('article .blyg-tk-gen > .gen-badge');
  await expect(badges).toHaveCount(2);
  const pop = page.locator('.gen-pop');
  // Version-level, as §5.7 is: both models, for either passage.
  await badges.nth(1).hover();
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('AI-generated');
  await expect(pop).toContainText('The author marked this text as machine-generated. Self-reported, not verified.');
  await expect(pop).toContainText('gpt-5, claude-sonnet-5-5');
  await expect(pop).toContainText('These details cover all 2 generated passages in this version.');
  await page.mouse.move(0, 0);
  await expect(pop).toBeHidden();
  await badges.first().click();
  await expect(pop).toBeVisible();
  await expect(badges.first()).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await expect(pop).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await badges.first().click();
  await page.locator('article p').last().click();
  await expect(pop).toBeHidden();
});

test('generating a TK scope in the editor keeps the text around it', async ({ page }) => {
  await login(page);
  const md = 'Before the scope.\n\n[TK]write one line[/TK]\n\nAfter the scope.';
  const id = await page.evaluate(async (md) => (await (await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content_md: md }) })).json()).id as string, md);
  // The fixture has no provider; answer as the server does: the scope's output
  // alone in `text`, the whole working copy with it spliced in as `content_md`.
  const spliced = 'Before the scope.\n\n[TK]write one line[=]A generated line.[/TK]\n\nAfter the scope.';
  await page.route(`**/api/items/${id}/generate`, route => route.fulfill({ json: { text: 'A generated line.', model: 'test-model', content_md: spliced } }));
  await page.goto(`/studio/edit/${id}`);
  const card = page.locator('details#tk');
  await expect(card.getByRole('button', { name: 'generate', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'generate', exact: true }).click();
  await expect(page.locator('#md-input')).toHaveValue(spliced);
});
