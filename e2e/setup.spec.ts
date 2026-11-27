import { test, expect } from './fixture.ts';
import { CLIENT } from '../src/client.ts';
import { HIGHLIGHTS } from '../src/ui/whats-new.ts';

// The setup wizard (session 46): reachable from Settings, one step at a time,
// each setting beside its default, nothing written until the last step.
// In-page, so the owner cookie (Secure) rides along; page.request would go unauthenticated.
const stored = (page: import('./fixture.ts').Page) =>
  page.evaluate(async () => (await fetch('/api/settings')).json() as Promise<Record<string, unknown>>);

test('the setup wizard walks every step and saves only what changed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  // Both projects share one database; start each from the fresh-install state.
  expect(await page.evaluate(async () => (await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ feedOrder: 'pace-layered', defaultVisibility: 'public', readerMarkRead: 'seen', setup: 'pending' }) })).status)).toBe(200);
  // The Read step opens Discover on arrival (session 82); blygger.com is answered here.
  await page.route('https://blygger.com/blygs.json', (route) => route.fulfill({ json: { version: 1, blygs: [
    { origin: 'https://ada.example/', title: 'Ada writes', home: 'https://ada.example/', feed: null, listedAt: '2026-11-01T00:00:00.000Z',
      generator: 'blygger-studio/0.71.0', generatorUrl: 'https://github.com/blygger/blygger-studio', author: { name: 'Ada Lovelace', url: 'https://ada.example/about' },
      activity: { level: 'high', score: 4, events: 5, lastPost: '2026-11-20T00:00:00.000Z' } },
  ] }, headers: { 'access-control-allow-origin': '*' } }));

  await page.goto('/studio/settings');
  await expect(page.locator('#setup-banner')).toBeVisible();
  await page.locator('#run-setup').click();
  await expect(page.locator('#setup [data-step="identity"]')).toBeVisible();
  const title = `Setup walk ${test.info().project.name}`;
  await page.locator('#setup-siteTitle').fill(title);
  await expect(page.locator('[data-setting="siteTitle"] .setup-meta')).toContainText('was');

  // Mode: Publish mode is the default, Notebook mode the private one.
  await page.locator('#setup-next').click();
  await expect(page.locator('[data-step="mode"]')).toContainText('Publish mode');
  await expect(page.getByRole('radio', { name: /Publish mode/ })).toBeChecked();
  await page.getByRole('radio', { name: /Notebook mode/ }).check();
  await expect(page.locator('[data-reset="defaultVisibility"]')).toContainText('Publish mode');

  // Look, then the home page order, which says which one is recommended.
  await page.locator('#setup-next').click();
  await expect(page.locator('[data-step="look"]')).toBeVisible();
  await page.locator('#setup-next').click();
  await expect(page.locator('[data-step="home"]')).toContainText('Pace-layered (recommended)');
  await page.getByRole('radio', { name: /Newest first/ }).check();
  await expect(page.locator('[data-reset="feedOrder"]')).toBeVisible();
  await page.locator('[data-reset="feedOrder"]').click();
  await expect(page.getByRole('radio', { name: /Pace-layered/ })).toBeChecked();
  await page.getByRole('radio', { name: /Newest first/ }).check();

  // Reading: the reader's own choices.
  await page.locator('#setup-next').click();
  await expect(page.locator('[data-step="reading"]')).toBeVisible();
  await page.getByRole('radio', { name: /When I open it/ }).check();

  await page.locator('#setup-next').click();
  await expect(page.locator('[data-step="writing"]')).toBeVisible();
  await page.locator('#setup-next').click();
  await expect(page.locator('[data-setting="hopperFeeds"]')).toBeVisible();
  await page.locator('#setup-next').click();
  const review = page.locator('#setup-review');
  await expect(review.locator('[data-setting="siteTitle"]')).toContainText(title);
  await expect(review.locator('[data-setting="feedOrder"]')).toContainText('Newest first');
  await expect(review.locator('[data-setting="defaultVisibility"]')).toContainText('Default for new items: Publish mode → Notebook mode');
  await expect(review.locator('[data-setting="readerMarkRead"]')).toContainText('When I open it');
  // Nothing is stored before the last step.
  const before = await stored(page);
  expect(before.setup).toBeDefined();
  expect(before.siteTitle).not.toBe(title);

  await page.locator('#setup-finish').click();
  await expect(page.locator('#setup-done')).toBeVisible();
  const saved = await stored(page);
  expect(saved).toMatchObject({ siteTitle: title, feedOrder: 'reverse-chronological', defaultVisibility: 'private', readerMarkRead: 'opened', setup: 'done' });
  // Read: Discover opens by itself, with who writes each blyg and its client.
  const discover = page.getByRole('dialog', { name: 'discover blygs' });
  await expect(discover).toBeVisible();
  await expect(discover.locator('.discover-about')).toContainText('by Ada Lovelace · client blygger-studio/0.71.0');
  await expect(discover.getByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute('href', 'https://ada.example/about');
  await page.keyboard.press('Escape');
  await expect(page.locator('#setup-done [data-step="read"]')).toBeVisible();
  await page.locator('#setup-discover').click();
  await expect(discover).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/studio/settings');
  await expect(page.locator('#setup-banner')).toHaveCount(0);
  // Back to Publish mode and the default read marking, for the specs that follow.
  expect(await page.evaluate(async () => (await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultVisibility: 'public', readerMarkRead: 'seen' }) })).status)).toBe(200);
  expect(errors).toEqual([]);
});

// What's new (session 82): after an upgrade, the banner names the release's
// highlights once, and the walk covers only the steps with new settings.
test.describe('what is new', () => {
  // The suite shares one node: put back what this test changes even when it fails, or
  // Notebook mode leaks into every later spec (0.72.1's e2e run: 46 failures after this one).
  test.afterEach(async ({ page }) => {
    await page.evaluate(async (version) => { await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupSeenVersion: version, defaultVisibility: 'public' }) }); }, CLIENT.version);
  });

  test('after an upgrade, what is new is offered once and walks only the new steps', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/studio/login');
    await page.locator('[name="password"]').fill('test-password');
    await page.getByRole('button', { name: 'log in', exact: true }).click();
    await expect(page.locator('#composer-text')).toBeVisible();
    const patch = (body: unknown) => page.evaluate(async (body) => (await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, body);
    // A node that finished setup before 0.72.0, as migration 0060 leaves it.
    expect(await patch({ setup: 'done', setupSeenVersion: '0.71.0', defaultVisibility: 'public' })).toBe(200);
    await page.route('https://blygger.com/blygs.json', (route) => route.fulfill({ json: { version: 1, blygs: [] }, headers: { 'access-control-allow-origin': '*' } }));

    await page.goto('/studio/settings');
    const banner = page.locator('#whats-new-banner');
    // The banner and the walk are headed by the newest release with highlights; 0.72.0's are listed below it.
    await expect(banner).toContainText(`New in ${HIGHLIGHTS[0].version}`);
    await expect(banner).toContainText('Notebook mode');
    await page.locator('#whats-new-review').click();
    await expect(page.locator('#setup h2')).toContainText(`What’s new in ${HIGHLIGHTS[0].version}`);
    // You and Home page have nothing new, so they are not walked.
    const steps = page.locator('.setup-steps li');
    await expect(steps).toHaveText(['1. Mode', '2. Look', '3. Reading', '4. Writing and AI', '5. Others', '6. Review', '7. Read']);
    await expect(page.locator('[data-setting="defaultVisibility"] .setup-new')).toBeVisible();
    await page.getByRole('radio', { name: /Notebook mode/ }).check();
    for (let i = 0; i < 5; i++) await page.locator('#setup-next').click();
    await expect(page.locator('#setup-review [data-setting="defaultVisibility"]')).toContainText('Notebook mode');
    await page.locator('#setup-finish').click();
    await expect(page.getByRole('dialog', { name: 'discover blygs' })).toBeVisible();
    await page.keyboard.press('Escape');
    // The saved marker does not turn the walk back into the whole one under Read.
    await expect(page.locator('#setup-done .setup-steps li')).toHaveCount(7);
    await expect(page.locator('#setup-done .setup-steps li[aria-current="step"]')).toHaveText('7. Read');
    const saved = await page.evaluate(async () => (await fetch('/api/settings')).json() as Promise<Record<string, unknown>>);
    expect(saved).toMatchObject({ defaultVisibility: 'private', setupSeenVersion: CLIENT.version });
    // Shown once: the banner is gone now.
    await page.goto('/studio/settings');
    await expect(page.locator('#whats-new-banner')).toHaveCount(0);

    // Dismissing marks it seen too.
    expect(await patch({ setupSeenVersion: '0.71.0', defaultVisibility: 'public' })).toBe(200);
    await page.reload();
    await page.locator('#whats-new-dismiss').click();
    await expect(page.locator('#whats-new-banner')).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(async () => (await (await fetch('/api/settings')).json()).setupSeenVersion))).toBe(CLIENT.version);
    expect(errors).toEqual([]);
  });
});
