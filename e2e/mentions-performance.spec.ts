import { test, expect, type Page } from './fixture';
import { READ_BATCH_PATHS, type ReadBatchOperation, type ReadBatchInput } from '../src/read-batch-policy.ts';

const targetId = (group: number) => `paged-target-${String(group).padStart(3, '0')}`;
const receiptId = (group: number, index: number) => `receipt-${String(group).padStart(3, '0')}-${String(index).padStart(3, '0')}`;
const at = '2026-11-03T00:00:00Z';
function responsePage(rows: Record<string, unknown>[], params: URLSearchParams, fields: string[]) {
  const matching = rows.filter(row => fields.every(field => !params.has(field) || row[field] === params.get(field))
    && (!params.has('verifiedAtNull') || row.verifiedAt === null));
  const start = Number(params.get('cursor') ?? 0), limit = Number(params.get('limit') ?? 100);
  return { items: matching.slice(start, start + limit), page: { limit, nextCursor: start + limit < matching.length ? String(start + limit) : null } };
}
async function installMentions(page: Page, options: {
  groups: number; receipts: number; outbound: number; sourceGate?: Promise<void>;
  responses?: ('default' | 'show' | 'hide' | null)[];
  receiptStates?: { status: 'verified' | 'gone'; hidden: boolean }[];
}) {
  const stats = { groupReads: [] as URLSearchParams[], receiptReads: [] as URLSearchParams[], sources: [] as string[], groupRowsSent: 0, receiptRowsSent: 0 };
  const receiptState = (index: number) => options.receiptStates?.[index] ?? { status: 'verified', hidden: false };
  const visible = Array.from({ length: options.receipts }, (_, index) => receiptState(index)).filter(row => row.status === 'verified' && !row.hidden).length;
  const groups = Array.from({ length: options.groups }, (_, group) => ({ targetItemId: targetId(group), total: options.receipts, visible,
    verifiedAt: at, lastSeen: at, firstId: receiptId(group, 0) }));
  function read(path: string, params: URLSearchParams): { status: number; body: unknown; headers: Record<string, string> } | null {
    if (path === '/api/mention-groups') {
      stats.groupReads.push(params);
      const result = responsePage(groups, params, ['targetItemId', 'verifiedAt', 'lastSeen', 'firstId']);
      stats.groupRowsSent += result.items.length;
      return { status: 200, body: result, headers: {} };
    }
    if (path === '/api/mentions/summary') return { status: 200, body: { inbound: options.groups * options.receipts, outbound: options.outbound, groups: options.groups }, headers: {} };
    if (path.startsWith('/api/items/paged-target-')) {
      const id = path.split('/').at(-1)!;
      const group = Number(id.split('-').at(-1));
      if (options.responses?.[group] === null) return { status: 404, body: { code: 'not-found', message: 'not found' }, headers: {} };
      return { status: 200, headers: {}, body: { id, revision: 1, contentMd: `Paged target ${group}`, kind: 'fragment', status: 'public',
        created: at, updated: at, version: 1, dirty: false, responses: options.responses?.[group] ?? 'default', highlight: 'default', provenance: [], stubOf: null, forkedFrom: null,
        forkCite: null, pins: [], media: [], publishedMedia: [], published: null } };
    }
    if (path !== '/api/mentions') return null;
    stats.receiptReads.push(params);
    const direction = params.get('direction');
    const rows = direction === 'outbound'
      ? Array.from({ length: options.outbound }, (_, index) => ({ id: `out-${String(index).padStart(3, '0')}`, itemId: targetId(0), version: 1, targetVersion: null,
        target: `https://remote.test/out/${index}`, endpoint: null, status: 'sent', attempts: 1, nextAttemptAt: null, lastError: null, created: at }))
      : Array.from({ length: options.groups }, (_, group) => group).filter(group => !params.has('targetItemId') || targetId(group) === params.get('targetItemId'))
        .flatMap(group => Array.from({ length: options.receipts }, (_, index) => ({ id: receiptId(group, index), source: `https://source.test/${receiptId(group, index)}`,
          target: `https://site.test/f/${targetId(group)}/`, targetItemId: targetId(group), status: receiptState(index).status, relation: 'stub', sourceOrigin: 'https://source.test/',
          sourceId: options.sourceGate ? 'remote' : null, sourceKind: 'fragment', sourceVersion: 1, sourcePage: null, firstSeen: at, lastSeen: at,
          verifiedAt: at, attempts: 0, error: null, hidden: receiptState(index).hidden, sourceAuthor: { name: `Source ${group}-${index}` } })));
    const result = responsePage(rows, params, direction === 'outbound' ? ['id', 'created'] : ['targetItemId', 'id', 'verifiedAt', 'lastSeen']);
    stats.receiptRowsSent += result.items.length;
    return { status: 200, body: { ...result, direction }, headers: {} };
  }
  await page.route('**/api/read-batch', async route => {
    const body = route.request().postDataJSON() as { operation: ReadBatchOperation; requests: ReadBatchInput[] };
    const results = await Promise.all(body.requests.map(async child => {
      const url = new URL('/api' + READ_BATCH_PATHS[body.operation].replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(child.path?.[key] ?? '')), route.request().url());
      url.search = new URLSearchParams(child.query).toString();
      const result = read(url.pathname, url.searchParams);
      if (result) return result;
      const response = await page.request.get(url.href);
      return { status: response.status(), body: await response.json(), headers: {} };
    }));
    await route.fulfill({ json: results });
  });
  await page.route(url => ['/api/mention-groups', '/api/mentions', '/api/mentions/summary'].includes(url.pathname) || url.pathname.startsWith('/api/items/paged-target-'), async route => {
    const url = new URL(route.request().url()), result = read(url.pathname, url.searchParams)!;
    await route.fulfill({ status: result.status, json: result.body });
  });
  await page.route('**/api/mentions/receipt-*/source', async route => {
    stats.sources.push(new URL(route.request().url()).pathname);
    await options.sourceGate;
    await route.fulfill({ json: { holder: null, subscription: null } });
  });
  return stats;
}
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}

test('the visible Mentions tab preloads summaries, while source details never block navigation', async ({ page }) => {
  let release!: () => void;
  const sourceGate = new Promise<void>(resolve => { release = resolve; });
  const stats = await installMentions(page, { groups: 1, receipts: 60, outbound: 0, sourceGate });
  try {
    await login(page);
    await expect.poll(() => stats.groupReads.length).toBeGreaterThan(0);
    expect(new URL(page.url()).pathname).toMatch(/^\/studio\/?$/);
    expect(stats.receiptReads).toEqual([]);
    expect(stats.sources).toEqual([]);
    await page.getByRole('link', { name: 'responses', exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/mentions$/);
    await expect(page.locator('.mention-row')).toHaveCount(10);
    await expect(page.locator('.group-meta')).toContainText('60 responses');
    await expect.poll(() => stats.sources.length).toBeGreaterThan(0);
    expect(stats.sources.length).toBeLessThan(10);
    await page.getByRole('button', { name: 'load more mentions', exact: true }).click();
    await expect(page.locator('.mention-row')).toHaveCount(20);
    await page.locator('.mention-row').last().scrollIntoViewIfNeeded();
    await expect.poll(() => stats.sources.includes(`/api/mentions/${receiptId(0, 19)}/source`)).toBe(true);
    expect(stats.sources.length).toBeLessThan(30);
  } finally {
    release();
    await page.waitForLoadState('networkidle');
  }
});

test('mentions pages groups, their receipts, and outbound rows with complete counts', async ({ page }) => {
  const stats = await installMentions(page, { groups: 80, receipts: 45, outbound: 80 });
  await login(page);
  await page.getByRole('link', { name: 'responses', exact: true }).click();
  await expect(page.locator('.mention-group')).toHaveCount(10);
  const first = page.locator('.mention-group').first();
  await expect(first.locator('.mention-row')).toHaveCount(10);
  await expect(first.locator('.group-meta')).toContainText('45 responses');
  await expect(page.getByRole('button', { name: /^inbound/ })).toContainText('3600');
  await expect(page.getByRole('button', { name: /^outbound/ })).toContainText('80');
  expect(stats.groupRowsSent).toBeLessThan(80);
  expect(stats.receiptReads.every(params => params.get('direction') === 'inbound' && params.has('targetItemId'))).toBe(true);
  expect(stats.receiptRowsSent).toBeLessThan(1_000);
  await first.getByRole('button', { name: 'load more mentions', exact: true }).click();
  await expect(first.locator('.mention-row')).toHaveCount(20);
  await expect(first.locator('.who')).toHaveText(Array.from({ length: 20 }, (_, index) => `Source 0-${index}`));
  await page.getByRole('button', { name: 'load more groups', exact: true }).click();
  await expect(page.locator('.mention-group')).toHaveCount(20);
  await expect(first.locator('.mention-row')).toHaveCount(20);
  await page.getByRole('button', { name: 'load more groups', exact: true }).click();
  await expect(page.locator('.mention-group')).toHaveCount(30);
  await expect(page.locator('.mention-group h3')).toHaveText(Array.from({ length: 30 }, (_, index) => `Paged target ${index} ↗ edit`));
  await page.getByRole('button', { name: /^outbound/ }).click();
  await expect(page.locator('.out-row')).toHaveCount(25);
  await page.getByRole('button', { name: 'load more outbound mentions', exact: true }).click();
  await expect(page.locator('.out-row')).toHaveCount(50);
  await expect(page.locator('.out-row .target')).toHaveText(Array.from({ length: 50 }, (_, index) => `https://remote.test/out/${index}`));
});

for (const defaultShowing of [false, true]) {
  test(`paged Mentions preserve visibility and missing targets with site default ${defaultShowing}`, async ({ page }) => {
    await installMentions(page, {
      groups: 4, receipts: 3, outbound: 0,
      responses: ['show', 'hide', 'default', null],
      receiptStates: [
        { status: 'verified', hidden: false },
        { status: 'verified', hidden: true },
        { status: 'gone', hidden: false },
      ],
    });
    await login(page);
    const previousDefault = await page.evaluate(async showResponsesDefault => {
      const previous = await (await fetch('/api/settings')).json();
      const result = await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ showResponsesDefault }) });
      if (!result.ok) throw new Error('Could not set the fixture response policy');
      return previous.showResponsesDefault as boolean;
    }, defaultShowing);
    try {
      await page.goto('/studio/mentions');
      await expect(page.locator('.mention-group')).toHaveCount(4);
      await expect(page.locator('.group-meta')).toHaveText([1, 0, defaultShowing ? 1 : 0, defaultShowing ? 1 : 0]
        .map(visible => `3 responses · ${visible} on the page now`));
      await expect(page.locator('.mention-row')).toHaveCount(12);
      await expect(page.locator('.mention-row.hidden-row')).toHaveCount(4);
      await expect(page.locator('.mention-row.gone')).toHaveCount(4);
      await expect(page.getByRole('button', { name: /^inbound/ })).toContainText('12');
      const missing = page.locator('.mention-group').last();
      await expect(missing.locator('h3')).toHaveText('paged-ta edit');
      await expect(missing.getByRole('button', { name: 'show', exact: true })).toBeDisabled();
    } finally {
      await page.evaluate(async showResponsesDefault => {
        const result = await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ showResponsesDefault }) });
        if (!result.ok) throw new Error('Could not restore the fixture response policy');
      }, previousDefault);
    }
  });
}

test('a failed Mentions group continuation keeps the loaded page and recovers through retry', async ({ page }) => {
  await page.clock.install();
  const stats = await installMentions(page, { groups: 80, receipts: 1, outbound: 0 });
  await login(page);
  await page.getByRole('link', { name: 'responses', exact: true }).click();
  await expect(page.locator('.mention-group')).toHaveCount(10);
  await page.clock.pauseAt(new Date(Date.now() + 10_000));
  let fail = true;
  await page.route('**/api/read-batch', route => {
    const body = route.request().postDataJSON() as { operation: string; requests: ReadBatchInput[] };
    if (fail && body.operation === 'listMentionGroups' && body.requests.some(child => child.query?.cursor)) {
      return route.fulfill({ json: body.requests.map(() => ({ status: 503, body: { code: 'internal', message: 'controlled mention page failure' }, headers: {} })) });
    }
    return route.fallback();
  });
  await page.getByRole('button', { name: 'load more groups', exact: true }).click();
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.getByRole('alert').filter({ hasText: 'controlled mention page failure' }).count();
  }).toBeGreaterThan(0);
  await expect(page.locator('.mention-group')).toHaveCount(10);
  fail = false;
  await page.getByRole('button', { name: 'retry reads', exact: true }).first().click();
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.getByRole('alert').count();
  }).toBe(0);
  await page.getByRole('button', { name: 'load more groups', exact: true }).click();
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.locator('.mention-group').count();
  }).toBe(20);
  expect(stats.groupReads.some(params => Number(params.get('cursor')) >= 30)).toBe(false);
});
