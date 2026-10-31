/**
 * Owner consent must survive a real browser while resisting a hostile ancestor.
 * HTTP fixtures alone miss Origin suppression, cookie handling and frame refusal.
 * Sources: RFC9700 §4.2/§4.16 and OWASP clickjacking guidance:
 * https://www.rfc-editor.org/rfc/rfc9700.html#section-4.2
 * https://www.rfc-editor.org/rfc/rfc9700.html#section-4.16
 * https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html
 * Model: a read-only manual grant reads but cannot write, then fails after revoke;
 * login/consent work top-level but not under a foreign-origin ancestor. The external
 * callback receives no Referer. One-time token display is local UI policy.
 * History grammar: login/mint/hide/revoke/reload, top-level/iframe neighbors and
 * consent/code exchange with a separate client context.
 * Driver: real Chromium desktop/mobile against the compiled local Worker fixture.
 * The hostile ancestor is same-site and cross-origin; SameSite cookie suppression
 * cannot substitute for frame protection. Refinement observes actual frame failure,
 * UI state, request headers and bearer API statuses, not just response headers.
 * Limits: two Chromium profiles, not two independent browser engines or deployed TLS.
 */
import { test, expect } from './fixture';



// Browser receiving oracle: the model is the owner's named credential list
// and its explicit read-only choice. Observe UI and real bearer API decisions.
test('owner mints a read-only token, copies it once, and revokes access', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  await page.goto('/studio/access');
  await expect(page.getByRole('heading', { name: 'Client access', exact: true })).toBeVisible();
  const name = 'Browser read-only ' + test.info().project.name;
  await page.getByLabel('Client name').fill(name);
  const minted = page.waitForResponse(response => response.url().endsWith('/api/authorizations') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'create token', exact: true }).click();
  expect((await minted).status()).toBe(200);
  const field = page.getByRole('textbox', { name: 'New access token' });
  await expect(field).toBeVisible();
  const token = await field.inputValue();
  expect(token.length).toBeGreaterThan(30);
  const headers = { Authorization: 'Bearer ' + token };
  expect((await page.request.get('/api/settings', { headers })).status()).toBe(200);
  expect((await page.request.post('/api/items', { headers, data: { content_md: 'must not create' } })).status()).toBe(403);
  await page.getByRole('dialog').getByRole('button', { name: 'close', exact: true }).click();
  await expect(field).toHaveCount(0);
  const row = page.locator('section').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('owner:read');
  await row.getByRole('button', { name: 'revoke access', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'revoke', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await page.request.get('/api/settings', { headers })).status()).toBe(401);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Client access', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a hostile ancestor cannot frame the owner login or consent page', async ({ page, request: client }) => {
  const outer = 'http://127.0.0.1:8789/notes/b/hostile-frame';
  const assertBlocked = async (target: string) => {
    const response = await page.request.get(target);
    expect(response.status()).toBe(200);
    const failed: string[] = [];
    const recordFailure = (request: import('@playwright/test').Request) => { if (request.url() === target) failed.push(request.failure()?.errorText ?? ''); };
    page.on('requestfailed', recordFailure);
    await page.goto(outer + '?target=' + encodeURIComponent(target));
    expect(failed).toContain('net::ERR_BLOCKED_BY_RESPONSE');
    page.off('requestfailed', recordFailure);
    const frame = page.frames().find(value => value !== page.mainFrame());
    expect(frame).toBeDefined();
    // Chromium's failed document is the observed boundary, beyond a header
    // assertion. These ports are same-site so cookies do not mask the attack.
    expect(frame!.url()).toBe('chrome-error://chromewebdata/');
    await expect(page.frameLocator('iframe').getByRole('button', { name: 'log in', exact: true })).toHaveCount(0);
    await expect(page.frameLocator('iframe').getByRole('button', { name: 'allow access', exact: true })).toHaveCount(0);
  };
  await assertBlocked('http://127.0.0.1:8787/studio/login');
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  const registration = await client.post('/studio/auth/oauth2/register', { data: { client_name: 'Framing probe', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] } });
  expect(registration.status()).toBe(201);
  const { client_id } = await registration.json();
  const target = 'http://127.0.0.1:8787/studio/auth/oauth2/authorize?' + new URLSearchParams({ client_id, redirect_uri: 'https://client.example/callback', response_type: 'code', scope: 'owner:read', resource: 'http://127.0.0.1:8787/api', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
  await assertBlocked(target);
});

// A real form submission must retain its Origin while an external callback
// receives no Referer. Direct Request fixtures cannot observe this browser law.
test('browser completes OAuth consent without leaking a referrer to its callback', async ({ page, request: client }) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  const redirect = 'https://client.example/callback';
  const registration = await client.post('/studio/auth/oauth2/register', { data: { client_name: 'Browser consent', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] } });
  expect(registration.status()).toBe(201);
  const { client_id } = await registration.json();
  const verifier = 'browser-consent-verifier-'.padEnd(64, 'a');
  const challenge = await page.evaluate(async value => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }, verifier);
  await page.route(redirect + '*', route => route.fulfill({ body: 'Client callback' }));
  await page.goto('/studio/auth/oauth2/authorize?' + new URLSearchParams({ client_id, redirect_uri: redirect, response_type: 'code', scope: 'owner:read', resource: 'http://127.0.0.1:8787/api', code_challenge: challenge, code_challenge_method: 'S256', state: 'browser-state' }));
  await expect(page.getByRole('heading', { name: 'Allow Browser consent?' })).toBeVisible();
  const callback = page.waitForRequest(request => request.url().startsWith(redirect));
  await page.getByRole('button', { name: 'allow access', exact: true }).click();
  const request = await callback;
  expect(request.headers()['referer']).toBeUndefined();
  const params = new URL(request.url()).searchParams;
  expect(params.get('state')).toBe('browser-state');
  expect(params.get('code')).toBeTruthy();
  const exchanged = await client.post('/studio/auth/oauth2/token', { form: { grant_type: 'authorization_code', client_id, redirect_uri: redirect, code: params.get('code')!, code_verifier: verifier } });
  expect(exchanged.status()).toBe(200);
});

// Delegated drafts may upload SVG images, but SVG documents must not inherit the
// owner's authority. OWASP treats active same-origin uploads as a script boundary:
// https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
// CSP sandbox removes script execution and the document's same-origin authority:
// https://www.w3.org/TR/CSP3/#directive-sandbox
// This receiving witness first proves draft-only authority cannot edit settings.
// It then loads the uploaded bytes as an image (allowed) and as a document (must
// remain inert). A harmless script marker after the document loads is the security checkpoint;
// checking only a CSP header would not demonstrate browser enforcement.
test('draft-only SVG uploads render as images without borrowing owner authority', async ({ page }) => {
  await page.goto('/studio/login');
  await page.locator('[name="password"]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
  const marker = 'SVG authority probe ' + crypto.randomUUID();
  const minted = await page.evaluate(async name => {
    const response = await fetch('/api/authorizations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, scope: ['owner:draft'], resource: 'api' }) });
    return { status: response.status, body: await response.json() };
  }, marker);
  expect(minted.status).toBe(200);
  const { access_token, authorization } = minted.body;
  const headers = { Authorization: 'Bearer ' + access_token };
  expect((await page.request.patch('/api/settings', { headers, data: { site_title: marker } })).status()).toBe(403);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/><script>document.documentElement.setAttribute('data-script-ran','yes')</script></svg>`;
  const uploaded = await page.request.post('/api/media', { headers, multipart: { file: { name: 'authority.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) } } });
  expect(uploaded.status()).toBe(201);
  const media = await uploaded.json();
  try {
    // Image display must survive the defense; blocking all SVG is not the law.
    const dimensions = await page.evaluate(async url => {
      const image = new Image(); image.src = '/' + url;
      await image.decode(); return [image.naturalWidth, image.naturalHeight];
    }, media.url);
    expect(dimensions).toEqual([40, 40]);
    await page.goto('/' + media.url);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('svg')).not.toHaveAttribute('data-script-ran', 'yes');
  } finally {
    await page.request.delete('/api/media/' + media.id, { headers: { Origin: 'http://127.0.0.1:8787' } });
    await page.request.delete('/api/authorizations/' + authorization.id, { headers: { Origin: 'http://127.0.0.1:8787' } });
  }
});
