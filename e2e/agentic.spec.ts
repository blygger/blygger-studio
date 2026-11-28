import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture';

// The Agentic feed tab draws the edition an assistant wrote (src/ui/agentic.tsx):
// a masthead, sections in order, the assistant's own words marked as generated,
// and each entry linking to its full view.
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path: `/api${path}`, body });

test('an edition renders as a digest in sections, the assistant’s words marked, entries opening their full view', async ({ page }) => {
  await login(page);
  const stamp = Date.now();
  const lead = (await api(page, 'POST', '/items', { contentMd: `# Lead piece ${stamp}\n\nThe body of the lead.` })).json.id;
  await api(page, 'POST', `/items/${lead}/publish`, {});
  const brief = (await api(page, 'POST', '/items', { contentMd: `A brief ${stamp}` })).json.id;
  await api(page, 'POST', `/items/${brief}/publish`, {});
  const { revision } = (await api(page, 'GET', '/agentic/default')).json;
  const put = await api(page, 'PUT', '/agentic/default', {
    expectedRevision: revision,
    edition: {
      title: `Edition ${stamp}`,
      lede: 'Two things today.',
      agent: { name: 'e2e assistant' },
      sections: [
        { title: 'Front page', kind: 'lead', entries: [{ sub: 'parity-native', remoteId: '00000000000000000000000001', headline: `Native headline ${stamp}`, summary: 'What the native piece argues.', present: 'full' }] },
        { title: 'Briefs', kind: 'briefs', note: 'Short ones.', entries: [{ sub: '~own', remoteId: lead, reason: 'You wrote it' }, { sub: '~own', remoteId: brief, present: 'title' }] },
      ],
    },
  });
  expect(put.status).toBe(200);

  await page.goto('/studio/reading?lens=agentic');
  await expect(page.getByRole('group', { name: 'reading tabs' }).locator('[aria-pressed=true]')).toHaveText(['Agentic feed']);
  const edition = page.locator('.edition');
  await expect(edition.locator('.edition-title')).toHaveText(`Edition ${stamp}`);
  await expect(edition.locator('.edition-meta')).toContainText('by e2e assistant');
  await expect(edition.locator('.edition-meta')).toContainText('written by your assistant');
  await expect(edition.locator('.edition-section-h')).toHaveText(['Front page', 'Briefs']);
  // The assistant's words carry the generated mark; the authors' text does not.
  await expect(edition.locator('.kind-lead .edition-headline [data-generated=assistant]')).toHaveText(`Native headline ${stamp}`);
  await expect(edition.locator('.kind-lead .edition-body')).toContainText('Frozen source text.');
  await expect(edition.locator('.kind-lead .edition-body [data-generated]')).toHaveCount(0);
  await expect(edition.locator('.kind-briefs .edition-reason')).toHaveText('You wrote it');
  await expect(edition.locator('.kind-briefs .edition-headline').nth(1)).toHaveText(`A brief ${stamp}`);

  // The edition is also a private draft thread, opened in the editor.
  await expect(edition.getByRole('link', { name: 'Open as a thread' })).toHaveAttribute('href', new RegExp(`/studio/edit/${put.json.draft.id}$`));
  await expect(edition.locator('.edition-thread')).toContainText('a private draft until you publish it');

  // The owner names the tab.
  await api(page, 'PATCH', '/settings', { agenticTitle: 'Daily digest' });
  try {
    await page.reload();
    await expect(page.getByRole('group', { name: 'reading tabs' }).locator('[aria-pressed=true]')).toHaveText(['Daily digest']);
  } finally {
    await api(page, 'PATCH', '/settings', { agenticTitle: '' });
  }

  await edition.getByRole('link', { name: `Lead piece ${stamp}` }).click();
  await expect(page).toHaveURL(new RegExp(`/studio/reading/~own/${lead}$`));
  await expect(page.locator('.reading-article')).toContainText('The body of the lead.');
});

test('a mention from a blyg not followed and a met blyg render as outside cards: the receipt as stored, the blyg opened live, with Subscribe', async ({ page }) => {
  await login(page);
  const { revision } = (await api(page, 'GET', '/agentic/default')).json;
  const put = await api(page, 'PUT', '/agentic/default', {
    expectedRevision: revision,
    edition: {
      agent: { name: 'e2e assistant' },
      sections: [{ title: 'Outside', kind: 'briefs', entries: [{ mention: 'parity-stranger' }, { remote: { origin: 'https://elsewhere.example/', id: '00000000000000000000000009' }, reason: 'Quoted three times' }, { remote: { origin: 'https://unmet.example/', id: 'x' } }] }],
    },
  });
  expect(put.status).toBe(200);
  // The unmet origin does not resolve; the other two do.
  expect(put.json.layout.sections[0].entries.map((e: { mention?: string; remote?: { origin: string } }) => e.mention ?? e.remote?.origin)).toEqual(['parity-stranger', 'https://elsewhere.example/']);

  await page.goto('/studio/reading?lens=agentic');
  const cards = page.locator('.edition .edition-outside');
  await expect(cards).toHaveCount(2);
  const mention = cards.nth(0);
  await expect(mention.locator('.edition-headline')).toHaveText('Source author answered your post');
  await expect(mention.locator('.edition-headline')).toHaveAttribute('href', 'https://stranger.example/post');
  await expect(mention.locator('.edition-byline')).toContainText('stranger.example');
  await expect(mention.getByRole('link', { name: 'your post', exact: true })).toHaveAttribute('href', /\/studio\/reading\/~own\//);
  const remote = cards.nth(1);
  await expect(remote.locator('.edition-headline')).toHaveText('The latest from Elsewhere');
  await expect(remote.locator('.edition-headline')).toHaveAttribute('href', /\/studio\/peek\?origin=https%3A%2F%2Felsewhere\.example%2F&id=00000000000000000000000009$/);
  await expect(remote.locator('.edition-byline')).toContainText('in the blygger.com directory');
  await expect(remote.locator('.edition-reason[data-generated=assistant]')).toHaveText('Quoted three times');
  await expect(remote.getByRole('button', { name: 'Subscribe' })).toBeVisible();
});
