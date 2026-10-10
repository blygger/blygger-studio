/** Real browsers and the pinned MCP Inspector exercise disposable Worker routes.
 * The generic confidential client deliberately omits RFC 8707 resource indicators.
 * This is bounded interoperability coverage, not OAuth/OIDC certification. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium, request, type Browser } from '@playwright/test';
import { fixtureCertificate, fixtureIP, startOAuthFixture } from './oauth-interop-fixture.ts';

const inspectorRoot = resolve(process.env.OAUTH_INSPECTOR_ROOT ?? 'build/oauth-inspector/node_modules/@modelcontextprotocol/inspector');
assert.equal(JSON.parse(readFileSync(join(inspectorRoot, 'package.json'), 'utf8')).version, '2.10.1', 'Use the pinned Inspector version');
const directory = mkdtempSync(join(tmpdir(), 'blyg-oauth-interop-'));
console.log('Interop: generating fixture certificate');
const certificate = fixtureCertificate(directory);
const records: object[] = [];
const callbacks = new Map<string, string>();
console.log('Interop: starting browser');
const browser = await chromium.launch({ headless: true });

async function inspector(browser: Browser, fixture: Awaited<ReturnType<typeof startOAuthFixture>>, era: 'modern' | 'legacy', method: 'tools/list' | 'tools/call', label: string) {
  if (!callbacks.has(label)) {
    const reservation = createServer();
    await new Promise<void>(resolvePort => reservation.listen(0, '127.0.0.1', resolvePort));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolvePort => reservation.close(() => resolvePort()));
    callbacks.set(label, `http://127.0.0.1:${port}/oauth/callback`);
  }
  const callback = callbacks.get(label)!;
  const args = [process.execPath, join(inspectorRoot, 'clients/cli/build/index.js'), fixture.mcp, '--transport', 'http', '--protocol-era', era, '--method', method, '--format', 'json', '--callback-url', callback, ...(method === 'tools/call' ? ['--tool-name', 'getSettings'] : []), ...(era === 'legacy' ? ['--stored-auth-only'] : [])];
  // A PTY permits interactive OAuth without opening the host's browser. The
  // test browser completes the real local callback, with no token injection.
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const scriptArgs = process.platform === 'darwin' ? ['-q', '/dev/null', ...args] : ['-q', '-e', '-c', args.map(quote).join(' '), '/dev/null'];
  const child = spawn('script', scriptArgs, { env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate.cert, MCP_STORAGE_DIR: join(directory, label), MCP_INSPECTOR_SECRET_STORE: 'file', MCP_INSPECTOR_SECRET_FILE: join(directory, label + '-secrets.json'), MCP_AUTO_OPEN_ENABLED: 'false', NO_COLOR: '1' }, stdio: ['inherit', 'pipe', 'pipe'] });
  // Register before browser setup: a launcher error can exit immediately.
  const completion = new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
  let output = '', navigationStarted = false;
  let navigation: Promise<void> | undefined;
  const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { 'CF-Connecting-IP': fixtureIP() } });
  const page = await context.newPage();
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    const target = output.match(/Please navigate to: (https:\/\/[^\s\u001b]+)/)?.[1];
    if (!target || navigationStarted) return;
    navigationStarted = true;
    navigation = (async () => {
      assert.equal(new URL(target).origin, fixture.origin, 'Inspector authorization stays on the fixture');
      await page.goto(target);
      await page.locator('[name="password"]').fill('oauth-interop-fixture-password');
      await page.getByRole('button', { name: 'log in', exact: true }).click();
      await page.getByRole('button', { name: 'allow access', exact: true }).click();
      await page.waitForURL(callback + '**');
    })();
    navigation.catch(() => child.kill('SIGTERM'));
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  try {
    const exit = await completion;
    await navigation;
    assert.equal(exit, 0, `Inspector ${label}/${era}/${method} must complete`);
    const line = output.split(/\r?\n/).find(value => value.startsWith('{"result":'));
    assert.ok(line, 'Inspector must return a structured result');
    const result = JSON.parse(line).result;
    if (method === 'tools/list') assert.ok(result.tools.some((tool: { name: string }) => tool.name === 'getSettings'));
    else { assert.notEqual(result.isError, true); assert.ok('site_title' in JSON.parse(result.content[0].text)); }
    records.push({ client: 'MCP Inspector 2.10.1', mount: fixture.mount, era, method, result: 'passed' });
  } finally { clearTimeout(timer); child.kill('SIGTERM'); await context.close(); }
}

async function genericOAuth(fixture: Awaited<ReturnType<typeof startOAuthFixture>>, method: 'client_secret_basic' | 'client_secret_post') {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { 'CF-Connecting-IP': fixtureIP() } });
  // A confidential OAuth client's backchannel does not carry the owner's
  // browser cookies. Keep the client request jar separate from consent.
  const backchannel = await request.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { 'CF-Connecting-IP': fixtureIP() } });
  try {
    const redirect = 'https://oauth-callbacks.cloudflareaccess.com/cdn-cgi/access/outbound-oauth-callback';
    await context.route(redirect + '**', route => route.fulfill({ body: 'Disposable OAuth callback' }));
    const registration = await context.request.post(fixture.issuer + '/oauth2/register', { data: { client_name: 'Generic OAuth interoperability checker', redirect_uris: [redirect], token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access owner:read' } });
    assert.equal(registration.status(), 201);
    const client = await registration.json();
    const verifier = 'oauth-interop-verifier-'.padEnd(64, 'a');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = Buffer.from(digest).toString('base64url');
    const page = await context.newPage();
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: 'openid offline_access owner:read', state: 'interop-state', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256' });
    await page.goto(fixture.issuer + '/oauth2/authorize?' + params);
    await page.locator('[name="password"]').fill('oauth-interop-fixture-password');
    await page.getByRole('button', { name: 'log in', exact: true }).click();
    assert.ok((await page.locator('body').innerText()).includes(fixture.mcp), 'Consent must name the default MCP audience');
    await page.getByRole('button', { name: 'allow access', exact: true }).click();
    await page.waitForURL(redirect + '**');
    const callback = new URL(page.url()); assert.equal(callback.searchParams.get('state'), 'interop-state');
    const exchange = async (form: Record<string, string>) => backchannel.post(fixture.issuer + '/oauth2/token', { form: { ...form, ...(method === 'client_secret_post' ? { client_id: client.client_id, client_secret: client.client_secret } : {}) }, headers: method === 'client_secret_basic' ? { Authorization: 'Basic ' + Buffer.from(encodeURIComponent(client.client_id) + ':' + encodeURIComponent(client.client_secret)).toString('base64') } : {} });
    const response = await exchange({ grant_type: 'authorization_code', code: callback.searchParams.get('code')!, redirect_uri: redirect, code_verifier: verifier });
    assert.equal(response.status(), 200, 'Omitted-resource code exchange must succeed');
    const tokens = await response.json();
    const checkToken = async (token: string) => {
      const denied = await backchannel.get(fixture.origin + '/api/settings', { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(denied.status(), 401, 'Default MCP grant cannot call REST');
      const called = await backchannel.post(fixture.mcp, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': 'tools/call', 'MCP-Name': 'getSettings' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getSettings', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } } });
      assert.equal(called.status(), 200); const value = await called.json(); assert.notEqual(value.result.isError, true);
      assert.ok('site_title' in JSON.parse(value.result.content[0].text));
    };
    await checkToken(tokens.access_token);
    const widened = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: fixture.origin + '/api' });
    assert.equal(widened.status(), 400); assert.equal((await widened.json()).error, 'invalid_target');
    const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(refreshed.status(), 200); const next = await refreshed.json(); assert.ok(next.refresh_token !== tokens.refresh_token, 'Refresh credentials must rotate'); await checkToken(next.access_token);
    records.push({ client: 'Generic OAuth code/refresh without resource', mount: fixture.mount, method, result: 'passed' });
  } finally { await backchannel.dispose(); await context.close(); }
}

try {
  for (const [mount, label] of [['', 'root'], ['/nested/blyg', 'mounted']] as const) {
    console.log('Interop: starting ' + label + ' Worker');
    const fixture = await startOAuthFixture(mount, certificate);
    try {
      console.log('Interop: running ' + label + ' Inspector');
      await inspector(browser, fixture, 'modern', 'tools/list', label);
      await inspector(browser, fixture, 'legacy', 'tools/call', label);
      await genericOAuth(fixture, 'client_secret_basic');
      await genericOAuth(fixture, 'client_secret_post');
    } finally { await fixture.dispose(); }
  }
  console.log('OAuth interoperability: 8 browser/Inspector cases passed');
} finally {
  writeFileSync(resolve('build/oauth-interop-results.json'), JSON.stringify({ records, limits: 'Local fixture interoperability only. No live portal or full OAuth conformance claim.' }, null, 2) + '\n');
  await browser.close(); rmSync(directory, { recursive: true, force: true });
}
