import { test, expect, type Page } from './fixture';
import { answerSheet } from './sheets.ts';
import { editorMenu, expandRow, openCard } from './editor.ts';
// An entry's ⋯ sheet (an untitled menu sheet is named "actions").
async function entryMenu(page: Page, entry: ReturnType<Page['locator']>) {
  await entry.getByRole('button', { name: 'more actions', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'actions' });
  await expect(sheet).toBeVisible();
  return sheet;
}
async function login(page: Page) {
  await page.goto('/studio/login'); await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
test('reading preserves retained snapshots and restricts legacy actions', async ({ page }) => {
  await login(page); await page.goto('/studio/reading?sub=parity-native');
  await expect(page.locator('.reading-entry')).toHaveCount(2);
  // A withdrawn post is background: not in the feed, and kept (with its pinned snapshot) under Background.
  await expect(page.locator('.reading-entry').filter({ hasText: 'Pinned retained text.' })).toHaveCount(0);
  const feed = page.url();
  await page.goto('/studio/reading?sub=parity-native&lens=background');
  const retained = page.locator('.reading-entry').filter({ hasText: 'Pinned retained text.' });
  await expect(page.locator('.reading-entry')).toHaveCount(1);
  await expect(retained).toContainText('retained pinned v1');
  await expect((await entryMenu(page, retained)).getByRole('button', { name: 'copy [[id]]', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto(feed);
  const native = page.locator('.reading-entry').filter({ hasText: 'Native title' });
  await expect(native.locator('.entry-title a')).toHaveAttribute('href', 'https://source.example/native');
  await expect(native).toContainText('Frozen quote from a prior version.');
  await page.goto('/studio/reading?sub=parity-rss');
  const legacy = page.locator('.reading-entry');
  await expect(legacy).toContainText('Legacy title');
  await expect(legacy.locator('.entry-title a')).toHaveAttribute('href', 'https://legacy.example/post');
  const menu = await entryMenu(page, legacy);
  await expect(menu.getByRole('button', { name: 'copy [[id]]', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'link post ↗', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'history' })).toHaveCount(0);
  await expect(menu).toContainText('https://legacy.example/post');
  await page.keyboard.press('Escape');
  // The Sources tab leads to the sources list, where the source is listed.
  await page.getByRole('group', { name: 'reading view' }).getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page.locator('.feed[data-id="parity-rss"]')).toContainText('Legacy source');
});
test('hopper uses stored HTML instead of re-previewing remote markdown', async ({ page }) => {
  await login(page);
  const previews: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/preview') previews.push(request.url()); });
  await page.goto('/studio/hoppers/parity-hopper');
  await expect(page.locator('.reading-entry')).toContainText('Frozen quote from a prior version.');
  expect(previews).toEqual([]);
});
for (const kind of ['fragment', 'thread'] as const) test(`${kind} discard changes restores the working copy without rewinding publication`, async ({ page }) => {
  await login(page);
  const id = await page.evaluate(async kind => {
    const item = await (await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, contentMd: 'published text' }) })).json();
    const published = await (await fetch(`/api/items/${item.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: item.revision }) })).json();
    await fetch(`/api/items/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentMd: 'unpublished edit', expectedRevision: published.revision }) });
    return item.id as string;
  }, kind);
  await page.goto(`/studio/edit/${id}`);
  await editorMenu(page, 'discard changes');
  await answerSheet(page, { name: /^Discard unpublished changes and go back to the published v1\?/ });
  await expect(page.locator('#md-input')).toHaveValue('published text');
  expect(await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json(), id)).toMatchObject({ version: 1, dirty: false, contentMd: 'published text' }); // clean since session 46: discard restores the published version whole
  await expect(page.locator('[data-action=view-version]')).toHaveCount(1);
});
test('quick edit retains markdown and persists without leaving compose', async ({ page }) => {
  await login(page); await page.locator('#composer-text').fill('**Quick draft**'); await page.locator('#save-draft-btn').click();
  const selected = page.locator('.item-row').filter({ hasText: 'Quick draft' }).first();
  await expect(selected).toBeVisible();
  const id = await selected.getAttribute('data-id');
  const row = await expandRow(page, id!);
  await expect(row).not.toContainText('**Quick draft**');
  await row.getByRole('button', { name: 'quick edit', exact: true }).click();
  await expect(row.getByRole('textbox', { name: 'quick edit' })).toHaveValue('**Quick draft**');
  await row.getByRole('textbox', { name: 'quick edit' }).fill('New **working copy**');
  await row.getByRole('button', { name: 'save draft', exact: true }).click();
  await expect(row.locator('.save-state')).toHaveText('saved');
  await expect(page.locator('#composer-text')).toBeVisible();
  await expect(row).toContainText('New working copy');
});
test('syntax links stay inside the Studio and paging rejects out-of-range bookmarks', async ({ page }) => {
  await login(page); await page.goto('/studio/syntax');
  await expect(page.locator('.prose a[href="/studio/reading"]')).toHaveCount(2);
  await page.goto('/studio/reading?sub=missing&offset=999999');
  await expect(page).toHaveURL(/sub=all&offset=0/);
  await expect(page.locator('.reading-entry').first()).toBeVisible();
});

for (const [path, current] of [['', 'compose'], ['/reading', 'reading'], ['/hoppers', 'hoppers'], ['/mentions', 'mentions'], ['/updates', 'updates'], ['/more', 'more'], ['/settings', 'more'], ['/syntax', 'more'], ['/subs', 'reading'], ['/hoppers/parity-hopper', 'hoppers']] as const) test(`navigation tab bar remains stable on ${path || 'compose'}`, async ({ page }) => {
  await login(page); await page.goto(`/studio${path}`);
  const tabs = page.getByRole('navigation', { name: 'studio' }).getByRole('link');
  await expect(tabs.locator('.tl')).toHaveText(['reading', 'compose', 'hoppers', 'mentions', 'updates', 'more']);
  await expect(tabs.nth(1)).toHaveAttribute('href', '/studio/');
  await expect(tabs.nth(4)).toHaveAttribute('href', '/studio/updates');
  await expect(tabs.nth(5)).toHaveAttribute('href', '/studio/more');
  await expect(page.locator('nav.tabbar a[aria-current=page] .tl')).toHaveText(current);
  await expect(page.locator('nav.tabbar a[aria-current=page]')).toHaveAccessibleName(current);
  const publicPage = page.getByRole('link', { name: 'public page ↗' }).first();
  await expect(publicPage).toHaveAttribute('target', '_blank');
  await expect(publicPage).toHaveAttribute('href', '/');
  // The scrollbar track is reserved on wide screens (no sideways jump between short and long
  // pages) and not on phones, where it would be a dead strip beside the full-width bars.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter)).toBe(page.viewportSize()!.width >= 900 ? 'stable' : 'auto');
  // A bottom tab bar on a phone, a left rail at desktop width — visible either way, no menu button.
  const box = (await page.locator('nav.tabbar').boundingBox())!;
  const viewport = page.viewportSize()!;
  if (test.info().project.name === 'mobile') {
    expect(Math.round(box.y + box.height)).toBe(viewport.height);
    expect(Math.round(box.width)).toBe(viewport.width);
    await expect(page.locator('.topbar .tb-btn .lbl')).toBeHidden();
  } else {
    expect(box.x).toBe(0);
    expect(box.width).toBeLessThan(120);
    await expect(page.locator('.topbar .tb-btn .lbl')).toBeVisible();
  }
});

test('the tab bar navigates between screens without a document load', async ({ page }) => {
  await login(page);
  const documents: string[] = []; page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
  const tabs = page.getByRole('navigation', { name: 'studio' });
  await tabs.getByRole('link', { name: 'hoppers', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/hoppers$/);
  await expect(page.locator('.hopper-row').first()).toBeVisible();
  await tabs.getByRole('link', { name: 'mentions', exact: true }).click();
  await expect(page.locator('.mention-group').first()).toBeVisible();
  await tabs.getByRole('link', { name: 'more', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'more', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'settings', exact: true }).click();
  await expect(page.locator('#siteTitle')).toBeVisible();
  await expect(tabs.locator('a[aria-current=page]')).toHaveAccessibleName('more');
  await tabs.getByRole('link', { name: 'compose', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  expect(documents).toEqual([]);
});

test('more offers settings, syntax, the public page and a log out that posts', async ({ page }) => {
  await login(page); await page.goto('/studio/more');
  await expect(page.getByRole('link', { name: 'settings', exact: true })).toHaveAttribute('href', '/studio/settings');
  await expect(page.getByRole('link', { name: 'syntax', exact: true })).toHaveAttribute('href', '/studio/syntax');
  await expect(page.locator('main').getByRole('link', { name: 'public page ↗' })).toHaveAttribute('href', '/');
  await expect(page.locator('form[action="/studio/logout"]')).toHaveAttribute('method', 'post');
  await page.getByRole('button', { name: 'log out', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/login$/);
  await page.goto('/studio/more');
  await expect(page).toHaveURL(/\/studio\/login$/);
});

test('palette pages all candidates and applies bracket grammar in each composer', async ({ page }) => {
  await login(page);
  const token = `${test.info().project.name}-palettetoken`;
  await page.evaluate(async token => {
    for (let i = 0; i < 23; i++) {
      const item = await (await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentMd: `${token} ${i}` }) })).json();
      await fetch(`/api/items/${item.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: item.revision }) });
    }
  }, token);
  await page.reload();
  await page.locator('#composer-text').fill(`[[${token}`);
  await expect(page.getByRole('listbox', { name: 'items' }).getByRole('option')).toHaveCount(20);
  await page.getByRole('button', { name: 'load more (20 of 23)' }).click();
  await expect(page.getByRole('listbox', { name: 'items' }).getByRole('option')).toHaveCount(23);
  await page.getByRole('listbox', { name: 'items' }).getByRole('option').last().click();
  await expect(page.locator('#composer-text')).toHaveValue(/^\[\[[0-9a-z]{26} \| “[^\]]+”\]\]$/); // the long form (#70)
  await page.locator('#composer-text').fill(`![[${token}`);
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.locator('#composer-text').fill('thread picker');
  await page.getByRole('radio', { name: 'thread', exact: true }).click();
  await page.locator('#composer-full').click();
  await page.locator('#md-input').fill(`![[${token}`);
  await expect(page.getByRole('listbox', { name: 'items' }).getByRole('option')).toHaveCount(20);
  await page.getByRole('listbox', { name: 'items' }).getByRole('option').first().click();
  await expect(page.locator('#md-input')).toHaveValue(/^!\[\[[0-9a-z]{26} \| “[^\]]+”\]\]$/);
  await expect(page.locator('#palette-search')).toHaveCount(0);
});

test('editor kind, discard, pinned history and TK controls retain their contracts', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('radio', { name: 'fragment', exact: true })).toBeChecked();
  await page.locator('#composer-text').fill('plain draft');
  await expect(page.getByRole('button', { name: 'generate in editor →' })).toHaveCount(0);
  await page.locator('#composer-text').fill('[TK]instruction[/TK]');
  await expect(page.getByRole('button', { name: 'generate in editor →' })).toBeVisible();
  await page.locator('#composer-full').click();
  await expect(page.locator('#tk')).toBeVisible();
  await page.getByRole('button', { name: 'more actions' }).click();
  await expect(page.getByRole('dialog', { name: 'actions' }).getByRole('button', { name: 'discard draft', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'actions' })).toHaveCount(0);
  await expect(page.locator('[data-action=switch-kind]')).toBeVisible();
  await page.locator('#md-input').fill('No transclusions');
  await page.locator('[data-action=switch-kind]').click();
  await expect(page.locator('[data-action=switch-kind]')).toContainText('make this a fragment');
  await page.locator('#publish-btn').click();
  await expect(page.locator('[data-action=switch-kind]')).toHaveCount(0);
  await page.getByRole('button', { name: 'more actions' }).click();
  await expect(page.getByRole('dialog', { name: 'actions' }).getByRole('button', { name: 'withdraw', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'actions' }).getByRole('button', { name: 'discard draft', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await openCard(page, 'history');
  await page.locator('[data-action=pin]').click();
  await answerSheet(page, { name: /^Pin v1\? This is irrevocable/ });
  const pinned = page.getByRole('link', { name: '📌 pinned', exact: true });
  await expect(pinned).toHaveAttribute('href', /\/t\/[^/]+\/v1\/$/);
  expect((await page.request.get((await pinned.getAttribute('href'))!)).status()).toBe(200);
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  await page.getByRole('link', { name: '← compose', exact: true }).click();
  const row = await expandRow(page, id);
  await expect(row.locator('.version-summary')).toContainText('1 version');
  await expect(row.locator('.pin-chips a')).toHaveAttribute('href', /\/t\/[^/]+\/v1\/$/);
});

test('reading copy actions sit in the ⋯ sheet beside copy url, never beside stub, and link post creates only once', async ({ page }) => {
  await login(page); await page.goto('/studio/reading?sub=parity-native');
  const entry = page.locator('.reading-entry').filter({ hasText: 'Native title' });
  await expect(entry.locator('.entry-bar')).not.toContainText('copy [[id]]');
  await expect(entry.locator('.entry-bar')).not.toContainText(/respond|reply|answer/);
  const menu = await entryMenu(page, entry);
  await expect(menu.getByRole('button')).toHaveText([/link post ↗$/, /fork$/, /copy \[\[id\]\]$/, /copy url$/, /share…$/, /source\.example.*↗/, /history$/]);
  await expect(menu).not.toContainText(/stub|quote|respond|reply|answer/);
  const created = page.waitForResponse(response => response.url().endsWith('/api/items') && response.request().method() === 'POST');
  await menu.getByRole('button', { name: 'link post ↗', exact: true }).click();
  const response = await created;
  expect(response.request().postDataJSON()).toEqual({ kind: 'fragment', contentMd: '[[00000000000000000000000001]]\n\n' });
  const id = (await response.json()).id;
  await expect(page.locator('#md-input')).toHaveValue('[[00000000000000000000000001]]\n\n');
  await page.reload(); await expect(page.locator('#md-input')).toHaveValue('[[00000000000000000000000001]]\n\n');
  await expect(page).toHaveURL(new RegExp(`/edit/${id}$`));
});

test('settings keep timezone, receive policy, themes and update preferences', async ({ page }) => {
  await login(page); await page.goto('/studio/settings');
  await page.locator('#timezone').selectOption('America/Denver');
  await page.locator('#acceptMentions').uncheck();
  await page.locator('#updateCheck').uncheck();
  await page.locator('.theme-opt').filter({ hasText: 'Paper' }).click();
  await page.getByRole('button', { name: 'save settings', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('saved');
  await page.reload();
  await expect(page.locator('#timezone')).toHaveValue('America/Denver');
  await expect(page.locator('#acceptMentions')).not.toBeChecked();
  await expect(page.locator('#updateCheck')).not.toBeChecked();
  await expect(page.locator('[name=theme][value=paper]')).toBeChecked();
});

test('mentions group verified pointers, retain hidden rows and show source guidance', async ({ page }) => {
  await login(page); await page.goto('/studio/mentions');
  const group = page.locator('.mention-group').filter({ hasText: 'Mention target fixture' });
  await expect(group).toContainText('2 responses');
  await expect(group.locator('.rel')).toHaveText(['stub', 'stub']);
  await expect(group.getByRole('button', { name: 'stub back ↗', exact: true })).toHaveCount(1);
  await expect(group).toContainText('subscribe to https://stranger.example/ to stub back');
  await expect(group).not.toContainText('Frozen source text');
  await expect(group.locator('.hidden-row')).toContainText('Source author');
  await expect(group.locator('.hidden-row').getByRole('button', { name: 'show on page', exact: true })).toBeVisible();
  // The page-visibility pills write the item's responses override.
  await group.getByRole('button', { name: 'show', exact: true }).click();
  await expect(group.getByRole('button', { name: 'show', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(group).toContainText('1 on the page now');
  await page.getByRole('button', { name: /^outbound/ }).click();
  await expect(page.locator('.out-row')).toContainText('https://recipient.example/post');
  await expect(page.locator('.out-row')).toContainText('retrying after');
  await expect(page.locator('.mentions-note').last()).toContainText('No site URL is set');
});

test('subscription changes roll back on failure and stay durable on success', async ({ page }) => {
  // /subs is gone: each source's inspector sheet in reading manages it.
  await login(page); await page.goto('/studio/subs');
  await expect(page).toHaveURL(/\/studio\/reading\?view=sources$/);
  const row = page.locator('.feed[data-id="parity-native"]');
  const inspector = page.getByRole('dialog', { name: 'Native source' });
  const inspect = async () => { await row.getByRole('button', { name: 'about Native source', exact: true }).click(); await expect(inspector).toBeVisible(); };
  await inspect();
  await expect(inspector).toContainText('https://source.example/');
  await page.keyboard.press('Escape');
  await page.route('**/api/subscriptions/parity-native', route => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, json: { code: 'internal', message: 'subscription write failed' } }) : route.continue());
  await inspect(); await inspector.getByRole('button', { name: 'pause', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('subscription write failed');
  await expect(row.locator('.fs')).not.toHaveText('paused');
  await page.unroute('**/api/subscriptions/parity-native');
  await inspect(); await inspector.getByRole('button', { name: 'pause', exact: true }).click();
  await expect(row.locator('.fs')).toHaveText('paused');
  await page.reload(); await expect(row.locator('.fs')).toHaveText('paused');
  await inspect(); await inspector.getByRole('button', { name: 'resume', exact: true }).click();
  await expect(row.locator('.fs')).not.toHaveText('paused');
});

test('hopper creation, rename and public slug work through the API', async ({ page }) => {
  await login(page); await page.goto('/studio/hoppers');
  await expect(page.locator('.hopper-row').filter({ hasText: 'Frozen hopper' })).toContainText('1 items · 1 sources');
  await page.getByRole('textbox', { name: 'hopper name' }).fill('Hopper browser fixture');
  await page.getByRole('button', { name: 'create hopper', exact: true }).click();
  await page.getByRole('link', { name: 'Hopper browser fixture', exact: true }).click();
  await page.getByRole('checkbox', { name: 'public', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'public', exact: true })).toBeChecked();
  await expect(page.getByText('The public URL stays fixed')).toBeVisible();
  const publicUrl = await page.locator('a[href^="/h/"]').getAttribute('href');
  await page.locator('[name=name]').fill('Renamed hopper');
  await page.getByRole('button', { name: 'rename', exact: true }).click();
  await expect(page.locator('h2')).toHaveText('Renamed hopper');
  await expect(page.locator('a[href^="/h/"]')).toHaveAttribute('href', publicUrl!);
  await page.goto('/studio/hoppers/not-a-hopper');
  await expect(page.getByRole('alert')).toContainText('not found');
});

test('update notice acknowledgement survives reload and the upgrade banner obeys preferences', async ({ page }) => {
  await page.route('**/api/update-state', route => route.fulfill({ json: { updateLatestSeen: '99.0.0' } }));
  await login(page);
  await page.evaluate(async () => { await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updateCheck: true, updateNoticeAck: false }) }); });
  await page.reload();
  // Behind: a compact badge in the top bar leads to the notices on more.
  await page.locator('#update-badge').click();
  await expect(page).toHaveURL(/\/studio\/more$/);
  await expect(page.locator('#update-notice')).toBeVisible();
  await expect(page.locator('#update-behind')).toContainText('99.0.0');
  await expect(page.locator('#update-behind')).toContainText('npm run upgrade');
  await expect(page.locator('#update-notice').getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('href', '/studio/settings');
  await page.getByRole('button', { name: 'got it', exact: true }).click();
  await expect(page.locator('#update-notice')).toHaveCount(0);
  await page.getByRole('link', { name: 'settings', exact: true }).click();
  await page.locator('#siteTitle').fill('Notice acknowledgement stays saved');
  await page.getByRole('button', { name: 'save settings', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('saved');
  await page.goto('/studio/more'); await expect(page.locator('#update-behind')).toBeVisible();
  await expect(page.locator('#update-notice')).toHaveCount(0);
  await page.reload(); await expect(page.locator('#update-behind')).toBeVisible();
  await expect(page.locator('#update-notice')).toHaveCount(0);
  await page.evaluate(async () => { await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updateCheck: false }) }); });
  await page.reload(); await expect(page.getByRole('heading', { name: 'more', exact: true })).toBeVisible();
  await expect(page.locator('.update-banner')).toHaveCount(0);
  await expect(page.locator('#update-badge')).toHaveCount(0);
});

test('fork picker refreshes pinned versions after a client navigation', async ({ page }) => {
  await login(page);
  await page.locator('#composer-text').fill('First pinned text');
  await page.locator('#composer-full').click();
  await page.locator('#publish-btn').click();
  await openCard(page, 'history');
  await page.locator('[data-action=pin]').click();
  await answerSheet(page, { name: /^Pin v1\?/ });
  const editor = page.url();
  await page.getByRole('link', { name: 'fork', exact: true }).click();
  await expect(page.locator('[data-action=fork]')).toHaveCount(1);
  await page.goBack();
  await expect(page).toHaveURL(editor);
  await page.locator('#md-input').fill('Second pinned text');
  await page.locator('#publish-btn').click();
  await expect(page.locator('[data-action=view-version]')).toHaveCount(2);
  await openCard(page, 'history');
  await page.locator('[data-action=pin]').click();
  await answerSheet(page, { name: /^Pin v2\?/ });
  await page.getByRole('link', { name: 'fork', exact: true }).first().click();
  await expect(page.locator('[data-action=fork]')).toHaveCount(2);
});

test('palette keeps results on failure and rejects late results for an old query', async ({ page }) => {
  await login(page);
  let reject = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let delayed!: () => void;
  const started = new Promise<void>(resolve => { delayed = resolve; });
  await page.route('**/api/search?**', async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('q') === 'oldquery' && query.get('offset') === '20') {
      if (reject) return route.fulfill({ status: 503, json: { code: 'internal', message: 'search unavailable' } });
      delayed(); await gate;
      await route.fulfill({ json: { items: [{ id: 'old-late', excerpt: 'Late old result' }], total: 21, offset: 20, limit: 20 } }).catch(() => {});
    } else if (query.get('q') === 'oldquery') {
      await route.fulfill({ json: { items: Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, excerpt: `Old result ${i}` })), total: 21, offset: 0, limit: 20 } });
    } else {
      await route.fulfill({ json: { items: [{ id: 'new', excerpt: 'New result only' }], total: 1, offset: 0, limit: 20 } });
    }
  });
  await page.locator('#composer-text').fill('[[oldquery');
  await expect(page.getByRole('listbox', { name: 'items' }).getByRole('option')).toHaveCount(20);
  await page.getByRole('button', { name: 'load more (20 of 21)' }).click();
  await expect(page.getByRole('alert')).toContainText('search unavailable');
  await expect(page.getByRole('listbox', { name: 'items' }).getByRole('option')).toHaveCount(20);
  reject = false;
  await page.getByRole('button', { name: 'retry search', exact: true }).click();
  await started;
  await page.locator('#composer-text').fill('[[newquery');
  await expect(page.getByRole('listbox', { name: 'items' }).getByRole('option').locator('.picker-excerpt')).toHaveText(['New result only']);
  release();
  await expect(page.getByRole('listbox', { name: 'items' }).getByRole('option').locator('.picker-excerpt')).toHaveText(['New result only']);
});

test('whole-fragment TK wrapping keeps text and publication warnings remain visible', async ({ page }) => {
  await login(page); await page.locator('#composer-text').fill('Current fragment');
  await page.locator('#composer-full').click();
  await openCard(page, 'tk');
  await page.locator('#tk-generate-whole-btn').click();
  await answerSheet(page, { name: 'Instruction for the whole fragment:', text: 'Rewrite this' });
  await expect(page.locator('#md-input')).toHaveValue('[TK]Rewrite this[=]Current fragment[/TK]');
  await page.locator('#md-input').fill('Published with a warning');
  await page.route('**/api/items/*/publish', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), warning: 'Mention delivery is waiting for a site URL.' } });
  });
  await page.locator('#publish-btn').click();
  await expect(page.locator('.publish-warning')).toHaveText('Mention delivery is waiting for a site URL.');
});

