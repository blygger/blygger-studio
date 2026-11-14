import { fixtureJson } from './api-fixture';
import { test, expect, type Page } from './fixture';

// Mathematics (#105): what the author sees while writing, what the public page
// shows, and the one refusal a reader of the editor meets (a passage across a
// formula). The browser draws MathML itself, so these check rendered boxes, not
// only markup.
async function login(page: Page) {
  await page.goto('/studio/login');
  await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(fixtureJson, { method, path: `/api${path}`, body });

test('the preview draws a formula, and shows a broken one as written', async ({ page }, info) => {
  await login(page);
  const { json } = await api(page, 'POST', '/items', { contentMd: 'Area $\\pi r^2$ and\n\n$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$', kind: 'thread' });
  await page.goto(`/studio/edit/${json.id}`);
  const pane = (name: 'draft' | 'preview') => page.getByRole('group', { name: 'pane' }).getByRole('button', { name }).click();
  if (info.project.name === 'mobile') await pane('preview');
  const display = page.locator('#preview-body math[display="block"]');
  await expect(display).toBeVisible();
  const box = (await display.boundingBox())!;
  // Drawn as a block of its own, a fraction tall, not a line of symbols.
  expect(box.height).toBeGreaterThan(30);
  await expect(page.locator('#preview-body math').first()).toBeVisible();
  if (info.project.name === 'mobile') await pane('draft');
  await page.locator('#md-input').fill('Broken $\\frac{a$ here');
  if (info.project.name === 'mobile') await pane('preview');
  await expect(page.locator('#preview-body .math-error')).toHaveText('$\\frac{a$');
});

test('a published formula is on the public page with its TeX, and the toolbar writes one', async ({ page }) => {
  await login(page);
  const { json } = await api(page, 'POST', '/items', { contentMd: 'Euler: ', kind: 'fragment' });
  await page.goto(`/studio/edit/${json.id}`);
  const box = page.locator('#md-input');
  await box.focus();
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.locator('.ed-tools [data-action=md-formula]').click();
  await page.keyboard.type('e^{i\\pi} + 1 = 0');
  await expect(box).toHaveValue('Euler: $e^{i\\pi} + 1 = 0$');
  await expect.poll(async () => (await api(page, 'GET', `/items/${json.id}`)).json.contentMd).toBe('Euler: $e^{i\\pi} + 1 = 0$');
  expect((await api(page, 'POST', `/items/${json.id}/publish`, {})).status).toBe(200);
  await page.goto(`/f/${json.id}/`);
  await expect(page.locator('article math')).toBeVisible();
  await expect(page.locator('article annotation[encoding="application/x-tex"]')).toHaveText('e^{i\\pi} + 1 = 0');
});

test('a passage across a formula is refused where it is chosen', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'mouse selection');
  await login(page);
  const target = await api(page, 'POST', '/items', { contentMd: 'Energy $E=mc^2$ is famous.\n\nA second paragraph.', kind: 'fragment' });
  expect((await api(page, 'POST', `/items/${target.json.id}/publish`, {})).status).toBe(200);
  // A stub of one's own post, as Reading makes it: the citation names this blyg.
  const origin = (await (await page.request.get('/blyg.json')).json()).site as string;
  const stub = await api(page, 'POST', '/items', { contentMd: `![[${target.json.id}]]\n\nMy reply.`, kind: 'thread', stubOf: { id: target.json.id, version: 1, origin } });
  expect(stub.status).toBe(201);
  await page.goto(`/studio/edit/${stub.json.id}`);
  const quote = page.locator('#preview-body blockquote.blyg-transclusion');
  await expect(quote.locator('math')).toBeVisible();
  const select = (first: string, last: string) => quote.evaluate((el, [first, last]) => {
    const p = [...el.querySelectorAll('p')];
    const start = p.find((n) => n.textContent!.includes(first))!;
    const end = p.find((n) => n.textContent!.includes(last))!;
    const range = document.createRange();
    range.setStart(start.firstChild!, 0);
    range.setEnd(end.lastChild!, end.lastChild!.textContent!.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  }, [first, last]);
  await select('Energy', 'Energy');
  await expect(page.locator('[data-note=quote-formula]')).toBeVisible();
  await expect(page.locator('[data-action=quote-passage]')).toHaveCount(0);
  await select('A second', 'A second');
  await expect(page.locator('[data-action=quote-passage]')).toBeVisible();
  await expect(page.locator('[data-note=quote-formula]')).toHaveCount(0);
});

// v0.4-plan §23.5: an overline is drawn in Core, so a reader sees the bar.
test('an overline is drawn: a bar of real width over the expression, unlike the bare letters', async ({ page }) => {
  await login(page);
  const publish = async (contentMd: string) => {
    const { json } = await api(page, 'POST', '/items', { contentMd, kind: 'fragment' });
    expect((await api(page, 'POST', `/items/${json.id}/publish`, {})).status).toBe(200);
    return json.id as string;
  };
  const bare = await publish('$AB$');
  const barred = await publish('$\\overline{AB}$');
  await page.goto(`/f/${barred}/`);
  const bar = page.locator('article math mover > mo');
  await expect(bar).toHaveCount(1);
  expect((await bar.boundingBox())!.width).toBeGreaterThan(0);
  const withBar = await page.locator('article math').screenshot();
  await page.goto(`/f/${bare}/`);
  const withoutBar = await page.locator('article math').screenshot();
  expect(withBar.equals(withoutBar)).toBe(false);
});
