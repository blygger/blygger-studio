import { test, expect, type Page } from './fixture';

// Session 36: discarding a draft confirms in a green toast instead of a red
// "not found", and the reading header can resync every feed at once.
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
async function watchAlerts(page: Page) {
  await page.addInitScript(() => {
    new MutationObserver(() => document.querySelectorAll('[role=alert]').forEach((a) => {
      const text = a.textContent;
      if (text) ((window as any).__alerts ??= []).push(text);
    })).observe(document, { subtree: true, childList: true, characterData: true });
  });
}
const alerts = (page: Page) => page.evaluate(() => (window as any).__alerts ?? []);

test('discarding a draft from the compose list says so, with no error', async ({ page }, info) => {
  await watchAlerts(page);
  await login(page);
  const text = `${info.project.name} list discard probe`;
  await page.locator('#composer-text').fill(text);
  // The composer's own button comes first; a draft row left open by another test may have one too.
  await page.getByRole('button', { name: 'save draft' }).first().click();
  await page.getByRole('button', { name: new RegExp(text) }).click();
  await page.getByRole('button', { name: 'discard', exact: true }).first().click();
  await page.getByRole('button', { name: 'discard', exact: true }).last().click();
  const toast = page.getByRole('status').filter({ hasText: 'Draft discarded' });
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute('data-tone', 'ok');
  await expect(page.getByRole('button', { name: new RegExp(text) })).toHaveCount(0);
  // It goes by itself, and the ✕ takes it away sooner.
  await expect(toast).toHaveCount(0, { timeout: 5000 });
  expect(await alerts(page)).toEqual([]);
});

test('discarding from the editor says so too, and ✕ dismisses it', async ({ page }) => {
  await watchAlerts(page);
  await login(page);
  await page.locator('#composer-text').fill('editor discard probe');
  await page.locator('#composer-full').click();
  await expect(page.locator('#md-input')).toBeVisible();
  await page.getByRole('button', { name: 'more actions' }).click();
  await page.getByRole('dialog', { name: 'actions' }).getByRole('button', { name: 'discard draft', exact: true }).click();
  await page.getByRole('button', { name: 'discard draft', exact: true }).last().click();
  const toast = page.getByRole('status').filter({ hasText: 'Draft discarded' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'dismiss message' }).click();
  await expect(toast).toHaveCount(0);
  expect(await alerts(page)).toEqual([]);
});

test('the reading header resyncs every feed at once', async ({ page }) => {
  await login(page);
  await page.goto('/studio/reading');
  let polled = false;
  // Answered here: a real poll would change the shared fixture subscriptions other tests read.
  await page.route('**/api/subscriptions/poll', async (route) => { polled = route.request().method() === 'POST'; await route.fulfill({ json: { polling: 3 } }); });
  await page.getByRole('button', { name: 'resync all feeds' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Checking 3 feeds…' })).toBeVisible();
  expect(polled).toBe(true);
  await expect(page.getByRole('button', { name: 'resync all feeds' })).toBeDisabled();
});

test('the composer counts a thread without the fragment limit', async ({ page }) => {
  await login(page);
  await page.locator('#composer-text').fill('x'.repeat(1200));
  await expect(page.locator('#composer-count')).toHaveText('1200 / 1000');
  await page.getByRole('radio', { name: 'thread', exact: true }).click();
  await expect(page.locator('#composer-count')).toHaveText('1200 chars');
});

test('a draft that only quotes or links shows what it quotes, not "(empty draft)"', async ({ page }, info) => {
  await login(page);
  const words = `${info.project.name} quoted target words`;
  const id = await page.evaluate(async (content_md) => {
    const item = await (await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentMd: content_md }) })).json();
    await fetch(`/api/items/${item.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: item.revision }) });
    return item.id as string;
  }, words);
  for (const [kind, content_md] of [['thread', `![[${id}]]`], ['fragment', `[[${id}]]`]] as const) {
    await page.evaluate(async ([kind, content_md]) => {
      await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, contentMd: content_md }) });
    }, [kind, content_md]);
  }
  await page.reload();
  const rows = page.locator('.item-title').filter({ hasText: words });
  // The published target itself, plus the quoting thread and the linking fragment.
  // Each of the three rows shows the target's words: none reads "(empty draft)".
  await expect(rows).toHaveCount(3);
});
