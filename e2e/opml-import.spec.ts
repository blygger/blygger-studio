import { test, expect, type Page } from './fixture';

// OPML import (studio#63): the file is parsed in the browser, the preview marks
// what is already subscribed, and each feed is one createSubscription with
// backfill: false, sent one at a time. The POSTs are answered here, because a
// real subscribe would reach the network and change the shared fixture
// subscriptions other tests read; the server side of `backfill` is covered by
// test/importer/subscribe-backfill.test.ts.
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}

// Real-world untidiness on purpose: nested folders, a feed with no type, a
// folder outline with no xmlUrl, a double-escaped title, an HTML entity XML does
// not define and a bare & in a URL (both repaired), and the fixture's own
// legacy feed, which is already subscribed.
const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Exported</title></head>
  <body>
    <outline text="News">
      <outline type="rss" text="Alpha &amp;amp; Co" xmlUrl="https://alpha.example/feed.xml"/>
      <outline text="Deeper">
        <outline text="Caf&eacute; notes" xmlUrl="https://beta.example/rss?a=1&b=2"/>
      </outline>
    </outline>
    <outline type="rss" text="Legacy again" xmlUrl="https://legacy.example/feed"/>
    <outline type="rss" text="Gamma" xmlUrl="https://gamma.example/feed"/>
    <outline type="rss" text="Delta" xmlUrl="https://delta.example/feed"/>
  </body>
</opml>`;

const subscription = (url: string) => ({
  id: `sub-${new URL(url).hostname}`, kind: 'rss', origin: url, feedUrl: url, title: new URL(url).hostname, status: 'active',
  lastPollAt: null, failCount: 0, lastIndexSyncAt: null, created: '2026-10-18T00:00:00Z',
  titleFollowsSource: true, inBlogroll: false, flags: [],
});

test('an OPML file is previewed, imported one feed at a time, and summarised', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await page.goto('/studio/reading?view=sources');

  const posts: { url: string; backfill: unknown; confirm: unknown; at: number }[] = [];
  let inFlight = 0, overlapped = false, gammaTries = 0;
  const patches: string[] = [];
  await page.route('**/api/subscriptions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as { url: string; backfill: unknown; confirm: unknown };
    posts.push({ ...body, at: Date.now() });
    if (inFlight++) overlapped = true;
    try {
      const host = new URL(body.url).hostname;
      if (host === 'alpha.example' || host === 'beta.example') return await route.fulfill({ status: 201, json: subscription(body.url) });
      if (host === 'gamma.example' && gammaTries++ === 0) return await route.fulfill({ status: 429, headers: { 'Retry-After': '1' }, json: { code: 'rate-limit', message: 'API work budget exceeded' } });
      if (host === 'gamma.example') return await route.fulfill({ status: 409, json: { code: 'conflict', message: 'already subscribed to Gamma' } });
      return await route.fulfill({ status: 422, json: { code: 'unprocessable', message: 'could not resolve this URL to a blyg or a feed', details: { tried: [body.url] } } });
    } finally {
      inFlight--;
    }
  });
  await page.route('**/api/subscriptions/sub-*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    patches.push(route.request().url());
    await route.fulfill({ json: { ...subscription('https://x.example/'), inBlogroll: true } });
  });

  await page.locator('#opml-open').click();
  const sheet = page.getByRole('dialog', { name: 'import OPML' });
  await sheet.locator('#opml-file').setInputFiles({ name: 'feeds.opml', mimeType: 'text/x-opml', buffer: Buffer.from(OPML) });

  const list = sheet.getByRole('list', { name: 'feeds in the file' });
  await expect(list.locator('.opml-row')).toHaveCount(5);
  await expect(list.locator('.opml-title')).toHaveText(['Alpha & Co', 'Café notes', 'Legacy again', 'Gamma', 'Delta']);
  await expect(list.locator('.opml-url').nth(1)).toHaveText('https://beta.example/rss?a=1&b=2');
  await expect(list.locator('.opml-row').nth(2)).toContainText('already subscribed');
  await expect(sheet.getByRole('checkbox', { name: 'import Legacy again' })).toBeDisabled();
  await expect(sheet.getByRole('checkbox', { name: 'add these to my blogroll' })).not.toBeChecked();

  // Leave Delta out; the blogroll box stays off.
  await sheet.getByRole('checkbox', { name: 'import Delta' }).uncheck();
  await sheet.getByRole('button', { name: 'import 3 feeds' }).click();

  const summary = sheet.locator('.opml-summary');
  await expect(summary).toContainText('2 added · 2 already subscribed · 0 failed', { timeout: 15_000 });
  await expect(list.locator('.opml-row').nth(0)).toContainText('added');
  await expect(list.locator('.opml-row').nth(3)).toContainText('already subscribed');

  // Alpha, Beta, Gamma (throttled), Gamma again. Legacy was never sent, nor Delta.
  expect(posts.map((post) => new URL(post.url).hostname)).toEqual(['alpha.example', 'beta.example', 'gamma.example', 'gamma.example']);
  expect(posts.every((post) => post.backfill === false && post.confirm === true)).toBe(true);
  expect(overlapped).toBe(false);
  // Paced: about a second between writes, and the 429's Retry-After waited out.
  expect(posts[1].at - posts[0].at).toBeGreaterThanOrEqual(900);
  expect(posts[3].at - posts[2].at).toBeGreaterThanOrEqual(900);
  expect(patches).toEqual([]);

  await sheet.getByRole('button', { name: 'done' }).click();
  await expect(sheet).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the blogroll box adds each new subscription with PATCH, and a malformed file is refused', async ({ page }) => {
  await login(page);
  await page.goto('/studio/reading?view=sources');
  const patched: unknown[] = [];
  await page.route('**/api/subscriptions', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 201, json: subscription((route.request().postDataJSON() as { url: string }).url) })
      : route.fallback(),
  );
  await page.route('**/api/subscriptions/sub-*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    patched.push(route.request().postDataJSON());
    await route.fulfill({ json: { ...subscription('https://one.example/feed'), inBlogroll: true } });
  });

  await page.locator('#opml-open').click();
  const sheet = page.getByRole('dialog', { name: 'import OPML' });
  await sheet.locator('#opml-file').setInputFiles({ name: 'broken.opml', mimeType: 'text/x-opml', buffer: Buffer.from('<opml><body><outline xmlUrl="https://x.example/"></body>') });
  await expect(sheet.getByRole('alert')).toContainText('not well-formed XML');

  await sheet.locator('#opml-file').setInputFiles({
    name: 'one.opml', mimeType: 'text/x-opml',
    buffer: Buffer.from('<opml version="2.0"><body><outline text="One" xmlUrl="https://one.example/feed"/></body></opml>'),
  });
  await sheet.getByRole('checkbox', { name: 'add these to my blogroll' }).check();
  await sheet.getByRole('button', { name: 'import 1 feed' }).click();
  await expect(sheet.locator('.opml-summary')).toContainText('1 added · 0 already subscribed · 0 failed');
  expect(patched).toEqual([{ inBlogroll: true }]);
});
