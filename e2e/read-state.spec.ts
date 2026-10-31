import { test, expect, type Page } from './fixture';
import { answerSheet } from './sheets.ts';

// Read state in the studio (migration 0026): unread dots, select mode
// with mark read / mark unread, mark all read, mark-read-on-open, and rollback
// when a write fails. Both projects share the fixture (e2e-server.ts), so the
// test clears the source's read state first and again at the end.
const NATIVE = '00000000000000000000000001';
const RETAINED = '00000000000000000000000004';
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    { method, path, body },
  );
const clearAll = (page: Page) =>
  api(page, 'POST', '/reading/unread', { items: [NATIVE, RETAINED].map((remote_id) => ({ sub: 'parity-native', remoteId: remote_id })) });
async function serverRead(page: Page) {
  const { json } = await api(page, 'GET', '/reading?sub=parity-native&limit=50');
  expect(json.readStateClear).toBe(true);
  return Object.fromEntries((json.items as { imported: { remoteId: string; readVersion: number | null } }[]).map((e) => [e.imported.remoteId, e.imported.readVersion]));
}
const native = (page: Page) => page.locator('.reading-entry').filter({ hasText: 'Native title' });
const retained = (page: Page) => page.locator('.reading-entry').filter({ hasText: 'Second live text.' });
async function readMenu(page: Page, row: 'select…' | 'mark all read…') {
  await page.getByRole('button', { name: 'read state', exact: true }).click();
  await page.getByRole('dialog', { name: 'read state' }).getByRole('button', { name: row, exact: true }).click();
}

test('select → mark read / mark unread changes the rows and the server', async ({ page }) => {
  await login(page);
  await clearAll(page);
  try {
    await page.goto('/studio/reading?sub=parity-native');
    await expect(page.locator('.reading-entry')).toHaveCount(2);
    for (const entry of [native(page), retained(page)]) {
      await expect(entry).toHaveAttribute('data-read', 'unread');
      await expect(entry.getByRole('img', { name: 'unread' })).toBeVisible();
    }

    await readMenu(page, 'select…');
    const bar = page.getByRole('toolbar', { name: 'selection' });
    await expect(bar).toContainText('0 selected');
    await expect(bar.getByRole('button', { name: 'mark read', exact: true })).toBeDisabled();
    await native(page).getByRole('checkbox').check();
    await retained(page).getByRole('checkbox').check();
    await expect(bar).toContainText('2 selected');
    const batch = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/reading/read'));
    await bar.getByRole('button', { name: 'mark read', exact: true }).click();
    const body = (await batch).postDataJSON();
    expect(body.items).toHaveLength(2);
    // The studio acts online: its reads carry no read_at, so they always apply.
    for (const item of body.items) expect(item).not.toHaveProperty("readAt");
    // Select mode ends; both rows read, dots gone.
    await expect(bar).toHaveCount(0);
    for (const entry of [native(page), retained(page)]) {
      await expect(entry).toHaveAttribute('data-read', 'read');
      await expect(entry.locator('.read-dot')).toHaveCount(0);
    }
    expect(await serverRead(page)).toEqual({ [NATIVE]: 1, [RETAINED]: 1 });

    await readMenu(page, 'select…');
    await native(page).getByRole('checkbox').check();
    const one = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().endsWith(`/api/reading/parity-native/${NATIVE}/read`));
    await page.getByRole('toolbar', { name: 'selection' }).getByRole('button', { name: 'mark unread', exact: true }).click();
    await one;
    await expect(native(page)).toHaveAttribute('data-read', 'unread');
    await expect(retained(page)).toHaveAttribute('data-read', 'read');
    expect(await serverRead(page)).toEqual({ [NATIVE]: null, [RETAINED]: 1 });
  } finally {
    await clearAll(page);
  }
});

test('opening an entry at its origin marks it read with one PUT', async ({ page }) => {
  // Keep the click in the studio: the link's own navigation is not under test.
  await page.addInitScript(() =>
    document.addEventListener('click', (event) => {
      if ((event.target as Element).closest?.('a[target=_blank]')) event.preventDefault();
    }, true),
  );
  await login(page);
  await clearAll(page);
  try {
    await page.goto('/studio/reading?sub=parity-native');
    await expect(native(page)).toHaveAttribute('data-read', 'unread');
    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/api/reading/parity-native/${NATIVE}/read`));
    await native(page).locator('.entry-title a').click();
    const body = (await put).postDataJSON();
    expect(body).toEqual({ version: 1 });
    await expect(native(page)).toHaveAttribute('data-read', 'read');
    await expect(retained(page)).toHaveAttribute('data-read', 'unread');
    expect(await serverRead(page)).toEqual({ [NATIVE]: 1, [RETAINED]: null });
    // Opening a read entry again writes nothing.
    let writes = 0;
    page.on('request', (r) => { if (r.url().includes('/api/reading/') && r.method() !== 'GET') writes++; });
    await native(page).locator('.entry-title a').click();
    await page.waitForTimeout(300);
    expect(writes).toBe(0);
  } finally {
    await clearAll(page);
  }
});

test('mark all read covers the whole view after a confirm sheet', async ({ page }) => {
  await login(page);
  await clearAll(page);
  try {
    await page.goto('/studio/reading?sub=parity-native');
    await expect(native(page)).toHaveAttribute('data-read', 'unread');
    await readMenu(page, 'mark all read…');
    await answerSheet(page, { name: 'Mark 2 items read?' });
    await expect(page.locator('.toast')).toHaveText('marked 2 read');
    await expect(native(page)).toHaveAttribute('data-read', 'read');
    await expect(retained(page)).toHaveAttribute('data-read', 'read');
    expect(await serverRead(page)).toEqual({ [NATIVE]: 1, [RETAINED]: 1 });
    await readMenu(page, 'mark all read…');
    await expect(page.locator('.toast')).toHaveText('nothing unread here');
  } finally {
    await clearAll(page);
  }
});

test('a failed write rolls the rows back and says so', async ({ page }) => {
  await login(page);
  await clearAll(page);
  try {
    await page.goto('/studio/reading?sub=parity-native');
    await expect(native(page)).toHaveAttribute('data-read', 'unread');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/reading/read', async (route) => {
      await held;
      await route.fulfill({ status: 503, json: { code: 'internal', message: 'read state write failed' } });
    });
    await readMenu(page, 'select…');
    await native(page).getByRole('checkbox').check();
    await retained(page).getByRole('checkbox').check();
    await page.getByRole('toolbar', { name: 'selection' }).getByRole('button', { name: 'mark read', exact: true }).click();
    // Optimistic first...
    await expect(native(page)).toHaveAttribute('data-read', 'read');
    release();
    // ...then rolled back, with the error shown.
    await expect(native(page)).toHaveAttribute('data-read', 'unread');
    await expect(retained(page)).toHaveAttribute('data-read', 'unread');
    await expect(page.getByRole('alert')).toContainText('read state write failed');
    await page.unroute('**/api/reading/read');
    expect(await serverRead(page)).toEqual({ [NATIVE]: null, [RETAINED]: null });
  } finally {
    await clearAll(page);
  }
});

test('own items carry no read state and "my blyg" offers no read controls', async ({ page }) => {
  await login(page);
  await page.goto('/studio/reading?sub=own');
  await expect(page.getByRole('heading', { name: /^my blyg/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'read state', exact: true })).toHaveCount(0);
  await expect(page.locator('.reading-entry[data-read]')).toHaveCount(0);
});
