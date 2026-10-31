import { test, expect, type Locator, type Page } from './fixture';
import { answerSheet } from './sheets.ts';

// Reading, NetNewsWire-style (PWA redesign phase 2B): the sources list, a
// source's timeline, the inspector sheet, an entry's ⋯ sheet, add-to-hopper,
// the stub editor's passage chooser and the swipes. Every test leaves the shared
// fixture (e2e-server.ts) as it found it; both projects run against it.
const NATIVE = '00000000000000000000000001';
async function login(page: Page) {
  await page.goto('/studio/login'); await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const api = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ({ method, path, body }) => {
  const response = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json().catch(() => null) };
}, { method, path, body });
/** A horizontal mouse drag: a swipe as a desktop browser makes one. */
async function swipe(page: Page, from: Locator, dx: number) {
  // Centred, so a fixed bar (the phone's tab bar) is not over it.
  await from.evaluate(element => element.scrollIntoView({ block: 'center' }));
  const box = (await from.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + i);
  await page.mouse.up();
}
const entryMenu = async (page: Page, entry: Locator) => {
  await entry.getByRole('button', { name: 'more actions', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'actions' });
  await expect(sheet).toBeVisible();
  return sheet;
};
const nativeEntry = (page: Page) => page.locator('.reading-entry').filter({ hasText: 'Native title' });

test('the sources list groups sources, hoppers and subscriptions, and opens a timeline', async ({ page }) => {
  await login(page);
  await page.getByRole('navigation', { name: 'studio' }).getByRole('link', { name: 'reading', exact: true }).click();
  // Reading lands on the feed; Sources is its peer tab.
  await expect(page).toHaveURL(/\/studio\/reading$/);
  const tabs = page.getByRole('group', { name: 'reading view' });
  await expect(tabs.getByRole('button')).toHaveText(['Feed', 'Sources']);
  await expect(tabs.locator('[aria-pressed=true]')).toHaveText('Feed');
  await expect(page.getByRole('heading', { name: /^all/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'subscribe', exact: true })).toBeVisible();
  await tabs.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/reading\?view=sources$/);
  await expect(page.getByRole('heading', { name: /^sources/ })).toContainText('2 subscriptions');
  await expect(page.getByRole('button', { name: 'subscribe', exact: true })).toBeVisible();
  await expect(page.locator('.list-h > span:first-child')).toHaveText(['sources', /^hoppers · \d+$/, /^subscriptions · 2$/]);
  const sources = page.getByRole('list', { name: 'sources' });
  await expect(sources.locator('.ft')).toHaveText(['all', 'my blyg']);
  const total = (await api(page, 'GET', '/reading?limit=1')).json.counts;
  await expect(sources.locator('.fn')).toHaveText([String(total.all), String(total.own)]);
  await expect(page.getByRole('list', { name: 'hoppers' })).toContainText('Frozen hopper');
  await expect(page.getByRole('link', { name: 'manage', exact: true })).toHaveAttribute('href', '/studio/hoppers');
  const legacy = page.locator('.feed[data-id="parity-rss"]');
  await expect(legacy.locator('.fi')).toHaveText('L');
  await expect(legacy.locator('.fs')).toHaveText(/^legacy rss · never polled$/);
  await expect(legacy.locator('.fn')).toHaveText('1');
  // A source opens its timeline: back to sources, its title and count, ⓘ.
  await page.locator('.feed[data-id="parity-native"]').getByRole('link').click();
  await expect(page).toHaveURL(/\/reading\?sub=parity-native&offset=0$/);
  await expect(page.getByRole('heading', { name: /^Native source/ })).toContainText('2 items');
  await expect(page.locator('.reading-entry')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'about this source', exact: true })).toBeVisible();
  await expect(page.locator('.pager')).toContainText('page 1 of 1');
  await tabs.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/reading\?view=sources$/);
  // "all" and "my blyg" are timelines too, with no inspector.
  await page.locator('.feeds a[href*="sub=own"]').click();
  await expect(page.getByRole('heading', { name: /^my blyg/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'about this source' })).toHaveCount(0);
});

test('/subs redirects to reading, where the subscribe sheet lives', async ({ page }) => {
  await login(page); await page.goto('/studio/subs');
  await expect(page).toHaveURL(/\/studio\/reading\?view=sources$/);
  await page.getByRole('button', { name: 'subscribe', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'subscribe' });
  await expect(sheet.locator('#add-sub-url')).toBeFocused();
  // The fixture has no network: the existing flow reports the failure in the sheet.
  await page.route('**/api/subscriptions', route => route.request().method() === 'POST'
    ? route.fulfill({ json: { needsConfirm: true, kind: 'blyg', title: 'Small Hours', siteMismatch: { asserted: 'smallhours.example', actual: 'hours.example' } } })
    : route.continue());
  await sheet.locator('#add-sub-url').fill('https://smallhours.example/');
  await sheet.getByRole('button', { name: 'subscribe', exact: true }).click();
  await expect(sheet).toContainText('Subscribe to Small Hours?');
  await expect(sheet).toContainText('Site mismatch: smallhours.example / hours.example');
  await expect(sheet.getByRole('button', { name: 'confirm subscribe', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('every reading card shows its source URL, opening in a new tab, as the ⋯ sheet names it', async ({ page }) => {
  await login(page); await page.goto('/studio/reading?sub=all');
  const cards = page.locator('.reading-entry');
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  await expect(page.locator('.reading-entry .entry-src')).toHaveCount(count);
  for (const link of await page.locator('.entry-src').all()) await expect(link).toHaveAttribute('target', '_blank');
  await page.goto('/studio/reading?sub=parity-native');
  const link = nativeEntry(page).locator('.entry-src');
  const sheet = await entryMenu(page, nativeEntry(page));
  await expect(sheet.getByRole('button', { name: `${(await link.textContent())!.replace('↗ ', '')} ↗` })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/studio/hoppers/parity-hopper');
  await expect(page.locator('.reading-entry .entry-src').first()).toHaveAttribute('target', '_blank');
});

test('subscribing to a source already subscribed shows the refusal in the sheet', async ({ page }) => {
  await login(page); await page.goto('/studio/reading');
  await page.route('**/api/subscriptions', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, json: { code: 'conflict', message: 'already subscribed to Small Hours' } })
    : route.continue());
  await page.getByRole('button', { name: 'subscribe', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'subscribe' });
  await sheet.locator('#add-sub-url').fill('https://smallhours.example/');
  await sheet.getByRole('button', { name: 'subscribe', exact: true }).click();
  await expect(sheet).toContainText('already subscribed to Small Hours');
  await expect(sheet.getByRole('button', { name: 'confirm subscribe' })).toHaveCount(0);
});

test('confirm subscribe shows progress and closes the sheet on the reply', async ({ page }) => {
  await login(page); await page.goto('/studio/reading');
  const existing = await page.evaluate(async () => (await (await fetch('/api/subscriptions')).json()).items[0]);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/subscriptions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    if (!route.request().postDataJSON().confirm) return route.fulfill({ json: { needsConfirm: true, kind: 'blyg', title: 'Small Hours' } });
    await held;
    return route.fulfill({ status: 201, json: existing });
  });
  await page.getByRole('button', { name: 'subscribe', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'subscribe' });
  await sheet.locator('#add-sub-url').fill('https://smallhours.example/');
  await sheet.getByRole('button', { name: 'subscribe', exact: true }).click();
  await sheet.getByRole('button', { name: 'confirm subscribe', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'subscribing…' })).toBeDisabled();
  release();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByText('subscribed', { exact: true })).toBeVisible();
});

test('the source inspector toggles the blogroll, pauses and resumes, and confirms a delete', async ({ page }) => {
  await login(page); await page.goto('/studio/reading?view=sources');
  const row = page.locator('.feed[data-id="parity-rss"]');
  const inspector = page.getByRole('dialog', { name: 'Legacy source' });
  const inspect = async () => { await row.getByRole('button', { name: 'about Legacy source', exact: true }).click(); await expect(inspector).toBeVisible(); };
  await inspect();
  await expect(inspector.locator('dl')).toContainText('https://legacy.example/');
  await expect(inspector.locator('dl')).toContainText('legacy rss');
  await expect(inspector.getByRole('button', { name: 'resync' })).toHaveCount(0);
  // in blogroll
  const blogroll = inspector.getByRole('checkbox', { name: /in blogroll/ });
  await expect(blogroll).not.toBeChecked();
  await blogroll.check();
  await expect(page.locator('.toast')).toHaveText('added to blogroll');
  await expect.poll(async () => (await api(page, 'GET', '/subscriptions/parity-rss')).json.inBlogroll).toBe(true);
  await expect(page.locator('.list-h').last()).toContainText('1 in blogroll');
  await blogroll.uncheck();
  await expect.poll(async () => (await api(page, 'GET', '/subscriptions/parity-rss')).json.inBlogroll).toBe(false);
  // pause, then resume
  await inspector.getByRole('button', { name: 'pause', exact: true }).click();
  await expect(inspector).toHaveCount(0);
  await expect(row.locator('.fs')).toHaveText('paused');
  await expect(row).toHaveClass(/paused/);
  await row.getByRole('link').click();
  await expect(page.getByRole('note')).toContainText('Paused — not polled until you resume it.');
  await page.getByRole('button', { name: 'about this source', exact: true }).click();
  await page.getByRole('dialog', { name: 'Legacy source' }).getByRole('button', { name: 'resume', exact: true }).click();
  await expect(page.getByRole('note')).toHaveCount(0);
  expect((await api(page, 'GET', '/subscriptions/parity-rss')).json.status).not.toBe('paused');
  // delete asks first; cancelling deletes nothing
  await page.getByRole('group', { name: 'reading view' }).getByRole('button', { name: 'Sources', exact: true }).click();
  await inspect();
  const deletes: string[] = [];
  await page.route('**/api/subscriptions/parity-rss', route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deletes.push(route.request().url());
    return route.fulfill({ json: { ok: true } });
  });
  await inspector.getByRole('button', { name: 'delete', exact: true }).click();
  await answerSheet(page, { name: 'Delete this subscription and its local imports, hopper memberships, and signals?', accept: false });
  expect(deletes).toEqual([]);
  await inspect();
  await inspector.getByRole('button', { name: 'delete', exact: true }).click();
  await answerSheet(page, { name: 'Delete this subscription and its local imports, hopper memberships, and signals?' });
  await expect.poll(() => deletes.length).toBe(1);
  await page.unroute('**/api/subscriptions/parity-rss');
});

test('a hopper reads as a timeline from the sources list', async ({ page }) => {
  await login(page); await page.goto('/studio/reading?view=sources');
  await page.getByRole('list', { name: 'hoppers' }).getByRole('link', { name: /Frozen hopper/ }).click();
  await expect(page).toHaveURL(/\/reading\?hopper=parity-hopper&offset=0$/);
  await expect(page.getByRole('heading', { name: /^Frozen hopper/ })).toContainText(/\d+ items/);
  const entry = page.locator('.reading-entry').filter({ hasText: 'Frozen quote from a prior version.' });
  await expect(entry).toBeVisible();
  await expect(entry.locator('.byline')).toContainText('Native source');
  await expect(entry.getByRole('button', { name: 'stub ↗', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'manage', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/hoppers\/parity-hopper$/);
  await expect(page.getByRole('heading', { name: 'Frozen hopper', exact: true })).toBeVisible();
});

test("an entry's ⋯ sheet copies, shares, opens, forks and shows history", async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    const w = window as unknown as { shared: unknown[]; opened: unknown[] };
    w.shared = []; w.opened = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: unknown) => { w.shared.push(data); } });
    window.open = ((...args: unknown[]) => { w.opened.push(args); return null; }) as typeof window.open;
  });
  await login(page); await page.goto('/studio/reading?sub=parity-native');
  const entry = nativeEntry(page);
  let menu = await entryMenu(page, entry);
  await menu.getByRole('button', { name: 'copy [[id]]', exact: true }).click();
  await expect(page.locator('.toast')).toHaveText('copied');
  // The long form (#70), labelled with the text the link would show.
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`^\\[\\[${NATIVE} \\| .+\\]\\]$`));
  menu = await entryMenu(page, entry);
  await menu.getByRole('button', { name: 'copy url', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://source.example/native');
  menu = await entryMenu(page, entry);
  await menu.getByRole('button', { name: 'share…', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { shared: unknown[] }).shared)).toEqual([
    { title: 'Native title', text: expect.stringContaining('Frozen source text.'), url: 'https://source.example/native' },
  ]);
  menu = await entryMenu(page, entry);
  await menu.getByRole('button', { name: /source\.example.*↗/ }).click();
  expect(await page.evaluate(() => (window as unknown as { opened: unknown[] }).opened)).toEqual([['https://source.example/native', '_blank', 'noreferrer']]);
  // history opens under the entry and the same row closes it
  await page.route(`**/api/imports/parity-native/${NATIVE}/history`, route => route.fulfill({ json: { current: 1, withdrawn: false, changelog: [{ version: 1, at: '2026-09-01T00:00:00Z', note: 'First words.', pinned: false, generated: false }] } }));
  menu = await entryMenu(page, entry);
  await menu.getByRole('button', { name: 'history', exact: true }).click();
  await expect(entry.locator('.entry-history')).toContainText('First words.');
  menu = await entryMenu(page, entry);
  await menu.getByRole('button', { name: 'hide history', exact: true }).click();
  await expect(entry.locator('.entry-history')).toHaveCount(0);
  // fork opens the picker for this item
  menu = await entryMenu(page, entry);
  await menu.getByRole('button', { name: 'fork', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/studio/fork\\?id=${NATIVE}&sub=parity-native$`));
});

test('+ add to hopper… offers the hoppers and a new one, and adds the entry', async ({ page }) => {
  await login(page); await page.goto('/studio/reading?sub=parity-native');
  const entry = nativeEntry(page);
  const name = `Sheet hopper ${test.info().project.name} ${Date.now()}`;
  await entry.getByRole('button', { name: 'add to hopper', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '+ add to hopper…' });
  await expect(sheet.getByRole('button', { name: 'Frozen hopper', exact: true })).toBeVisible();
  await expect(sheet.getByRole('button').last()).toHaveText(/new hopper…/);
  await sheet.getByRole('button', { name: 'new hopper…', exact: true }).click();
  await answerSheet(page, { name: 'Name the new hopper:', text: name });
  await expect(page.locator('.toast')).toHaveText(`added to ${name}`);
  const hopper = (await api(page, 'GET', '/hoppers?limit=100')).json.items.find((h: { name: string }) => h.name === name);
  expect((await api(page, 'GET', `/hoppers/${hopper.id}`)).json.memberships).toEqual([expect.objectContaining({ subscriptionId: 'parity-native', remoteId: NATIVE })]);
  // The new hopper is offered next time; choosing it again is harmless.
  await entry.getByRole('button', { name: 'add to hopper', exact: true }).click();
  await sheet.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.toast')).toHaveText(`added to ${name}`);
  await api(page, 'DELETE', `/hoppers/${hopper.id}`);
});

test('a stub opens quoting the whole post, explains itself until dismissed, and quotes a passage selected in the preview', async ({ page }) => {
  await login(page); await page.goto('/studio/reading?sub=parity-native');
  // Select-to-quote left the reading view (session 37): selecting text offers nothing.
  await nativeEntry(page).locator('.content').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await expect(page.locator('.quote-pill')).toHaveCount(0);
  const stubOnce = async () => {
    await page.goto('/studio/reading?sub=parity-native');
    await nativeEntry(page).getByRole('button', { name: 'stub ↗', exact: true }).click();
    await expect(page).toHaveURL(/\/edit\//);
  };
  await stubOnce();
  await expect(page.locator('#md-input')).toHaveValue(`![[${NATIVE}]]\n\n`);
  const help = page.getByRole('dialog', { name: 'How stubs work' });
  await expect(help).toContainText('quote post');
  await expect(help).toContainText('inline reply');
  await help.getByRole('checkbox', { name: /show this again/ }).check();
  await help.getByRole('button', { name: 'got it', exact: true }).click();
  await expect(help).toHaveCount(0);
  await expect(page.locator('.stub-hint')).toContainText('Quoting the whole post');

  // The passage is chosen in the editor's own preview; there is no second copy of the post.
  await expect(page.locator('.stub-chooser, .stub-post')).toHaveCount(0);
  await page.getByRole('button', { name: 'select a passage in the preview', exact: true }).click();
  // Top-level quotes only: the source post itself quotes another.
  const post = page.locator('#preview-body blockquote.blyg-transclusion:not(blockquote.blyg-transclusion blockquote.blyg-transclusion)');
  await expect(post).toContainText('Frozen');
  const pill = page.getByRole('button', { name: '❝ quote only this', exact: true });
  await expect(pill).toHaveCount(0);
  const select = (word: string) => post.last().evaluate((node, word) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !text.textContent!.includes(word)) text = walker.nextNode();
    const at = text!.textContent!.indexOf(word);
    const range = document.createRange(); range.setStart(text!, at); range.setEnd(text!, at + word.length);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  }, word);
  await select('Frozen');
  await pill.click();
  await expect(page.locator('#md-input')).toHaveValue(`![[${NATIVE}]]\n> Frozen\n\n`);
  await expect(page.locator('.stub-hint')).toContainText('Quoting a passage');
  await expect(page.locator('#preview-body .blyg-partial')).toContainText('Frozen');

  // A second passage is its own quote after the cursor, not over the first: a running commentary.
  await page.locator('#md-input').fill(`![[${NATIVE}]]\n> Frozen\n\nMy point.`);
  await page.locator('#md-input').evaluate((el: HTMLTextAreaElement) => { el.selectionStart = el.selectionEnd = el.value.length; });
  await page.getByRole('button', { name: 'quote another passage', exact: true }).click();
  await expect(page.locator('#md-input')).toHaveValue(`![[${NATIVE}]]\n> Frozen\n\nMy point.\n\n![[${NATIVE}]]\n\n`);
  await expect(post).toHaveCount(2);
  await expect(post.last()).toContainText('source text');
  await select('source text');
  await pill.click();
  await expect(page.locator('#md-input')).toHaveValue(`![[${NATIVE}]]\n> Frozen\n\nMy point.\n\n![[${NATIVE}]]\n> source text\n\n`);
  await expect(page.locator('.stub-hint')).toContainText('Quoting 2 passages');
  await expect(page.getByRole('button', { name: 'quote whole post', exact: true })).toHaveCount(0);
  await expect(page.locator('#preview-body .blyg-partial')).toHaveCount(2);

  await page.locator('#md-input').fill(`![[${NATIVE}]]\n> Frozen\n\n`);
  await page.getByRole('button', { name: 'quote whole post', exact: true }).click();
  await expect(page.locator('#md-input')).toHaveValue(`![[${NATIVE}]]\n\n`);

  // Dismissed on this device: the next stub opens without it, and the link brings it back.
  await stubOnce();
  await expect(page.locator('.stub-hint')).toBeVisible();
  await expect(help).toHaveCount(0);
  await page.getByRole('button', { name: 'how stubs work', exact: true }).click();
  await expect(help).toBeVisible();
});

test('the swipe hint is for touch: shown with a finger, hidden with a mouse', async ({ page }) => {
  await login(page); await page.goto('/studio/reading?view=sources');
  await expect(page.locator('.feed').first()).toBeVisible();
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  const hint = page.getByText('Swipe a source ← for its info');
  if (coarse) await expect(hint).toBeVisible(); else await expect(hint).toBeHidden();
});

test('swipes: a source ← opens its inspector, an entry → thumbs it, and the next tap still lands', async ({ page }) => {
  await login(page); await page.goto('/studio/reading?view=sources');
  const native = page.locator('.feed[data-id="parity-native"]');
  const legacy = page.locator('.feed[data-id="parity-rss"]');
  // Hopper rows above fill in their counts asynchronously; let the list settle.
  for (const count of await page.getByRole('list', { name: 'hoppers' }).locator('.fn').all()) await expect(count).not.toHaveText('');
  // ← on a source: its inspector; a short drag does nothing.
  await swipe(page, native.getByRole('link'), -40);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/\/studio\/reading\?view=sources$/);
  await swipe(page, native.getByRole('link'), -140);
  await expect(page.getByRole('dialog', { name: 'Native source' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.backdrop')).toHaveCount(0);
  // → on a source pauses it; the release does not open the source under it…
  await swipe(page, legacy.getByRole('link'), 140);
  await expect(legacy.locator('.fs')).toHaveText('paused');
  await expect(page).toHaveURL(/\/studio\/reading\?view=sources$/);
  // …but a tap on another row right after the swipe goes through.
  await native.getByRole('link').click();
  await expect(page).toHaveURL(/sub=parity-native/);
  await api(page, 'PATCH', '/subscriptions/parity-rss', { paused: false });
  // → on an entry (from its byline, with a mouse) toggles 👍; the button agrees.
  const entry = nativeEntry(page);
  const up = entry.getByRole('button', { name: 'thumbs up', exact: true });
  await expect(up).toHaveAttribute('aria-pressed', 'false');
  await swipe(page, entry.locator('.byline'), 140);
  await expect(up).toHaveAttribute('aria-pressed', 'true');
  // A mouse drag across the text is a selection, not a swipe.
  await swipe(page, entry.locator('.content'), -140);
  await expect(page).toHaveURL(/sub=parity-native/);
  // A click on the swiped row itself is swallowed for 250 ms after the swipe.
  await page.waitForTimeout(300);
  await up.click();
  await expect(up).toHaveAttribute('aria-pressed', 'false');
  // ← on an entry is stub ↗.
  const created = page.waitForResponse(response => response.url().endsWith('/api/items') && response.request().method() === 'POST');
  await swipe(page, entry.locator('.byline'), -140);
  expect((await created).request().postDataJSON()).toEqual({ mode: 'response', source: { subscriptionId: 'parity-native', remoteId: NATIVE } });
  await expect(page).toHaveURL(/\/edit\//);
});
