/**
 * Imported content must remain data in the owner's browser. OWASP XSS guidance:
 * https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
 * Model: no payload may set data-import-script on the owner document. The driver
 * logs in normally, loads raw stored imports through the real SDK/REST/React
 * reading path, then clicks attacker links with a trusted browser input event.
 * The corpus is fixed and shared with the Worker oracle, which uses URL parsing
 * as a different formulation. These Chromium profiles do not cover all engines,
 * HTML grammars, parser versions or deployed response headers.
 */
import { test, expect } from './fixture';
import { importedHtmlAttacks } from '../test/fixtures/imported-html-attacks';
test.use({ baseURL: 'http://127.0.0.1:8791' });

for (const attack of importedHtmlAttacks) test('stored imported HTML cannot execute: ' + attack.id, async ({ page }) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/settings')).status)).toBe(200);
  await page.goto('/studio/reading?sub=security-html');
  const article = page.locator('article').filter({ hasText: 'Security ' + attack.id });
  await expect(article).toHaveCount(1);
  if ('click' in attack) {
    const link = article.locator('a').filter({ hasText: attack.click });
    // Removing active markup is allowed; preserving active authority is not.
    if (await link.count()) await link.click({ force: true });
  }
  // Two rendering turns let insertion/load callbacks settle without a sleep.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('html'), 'imported script must not execute in the owner document').not.toHaveAttribute('data-import-script', 'yes');
  expect(new URL(page.url()).pathname).toBe('/studio/reading');
});

// A public page is still on the owner's origin. Legacy feed imports do not gain
// trust merely because the public collection is visited without an API request.
test('public legacy collection content cannot execute in an owner browser', async ({ page }) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  await page.goto('/h/security-imports/');
  await expect(page.getByRole('heading', { name: 'Security imports', exact: true })).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('html')).not.toHaveAttribute('data-import-script', 'yes');
});

// Same-origin script would be able to mint lasting owner authority. These tests
// check actual browser execution and the durable grant list, not only markup.
// The positive control proves owner-cookie minting works on this fixture node.
for (const surface of ['public collection', 'published thread'] as const) test('native import cannot mint owner authority through ' + surface, async ({ page }) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  await page.evaluate(async () => {
    const response = await fetch('/api/authorizations', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Owner positive control',scope:['owner:read','owner:draft','owner:publish','owner:manage'],resource:'api'})});
    if (!response.ok) throw new Error('Owner authority fixture is not usable');
    const {authorization} = await response.json();
    if (!(await fetch('/api/authorizations/'+authorization.id,{method:'DELETE'})).ok) throw new Error('Positive control cleanup failed');
  });
  const attemptedGrants: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/authorizations') attemptedGrants.push(request.url()); });
  let path = '/h/security-native/';
  if (surface === 'published thread') path = await page.evaluate(async () => {
    const created = await fetch('/api/items',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'thread',contentMd:'![[00000000000000000000000001]]'})});
    if (created.status!==201) throw new Error('Thread fixture create failed');
    const {id,revision}=await created.json();
    if (!(await fetch('/api/items/'+id+'/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:revision})})).ok) throw new Error('Thread fixture publish failed');
    return '/t/'+id+'/';
  });
  await page.goto(path);
  await expect(page.getByText('Native quoted safety marker',{exact:true})).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  expect(attemptedGrants, 'imported content must not attempt owner-authority calls').toEqual([]);
  await expect(page.locator('html'),'remote content cannot gain owner browser authority').not.toHaveAttribute('data-import-script','yes');
  const grants = await page.evaluate(async () => (await (await fetch('/api/authorizations')).json()).items);
  expect(grants.some((grant:{name:string})=>grant.name==='XSS authority marker'),'no lasting grant may be minted by imported content').toBe(false);
});

// Public version navigation is a second receiving path for old snapshots.
// Immutable protocol JSON must remain raw; browser presentation must remain inert.
test('public version navigation cannot activate a legacy pinned bake', async ({ page }) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button',{name:'log in',exact:true}).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  const attemptedGrants: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/authorizations') attemptedGrants.push(request.url()); });
  await page.goto('/t/00000000000000000000000003/');
  await expect(page.getByText('Safe latest safety marker',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'older version',exact:true}).click();
  await expect(page.getByText('Legacy pin safety marker',{exact:true})).toBeVisible();
  await expect(page.locator('.version-note')).toContainText('Old pin note');
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  expect(attemptedGrants, 'version navigation must not attempt owner-authority calls').toEqual([]);
  await expect(page.locator('html'),'version navigation cannot execute legacy protocol markup').not.toHaveAttribute('data-import-script','yes');
  const snapshot = await page.evaluate(async()=> (await (await fetch('/items/00000000000000000000000003/v1.json')).json()).content_html);
  expect(snapshot,'presentation repair must preserve immutable protocol snapshots').toContain('onerror=');
});
