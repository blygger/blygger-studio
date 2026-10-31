import { test, expect, type Page } from './fixture';

// Browsing the thicket from the reader (0.49.0): every quoted layer, at any
// depth, and every link that names a blyg item opens in the reader; back
// retraces the descent; and the walk is logged privately and shown in the
// history pane. Own items stand in for other blygs here: they take the same
// path through ReaderBody and the trail, and the fetch-through to an
// unsubscribed origin is covered by the worker suite (test/peek.test.ts).
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
async function publish(page: Page, content_md: string, kind: 'fragment' | 'thread') {
  const { json } = await api(page, 'POST', '/items', { content_md, kind });
  expect((await api(page, 'POST', `/items/${json.id}/publish`)).status).toBe(200);
  return json.id as string;
}

test('a stack of quotes opens layer by layer in the reader, back retraces it, and the walk is logged', async ({ page }) => {
  await login(page);
  const tag = `Walk${Date.now()}`;
  const leaf = await publish(page, `# ${tag} leaf\n\nThe leaf text.`, 'fragment');
  const middle = await publish(page, `# ${tag} middle\n\n![[${leaf}]]\n\nMiddle comment.`, 'thread');
  const top = await publish(page, `# ${tag} top\n\n![[${middle}]]\n\nTop comment, an [outside link](https://elsewhere.example/page), and a [link to the leaf](${new URL('/', page.url()).origin}/f/${leaf}/).`, 'thread');

  await page.goto(`/studio/reading/~own/${top}`);
  const body = page.locator('.article-body');
  // Both layers carry a line, however deep: the middle thread and the leaf inside it.
  await expect(body.locator('.layer-ref')).toHaveCount(2);
  // The ordinary link to a blyg item is recognised and opens in the reader too.
  await expect(body.locator('a.reader-ref[data-reader-via=link]')).toHaveCount(1);
  // A link that is not a blyg item leaves the studio in a new tab; the blyg one does not.
  const outside = body.locator('a[href="https://elsewhere.example/page"]');
  await expect(outside).toHaveAttribute('target', '_blank');
  await expect(outside).toHaveAttribute('rel', /noopener/);
  await expect(outside).not.toHaveClass(/reader-ref/);
  await expect(page.locator('.crumbs')).toHaveCount(0);

  // Down the stack: the middle layer, then the leaf inside it.
  await body.locator('.layer-ref a').first().click();
  await expect(page).toHaveURL(new RegExp(`/studio/reading/~own/${middle}$`));
  await expect(page.locator('.crumbs')).toContainText(`${tag} top`);
  await expect(page.locator('.crumbs a').first()).toHaveAttribute('href', new RegExp(`/reading/~own/${top}$`));
  await expect(page.locator('.crumbs [aria-current]')).toContainText(`${tag} middle`);
  await page.locator('.article-body .layer-ref a').first().click();
  await expect(page).toHaveURL(new RegExp(`/studio/reading/~own/${leaf}$`));
  await expect(page.locator('.article-body')).toContainText('The leaf text.');
  await expect(page.locator('.crumbs')).toContainText(`${tag} top`);

  // Back out, one entry at a time.
  await page.getByRole('button', { name: 'back', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/studio/reading/~own/${middle}$`));
  await expect(page.locator('.crumbs [aria-current]')).toContainText(`${tag} middle`);
  await page.getByRole('button', { name: 'back', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/studio/reading/~own/${top}$`));
  await expect(page.locator('.crumbs')).toHaveCount(0);

  // The link branches from the same entry rather than overwriting the first descent.
  await page.locator('.article-body a.reader-ref[data-reader-via=link]').click();
  await expect(page).toHaveURL(new RegExp(`/studio/reading/~own/${leaf}$`));

  // The private log kept the tree, and the pane shows it.
  // The log is written after the page has moved on, so wait for the last step.
  const logged = async () => (await api(page, 'GET', '/browse?limit=100')).json.items as { remote_id: string; via: string; parent_id: number | null; id: number; trail: string }[];
  await expect.poll(async () => (await logged()).filter((s) => [top, middle, leaf].includes(s.remote_id)).length).toBe(6);
  const steps = ((await logged()) as { remote_id: string; via: string; parent_id: number | null; id: number; trail: string }[]).filter((s) => [top, middle, leaf].includes(s.remote_id)).reverse();
  expect(steps.map((s) => [s.remote_id === top ? 'top' : s.remote_id === middle ? 'middle' : 'leaf', s.via])).toEqual([
    ['top', 'start'], ['middle', 'quote'], ['leaf', 'quote'], ['middle', 'back'], ['top', 'back'], ['leaf', 'link'],
  ]);
  expect(new Set(steps.map((s) => s.trail)).size).toBe(1);
  expect(steps[5].parent_id).toBe(steps[0].id);
  await page.getByRole('button', { name: 'history', exact: true }).click();
  const pane = page.getByRole('dialog', { name: 'Browsing history' });
  await expect(pane).toContainText('This walk');
  await expect(pane.locator('[data-current] a').first()).toHaveAttribute('href', new RegExp(`/reading/~own/${top}$`));
  await expect(pane.locator(`.trail-walk[data-trail="${steps[0].trail}"] li`)).toHaveCount(6);
  await pane.getByRole('button', { name: 'close', exact: true }).click();

  // Leaving for the feed ends the walk; the next entry starts a new one.
  await page.goto('/studio/reading');
  // The feed ends the walk from an effect after load; a reload before that restores the old stack.
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('studio.browse') ?? '{"stack":[]}').stack.length === 0);
  await page.goto(`/studio/reading/~own/${leaf}`);
  await expect.poll(async () => (await logged())[0]?.via).toBe('start');
  const again = (await logged())[0];
  expect([again.remote_id, again.via]).toEqual([leaf, 'start']);
  expect(again.trail).not.toBe(steps[0].trail);
});

test('an item of a blyg you do not hold opens at /peek, says so, and is not stored', async ({ page }) => {
  await login(page);
  // An origin that cannot be reached reports the failure in the reader, with the walk intact.
  const origin = 'https://unreachable.invalid/';
  await page.goto(`/studio/peek?origin=${encodeURIComponent(origin)}&id=00000000000000000000000zz9`);
  await expect(page.locator('.error, [role=alert]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'history', exact: true })).toBeVisible();
});

test('opening an item of an unsubscribed blyg says so and offers to subscribe', async ({ page }) => {
  await login(page);
  const origin = 'https://stranger.example/';
  await page.route('**/api/peek*', (route) =>
    route.fulfill({ json: { origin, id: 'x1', kind: 'fragment', version: 1, content_html: '<p>A stranger&#39;s words, <a href="https://elsewhere.example/o">a link</a>.</p>', page: null, url: `${origin}f/x1/`, stub_of: null, forked_from: null, subscription_id: null } }),
  );
  await page.goto(`/studio/peek?origin=${encodeURIComponent(origin)}&id=x1`);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('You’re not subscribed to this blyg');
  await expect(page.locator('.article-body')).toContainText("A stranger's words");
  // Outside links from it also leave in a new tab.
  await expect(page.locator('.article-body a[href="https://elsewhere.example/o"]')).toHaveAttribute('target', '_blank');
  await alert.getByRole('button', { name: 'subscribe?', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Subscribe to stranger.example' })).toBeVisible();
});

for (const intent of ['hover', 'focus'] as const) {
  for (const kind of ['quote', 'link', 'peek'] as const) {
    test(`reader ${kind} ${intent} preloads before navigation without logging a visit`, async ({ page }) => {
      await login(page);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const leaf = kind === 'peek' ? `peek-${Date.now()}` : await publish(page, 'Preloaded reader target.', 'fragment');
      const origin = kind === 'peek' ? 'https://reader-preload.example/' : `${new URL(page.url()).origin}/`;
      const url = `${origin}f/${leaf}/`;
      if (kind === 'peek') {
        await page.route('**/api/peek/links', route => route.fulfill({ json: { links: [{ url, target: { origin, id: leaf } }] } }));
        await page.route('**/api/peek?*', route => route.fulfill({ json: {
          origin, id: leaf, kind: 'fragment', version: 1, content_html: '<p>Preloaded reader target.</p>',
          page: null, url, stub_of: null, forked_from: null, subscription_id: null,
        } }));
      }
      const top = await publish(page, kind === 'quote' ? `![[${leaf}]]` : `[open target](${url})`, 'thread');
      await page.goto(`/studio/reading/~own/${top}`);
      const link = page.locator(kind === 'quote' ? '.article-body .layer-ref a' : '.article-body a[data-reader-via=link]').first();
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', kind === 'peek' ? /\/studio\/peek\?/ : new RegExp(`/studio/reading/~own/${leaf}$`));
      const matches = (url: string) => new URL(url).pathname === (kind === 'peek' ? '/api/peek' : `/api/items/${leaf}`);
      const reads: string[] = [];
      page.on('request', request => { if (matches(request.url())) reads.push(request.url()); });
      const loaded = page.waitForResponse(response => matches(response.url()) && response.ok());
      await link[intent]();
      await loaded;
      expect(page.url()).toContain(`/reading/~own/${top}`);
      expect(reads).toHaveLength(1);
      const visits = (await api(page, 'GET', '/browse?limit=100')).json.items as { remote_id: string }[];
      expect(visits.some(visit => visit.remote_id === leaf)).toBe(false);
      await link.click();
      await expect(page).toHaveURL(kind === 'peek' ? /\/studio\/peek\?/ : new RegExp(`/studio/reading/~own/${leaf}$`));
      await expect(page.locator('.crumbs [aria-current]')).toContainText('Preloaded reader target.');
      await expect(page.locator('.article-body')).toContainText('Preloaded reader target.');
      expect(reads).toHaveLength(1);
      expect(errors).toEqual([]);
    });
  }
}
