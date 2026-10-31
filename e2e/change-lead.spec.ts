import { test, expect, type Page } from './fixture';

// A revised post in the feed leads with its latest changelog entry (0.49.0):
// "V3: note", or "V3: No changelog entry available" when the origin gave none.
// The fixtures are all version 1, so the feed response is patched to v3 and the
// history route (read from the origin on demand) is stubbed.
const NATIVE = '00000000000000000000000001';
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const card = (page: Page) => page.locator('.reading-entry').filter({ hasText: 'Native title' });

async function feedAtVersion(page: Page, version: number) {
  await page.route('**/api/reading?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const item of body.items) if (item.imported?.remoteId === NATIVE) item.imported.version = version;
    await route.fulfill({ response, json: body });
  });
}

test('a revised post leads with its latest changelog entry', async ({ page }) => {
  await login(page);
  await feedAtVersion(page, 3);
  await page.route(`**/api/imports/parity-native/${NATIVE}/history`, (route) =>
    route.fulfill({ json: { current: 3, withdrawn: false, changelog: [
      { version: 1, at: 'a', note: null, pinned: false, generated: false },
      { version: 2, at: 'b', note: 'Older edit.', pinned: false, generated: false },
      { version: 3, at: 'c', note: 'Tightened the claim.', pinned: false, generated: false },
    ] } }),
  );
  await page.goto('/studio/reading?sub=parity-native');
  const lead = card(page).locator('[data-change-lead]');
  await expect(lead).toHaveText('V3: Tightened the claim.');
  // It leads: the line comes before the body.
  const order = await card(page).evaluate((el) => {
    const lead = el.querySelector('[data-change-lead]')!, body = el.querySelector('.entry-body')!;
    return !!(lead.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
});

test('with no changelog entry for that version it says so', async ({ page }) => {
  await login(page);
  await feedAtVersion(page, 2);
  await page.route(`**/api/imports/parity-native/${NATIVE}/history`, (route) =>
    route.fulfill({ json: { current: 2, withdrawn: false, changelog: [{ version: 2, at: 'b', note: '  ', pinned: false, generated: false }] } }),
  );
  await page.goto('/studio/reading?sub=parity-native');
  await expect(card(page).locator('[data-change-lead]')).toHaveText('V2: No changelog entry available');
});

test('an unreachable origin says the same, and a first version gets no line', async ({ page }) => {
  await login(page);
  await feedAtVersion(page, 4);
  await page.route(`**/api/imports/parity-native/${NATIVE}/history`, (route) => route.fulfill({ status: 502, json: { code: 'bad-gateway', message: 'could not reach the origin' } }));
  await page.goto('/studio/reading?sub=parity-native');
  await expect(card(page).locator('[data-change-lead]')).toHaveText('V4: No changelog entry available');
  await page.unroute('**/api/reading?*');
  await page.goto('/studio/reading?sub=parity-native');
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('[data-change-lead]')).toHaveCount(0);
});
