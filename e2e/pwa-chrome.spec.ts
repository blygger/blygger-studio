import { test, expect, type Page } from './fixture';
import { expandRow } from './editor.ts';
import { answerSheet } from './sheets.ts';
async function login(page: Page) {
  await page.goto('/studio/login'); await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const setTheme = (page: Page, theme: string) => page.evaluate(async theme => {
  const r = await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme }) });
  if (!r.ok) throw new Error('cannot set theme');
}, theme);
const cssVar = (page: Page, name: string) => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);

test('the studio wears the reading theme from settings, and repaints when it changes', async ({ page }) => {
  await login(page);
  try {
    await setTheme(page, 'nord');
    await page.reload();
    await expect.poll(() => cssVar(page, '--pencil')).toBe('#88c0d0');
    expect(await cssVar(page, '--card')).toBe('#2e3440');
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark');
    await expect(page.locator('meta[name=theme-color]')).toHaveAttribute('content', '#88c0d0');
    // The top bar wears the accent.
    expect(await page.locator('.topbar').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(136, 192, 208)');

    // The last theme is remembered, so the next launch paints it before settings arrive.
    await page.route('**/api/settings', () => {});
    await page.reload();
    await expect.poll(() => cssVar(page, '--pencil')).toBe('#88c0d0');
    await page.unroute('**/api/settings');
    await page.reload();

    // Changing it in settings repaints the studio without a reload.
    await page.goto('/studio/settings');
    await page.locator('.theme-opt').filter({ hasText: 'Cream' }).click();
    await page.getByRole('button', { name: 'save settings', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('saved');
    await expect.poll(() => cssVar(page, '--pencil')).toBe('#8a5a2b');
    expect(await cssVar(page, '--page')).toBe('#e9e2d2');

    // Slate: a light sheet on a dark page — text on the page must use the sheet colour.
    await setTheme(page, 'slate'); await page.reload();
    await expect.poll(() => cssVar(page, '--page-ink')).toBe('#f5f7f7');
    expect(await cssVar(page, '--ink')).toBe('#1b2426');

    // auto removes every inline token and the stylesheet decides again.
    await setTheme(page, 'auto'); await page.reload();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('auto');
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--pencil'))).toBe('');
    expect(await cssVar(page, '--pencil')).toBe('#23608c');
  } finally {
    await page.unroute('**/api/settings');
    await setTheme(page, 'auto');
  }
});

test('a confirm sheet cancels, dismisses with Escape, and resolves on accept', async ({ page }) => {
  await login(page);
  const marker = `Sheet fixture ${test.info().project.name} ${Date.now()}`;
  const id = await page.evaluate(async marker => (await (await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentMd: marker }) })).json()).id as string, marker);
  await page.reload();
  const row = await expandRow(page, id);
  const exists = () => page.evaluate(async id => (await fetch(`/api/items/${id}`)).status, id);
  await row.getByRole('button', { name: 'discard', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Discard this unpublished draft?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'discard', exact: true })).toBeFocused();
  await answerSheet(page, { name: 'Discard this unpublished draft?', accept: false });
  expect(await exists()).toBe(200);
  await row.getByRole('button', { name: 'discard', exact: true }).click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(await exists()).toBe(200);
  await row.getByRole('button', { name: 'discard', exact: true }).click();
  await answerSheet(page, { name: 'Discard this unpublished draft?' });
  await expect(row).toHaveCount(0);
  await expect.poll(exists).toBe(404);
});

test('a prompt sheet returns typed text and creates nothing when cancelled', async ({ page }) => {
  await login(page); await page.goto('/studio/reading?sub=parity-native');
  const hoppers = () => page.evaluate(async () => (await (await fetch('/api/hoppers')).json() as { items?: { name: string }[] } | { name: string }[]));
  const names = async () => { const body = await hoppers(); return (Array.isArray(body) ? body : body.items ?? []).map(h => h.name); };
  const name = `Prompted hopper ${test.info().project.name} ${Date.now()}`;
  const entry = page.locator('.reading-entry').filter({ hasText: 'Native title' });
  const newHopper = async () => {
    await entry.getByRole('button', { name: 'add to hopper', exact: true }).click();
    await page.getByRole('dialog', { name: '+ add to hopper…' }).getByRole('button', { name: 'new hopper…', exact: true }).click();
  };
  await newHopper();
  await answerSheet(page, { name: 'Name the new hopper:', accept: false });
  expect(await names()).not.toContain(name);
  await newHopper();
  await answerSheet(page, { name: 'Name the new hopper:', text: name });
  await expect.poll(names).toContain(name);
});

test('the alert that became a toast says what to do and goes away', async ({ page }) => {
  await login(page); await page.locator('#composer-text').fill('Toast fixture');
  await page.locator('#composer-full').click();
  await page.locator('#md-input').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
  await page.locator('#tk-impyrt-btn').click();
  const toast = page.locator('.toast');
  await expect(toast).toHaveText('Select the pasted generated text first, then mark it.');
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(page.locator('#md-input')).toHaveValue('Toast fixture');
  await expect(toast).toHaveCount(0, { timeout: 5000 });
});

test('the web app manifest and service worker are served under the studio mount', async ({ page }) => {
  for (const [origin, base] of [['http://127.0.0.1:8787', '/studio'], ['http://127.0.0.1:8789', '/notes/b/studio']] as const) {
    const manifest = await page.request.get(`${origin}${base}/manifest.webmanifest`);
    expect(manifest.status()).toBe(200);
    expect(manifest.headers()['content-type']).toContain('application/manifest+json');
    const body = await manifest.json();
    expect(body).toMatchObject({ scope: base, start_url: base, id: base, display: 'standalone' });
    for (const icon of body.icons) expect((await page.request.get(`${origin}${icon.src}`)).status()).toBe(200);
    const sw = await page.request.get(`${origin}${base}/sw.js`);
    expect(sw.status()).toBe(200);
    expect(sw.headers()['content-type']).toContain('javascript');
    expect(sw.headers()['service-worker-allowed']).toBe(base);
    const source = await sw.text();
    expect(source).toContain(JSON.stringify([`${base}/app.js`, `${base}/app.css`, `${base}/icon.svg`]));
  }
  await login(page);
  await expect(page.locator('link[rel=manifest]')).toHaveAttribute('href', '/studio/manifest.webmanifest');
  await expect(page.locator('link[rel=apple-touch-icon]')).toHaveAttribute('href', '/studio/icon-180.png');
  await expect(page.locator('meta[name=theme-color]')).toHaveCount(1);
});

test.describe('with service workers allowed', () => {
  test.use({ serviceWorkers: 'allow' });
  test('the service worker registers at the studio scope and caches only shell assets', async ({ page }) => {
    await login(page);
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(new URL(scope).pathname).toBe('/studio');
    // Owner reads after the worker is in control.
    await page.reload();
    await expect(page.locator('#composer-text')).toBeVisible();
    await page.evaluate(async () => { await fetch('/api/items'); await fetch('/api/settings'); });
    await expect.poll(() => page.evaluate(async () => {
      const paths: string[] = [];
      for (const key of await caches.keys()) for (const request of await (await caches.open(key)).keys()) paths.push(new URL(request.url).pathname);
      return paths.sort();
    })).toEqual(['/studio/app.css', '/studio/app.js', '/studio/icon.svg']);
    // The login page still works under the worker.
    await page.goto('/studio/login');
    await expect(page).toHaveURL(/\/studio$/);
    await expect(page.locator('#composer-text')).toBeVisible();
  });
});
