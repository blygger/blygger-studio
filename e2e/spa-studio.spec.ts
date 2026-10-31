import { test, expect, type Page } from './fixture';
async function login(page: Page) {
  await page.goto('/studio/login'); await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
async function edit(page: Page) {
  await login(page); await page.locator('#composer-text').fill('Original draft');
  await page.locator('#composer-full').click(); await expect(page.locator('#md-input')).toHaveValue('Original draft');
  return new URL(page.url()).pathname.split('/').at(-1)!;
}
async function seedReading(page: Page, minimum: number) {
  await page.evaluate(async minimum => {
    const total = (await (await fetch('/api/reading')).json()).total as number;
    for (let i = total; i < minimum; i++) {
      const response = await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentMd: `Preload fixture ${i}` }) });
      const item = await response.json() as { id: string; revision: number };
      const published = await fetch(`/api/items/${item.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: item.revision }) });
      if (!response.ok || !published.ok) throw new Error('Cannot seed reading fixture');
    }
  }, minimum);
}
test('SPA creates, edits, previews and publishes without document navigation', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const id = await edit(page);
  const documents: string[] = []; page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
  await page.locator('#md-input').fill('React **round trip**');
  await expect(page.locator('#preview-body strong')).toHaveText('round trip');
  await page.locator('#publish-btn').click();
  await expect(page.locator('[data-action=view-version]')).toHaveCount(1);
  expect(await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json(), id)).toMatchObject({ version: 1, contentMd: 'React **round trip**' });
  // The editor has no tab bar (PWA phase 2A): back to compose, then reading.
  await page.getByRole('link', { name: '← compose', exact: true }).click();
  await page.getByRole('link', { name: 'reading', exact: true }).click();
  await expect(page.locator('.reading-entry').first()).toBeVisible();
  const entry = page.locator('.reading-entry').filter({ has: page.locator(`a[href$="/edit/${id}"]`) });
  for (let n = 0; n < 6 && !await entry.count(); n++) { await page.getByRole('button', { name: 'older', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`offset=${(n + 1) * 25}`)); }
  await expect(entry).toContainText('React round trip');
  expect(documents).toEqual([]); expect(errors).toEqual([]);
});
test('failed DB mutation rolls back cached state and retains the local draft', async ({ page }) => {
  const id = await edit(page); await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 10_000));
  await page.route(`**/api/items/${id}`, route => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, json: { code: 'internal', message: 'save unavailable' } }) : route.continue());
  await page.locator('#md-input').fill('Unacknowledged text'); await page.locator('#save-draft-btn').click();
  await expect(page.getByRole('alert')).toContainText('save unavailable');
  await expect(page.locator('#md-input')).toHaveValue('Unacknowledged text');
  expect(await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json(), id)).toMatchObject({ contentMd: 'Original draft', version: 0 });
  await page.unroute(`**/api/items/${id}`); await page.locator('#save-draft-btn').click();
  await expect(page.locator('.save-state')).toHaveText('saved');
  expect(await page.evaluate(async id => (await fetch(`/api/items/${id}`)).json(), id)).toMatchObject({ contentMd: 'Unacknowledged text' });
});
test('polling updates cached reads without replacing editor text', async ({ page }) => {
  const id = await edit(page); await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 10_000));
  await page.locator('#md-input').fill('Local draft');
  const published = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}`) && response.request().method() === 'PATCH');
  await page.clock.runFor(401); await published;
  await page.evaluate(async id => {
    const observed = await (await fetch(`/api/items/${id}`)).json();
    const response = await fetch(`/api/items/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentMd: 'Changed in another client', expectedRevision: observed.revision }) });
    if (!response.ok) throw new Error('Foreign fixture edit failed');
  }, id);
  const polled = page.waitForResponse(response => response.url().endsWith(`/api/items/${id}`) && response.request().method() === 'GET');
  await page.clock.runFor(15_000); await polled;
  await expect(page.locator('#md-input')).toHaveValue('Local draft');
});
test('reading walks real API pages without gaps or repeats', async ({ page }) => {
  await login(page);
  const ids = await page.evaluate(async () => {
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) {
      const item = await (await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentMd: `Page fixture ${i}` }) })).json() as { id: string; revision: number };
      await fetch(`/api/items/${item.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: item.revision }) }); ids.push(item.id);
    } return ids;
  });
  await page.goto('/studio/reading?sub=all');
  const observed: string[] = [];
  const total = await page.evaluate(async () => (await (await fetch('/api/reading')).json()).total as number);
  const count = Math.ceil(total / 25);
  for (let i = 0; i < count; i++) {
    const expectedPage = await page.evaluate(async offset => { const page = await (await fetch(`/api/reading?offset=${offset}&limit=25`)).json(); return page.items.filter((entry: { own: unknown }) => entry.own).map((entry: { own: { id: string } }) => entry.own.id) as string[]; }, i * 25);
    await expect(page.locator('.reading-entry')).toHaveCount(Math.min(25, total - i * 25));
    await expect.poll(() => page.locator('.reading-entry a[href*="/edit/"]').evaluateAll(elements => elements.map(element => new URL((element as HTMLAnchorElement).href).pathname.split('/').at(-1)!))).toEqual(expectedPage);
    observed.push(...await page.locator('.reading-entry a[href*="/edit/"]').evaluateAll(elements => elements.map(element => new URL((element as HTMLAnchorElement).href).pathname.split('/').at(-1)!)));
    if (i + 1 < count) await page.getByRole('button', { name: 'older', exact: true }).click();
  }
  const expected = await page.evaluate(async () => { const ids: string[] = []; for (let offset = 0;; offset += 25) { const page = await (await fetch(`/api/reading?offset=${offset}&limit=25`)).json(); ids.push(...page.items.filter((entry: { own: unknown }) => entry.own).map((entry: { own: { id: string } }) => entry.own.id)); if (offset + page.items.length >= page.total) return ids; } });
  expect(observed).toEqual(expected);
  expect(observed.filter(id => ids.includes(id))).toHaveLength(52);
  expect(new Set(observed).size).toBe(observed.length);
});

for (const intent of ['hover', 'focus'] as const) {
  test(`route intent (${intent}) preloads reading before navigation and reuses the DB cache`, async ({ page }) => {
    await login(page); await seedReading(page, 50);
    const reads: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/reading') reads.push(request.url()); });
    const link = page.getByRole('link', { name: 'reading', exact: true });
    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reading');
    await link[intent](); await loaded;
    await expect(page.locator('#composer-text')).toBeVisible();
    const before = reads.length;
    expect(before).toBe(1);
    await link.click();
    // /reading is the feed, rendered from the preloaded page.
    await expect(page.locator('.reading-entry').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /^all/ })).toContainText('items');
    expect(reads).toHaveLength(before);
  });
}

for (const destination of ['hoppers', 'sources', 'mentions'] as const) {
  test(`${destination === 'sources' ? 'navigation' : 'hover'} preloads ${destination} card collections`, async ({ page }) => {
    await login(page);
    if (destination === 'sources') {
      await page.goto('/studio/reading');
      await expect(page.getByRole('button', { name: 'Sources', exact: true })).toBeVisible();
    }
    const path = destination === 'mentions'
      ? '/api/mentions/parity-held/source'
      : '/api/hoppers/parity-hopper';
    const reads: string[] = [];
    const matches = (url: string) => {
      const parsed = new URL(url);
      return parsed.pathname === path &&
        (destination === 'mentions' || parsed.searchParams.get('preview') === 'true');
    };
    page.on('request', request => { if (matches(request.url())) reads.push(request.url()); });
    const loaded = page.waitForResponse(response => matches(response.url()) && response.ok());
    const link = destination === 'sources'
      ? page.getByRole('button', { name: 'Sources', exact: true })
      : page.getByRole('link', { name: destination, exact: true });
    const before = page.url();
    if (destination === 'sources') await link.click();
    else await link.hover();
    await loaded;
    if (destination !== 'sources') expect(page.url()).toBe(before);
    expect(reads).toHaveLength(1);
    if (destination !== 'sources') await link.click();
    if (destination === 'mentions') {
      await expect(page.locator('.mention-group').filter({ hasText: 'Mention target fixture' }))
        .toContainText('Source author');
    } else {
      await expect(page.getByRole('link', { name: /Frozen hopper/ })).toBeVisible();
    }
    expect(reads).toHaveLength(1);
  });
}

test('reading search survives reload and loads only the requested page', async ({ page }) => {
  await login(page); await seedReading(page, 50);
  const reads: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/reading') reads.push(request.url()); });
  await page.goto('/studio/reading?sub=own&page=2');
  await expect(page.locator('.reading-entry')).toHaveCount(25);
  expect(reads.map(url => new URL(url).searchParams.get('offset'))).toEqual(['25']);
  await page.reload();
  await expect(page.locator('.reading-entry')).toHaveCount(25);
  expect(reads.map(url => new URL(url).searchParams.get('offset'))).toEqual(['25', '25']);
  await page.getByRole('button', { name: 'newer', exact: true }).click();
  await expect(page).toHaveURL(/offset=0/);
  await expect(page.locator('.reading-entry')).toHaveCount(25);
});

test('settings persist through the DB adapter and a fresh route load', async ({ page }) => {
  await login(page); await page.goto('/studio/settings');
  await page.locator('#siteTitle').fill('React settings fixture');
  await page.getByRole('button', { name: 'save settings', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('saved');
  await page.reload(); await expect(page.locator('#siteTitle')).toHaveValue('React settings fixture');
  expect(await page.evaluate(async () => (await (await fetch('/api/settings')).json()).siteTitle)).toBe('React settings fixture');
});

test('route errors expose a retry that can recover an unavailable item read', async ({ page }) => {
  const id = await edit(page);
  await page.route(`**/api/items/${id}`, route => route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { code: 'internal', message: 'item unavailable' } }) : route.continue());
  await page.reload(); await expect(page.getByRole('alert')).toContainText('item unavailable');
  await page.unroute(`**/api/items/${id}`);
  await page.getByRole('button', { name: 'retry', exact: true }).click();
  await expect(page.locator('#md-input')).toHaveValue('Original draft');
});

test('missing item and hopper routes report not found instead of waiting forever', async ({ page }) => {
  await login(page);
  for (const [path, message] of [
    ['/studio/edit/missing-item', 'Item not found'],
    ['/studio/hoppers/missing-hopper', 'Hopper not found'],
    ['/studio/reading?hopper=missing-hopper', 'Hopper not found'],
  ]) {
    await page.goto(path);
    await expect(page.getByRole('alert')).toContainText(message);
  }
});


test('navigation flushes the editor debounce and blocks failed saves', async ({ page }) => {
  const id = await edit(page);
  await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 10_000));
  await page.locator('#md-input').fill('saved before leaving');
  await page.getByRole('link', { name: '← compose', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  expect(await page.evaluate(async id => (await (await fetch(`/api/items/${id}`)).json()).contentMd, id)).toBe('saved before leaving');
  await page.goto(`/studio/edit/${id}`);
  await page.route(`**/api/items/${id}`, route => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, json: { code: 'internal', message: 'cannot leave safely' } }) : route.continue());
  await page.locator('#md-input').fill('keep this local text');
  await page.getByRole('link', { name: '← compose', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cannot leave safely');
  await expect(page.locator('#md-input')).toHaveValue('keep this local text');
  await expect(page).toHaveURL(new RegExp(`/edit/${id}$`));
});
