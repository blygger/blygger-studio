import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture';

// Reading lenses and the signals page (0.25.0). The fixture is shared by both
// projects, so the test clears the thumb it sets (the log keeps its entries:
// it is append-only by design).
const NATIVE = '00000000000000000000000001';
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path: `/api${path}`, body });

test('lenses filter by kind, keep themselves across screens, keep withdrawn posts to Background, and show the Smart Feed placeholder', async ({ page }) => {
  await login(page);
  const stamp = Date.now();
  const frag = (await api(page, 'POST', '/items', { contentMd: `Lens fragment ${stamp}` })).json.id;
  await api(page, 'POST', `/items/${frag}/publish`, {});
  const thread = (await api(page, 'POST', '/items', { contentMd: `# Lens thread ${stamp}\n\n![[${frag}]]`, kind: 'thread' })).json.id;
  await api(page, 'POST', `/items/${thread}/publish`, {});

  await page.goto('/studio/reading?view=sources');
  const bar = page.getByRole('group', { name: 'reading lens' });
  await expect(bar.getByRole('button')).toHaveText(['All', 'Threads', 'Fragments', 'Background', 'Smart Feed']);

  await bar.getByRole('button', { name: 'Threads' }).click();
  await expect(page).toHaveURL(/lens=threads/);
  // Exactly one lens is current.
  await expect(bar.locator('[aria-pressed=true]')).toHaveText(['Threads']);
  await page.getByRole('link', { name: /my blyg/ }).first().click();
  await expect(page).toHaveURL(/sub=own.*lens=threads|lens=threads.*sub=own/);
  await expect(page.locator('.reading-entry').filter({ hasText: `Lens thread ${stamp}` })).toBeVisible();
  // The thread quotes the fragment, so the fragment's own entry is the one without the thread's title.
  const fragmentEntry = page.locator('.reading-entry').filter({ hasText: `Lens fragment ${stamp}` }).filter({ hasNotText: `Lens thread ${stamp}` });
  await expect(fragmentEntry).toHaveCount(0);

  await bar.getByRole('button', { name: 'Fragments' }).click();
  await expect(fragmentEntry).toBeVisible();
  await expect(page.locator('.reading-entry').filter({ hasText: `Lens thread ${stamp}` })).toHaveCount(0);

  // Withdrawn posts are background: out of every other lens, and the only thing in this one.
  await api(page, 'POST', `/items/${thread}/withdraw`, {});
  await page.reload(); // the withdrawal came by API, not through the UI that would refresh its cache
  const withdrawn = page.locator(`.reading-entry[data-key="own:${thread}"]`);
  await bar.getByRole('button', { name: 'Background' }).click();
  await expect(page).toHaveURL(/lens=background/);
  await expect(page.locator('.view-sub').first()).toContainText('Withdrawn posts');
  await expect(withdrawn).toBeVisible();
  await expect(withdrawn).toContainText('withdrawn');
  await expect(page.locator(`.reading-entry[data-key="own:${frag}"]`)).toHaveCount(0);
  await bar.getByRole('button', { name: 'All' }).click();
  await expect(page.locator(`.reading-entry[data-key="own:${frag}"]`)).toBeVisible();
  await expect(withdrawn).toHaveCount(0);
  await bar.getByRole('button', { name: 'Threads' }).click();
  await expect(withdrawn).toHaveCount(0);
  await bar.getByRole('button', { name: 'Smart Feed' }).click();
  await expect(page.locator('.lens-placeholder')).toContainText('Coming soon. Feed sorted and filtered by your AI agent.');
  // The placeholder keeps the screen's head: tabs, title and count, ＋.
  await expect(page.getByRole('group', { name: 'reading view' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^my blyg/ })).toContainText(/\d+ items/);
  await expect(page.getByRole('button', { name: 'subscribe', exact: true })).toBeVisible();
  await page.locator('.lens-placeholder').getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/studio\/settings$/);
});

test('signals lists current thumbs and the activity log', async ({ page }) => {
  await login(page);
  expect((await api(page, 'PUT', `/signals/parity-native/${NATIVE}`, { thumb: 1 })).status).toBe(200);
  try {
    await page.goto('/studio/more');
    await page.getByRole('link', { name: /signals/ }).click();
    await expect(page).toHaveURL(/\/studio\/signals$/);
    await expect(page.locator('.signals-note')).toContainText('never published');
    const liked = page.locator('.signals-list li').filter({ hasText: 'Native title' });
    await expect(liked).toBeVisible();
    await page.getByRole('button', { name: /activity/ }).click();
    await expect(page.locator('.signals-list li[data-kind="thumb_up"]').filter({ hasText: 'Native title' }).first()).toBeVisible();
  } finally {
    await api(page, 'DELETE', `/signals/parity-native/${NATIVE}`);
  }
});

test('settings: a model per AI function from the manifest, other…, a reserved authoring row, and the feed prompt', async ({ page }) => {
  await login(page);
  const before = (await api(page, 'GET', '/settings')).json;
  try {
    await page.goto('/studio/settings');
    await expect(page.locator('.model-hint')).toContainText('models.json');
    await expect(page.locator('.provider-keys li')).toHaveCount(5);
    // Workers AI (studio#8) is a binding, not a key; the e2e server binds none.
    await expect(page.locator('.provider-keys li').nth(3)).toContainText('Cloudflare Workers AI no binding (AI)');
    await page.locator('#aiModelTk').selectOption('claude-sonnet-5-5');
    await page.locator('#aiModelFeed').selectOption('__other__');
    await page.getByLabel('feed scoring model id').fill('gemini-9-future');
    await expect(page.locator('#ai_model_authoring')).toBeDisabled();
    await page.locator('#feedPrompt').fill('Prioritize tech news.');
    await page.locator('#settings-form button[type=submit]').first().click();
    await expect.poll(async () => (await api(page, 'GET', '/settings')).json).toMatchObject({
      aiModelTk: 'claude-sonnet-5-5',
      aiModelFeed: 'gemini-9-future',
      feedPrompt: 'Prioritize tech news.',
    });
    // An unlisted saved model reopens as other…, with its id shown.
    await page.reload();
    await expect(page.locator('#aiModelFeed')).toHaveValue('__other__');
    await expect(page.getByLabel('feed scoring model id')).toHaveValue('gemini-9-future');
  } finally {
    await api(page, 'PATCH', '/settings', { aiModelTk: before.aiModelTk, aiModelChangelog: before.aiModelChangelog, aiModelFeed: before.aiModelFeed, feedPrompt: before.feedPrompt });
  }
});

test('own items in the reading feed: stub ↗ opens a quoting stub, and fork is offered', async ({ page }) => {
  await login(page);
  const stamp = Date.now();
  const own = (await api(page, 'POST', '/items', { contentMd: `Own feed item ${stamp}` })).json.id;
  await api(page, 'POST', `/items/${own}/publish`, {});
  await page.goto('/studio/reading?sub=all');
  const entry = page.locator('.reading-entry').filter({ hasText: `Own feed item ${stamp}` });
  await expect(entry).toBeVisible();
  await expect(entry.getByRole('button', { name: 'add to hopper' })).toBeVisible();
  await entry.getByRole('button', { name: 'more actions' }).click();
  await expect(page.getByText('fork', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const created = page.waitForResponse((r) => r.url().endsWith('/api/items') && r.request().method() === 'POST');
  await entry.locator(`[data-action="stub"][data-remote="${own}"]`).click();
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({ mode: 'response', source: { subscriptionId: '~own', remoteId: own } });
  await expect(page.locator('#md-input')).toHaveValue(`![[${own}]]\n\n`);
});
