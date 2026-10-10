/** Selected official OIDF 5.3.2 modules for our code + S256 profile.
 * Discovery and the PKCE code flow must pass on root and mounted issuers.
 * Legacy flows without PKCE and full Basic/Dynamic certification are excluded. */
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { fixtureCertificate, fixtureIP, startOAuthFixture } from './oauth-interop-fixture.ts';

const suite = process.env.OIDC_CONFORMANCE_URL ?? 'https://localhost:8443';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(suite).hostname), 'Use the disposable local conformance suite');
const directory = mkdtempSync(join(tmpdir(), 'blyg-oidc-conformance-'));
const certificate = fixtureCertificate(directory);
const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP host.docker.internal 127.0.0.1, MAP localhost.emobix.co.uk 127.0.0.1'] });
const records: object[] = [];

function json(url: string, method = 'GET', body?: unknown): Promise<any> {
  const target = new URL(url);
  assert.ok(['localhost', '127.0.0.1', 'host.docker.internal'].includes(target.hostname), 'Checker HTTP stays local');
  return new Promise((resolveResponse, reject) => {
    const request = https.request(target.href, { method, hostname: target.hostname === 'host.docker.internal' ? 'localhost' : target.hostname, rejectUnauthorized: false, headers: { Host: target.host, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, response => {
      let text = ''; response.on('data', chunk => text += chunk); response.on('end', () => {
        try { assert.ok((response.statusCode ?? 500) < 400, `Checker API HTTP ${response.statusCode}`); resolveResponse(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('Local checker HTTP timeout')));
    request.on('error', reject); if (body !== undefined) request.write(JSON.stringify(body)); request.end();
  });
}
const api = (path: string, method = 'GET', body?: unknown) => json(suite + '/api/' + path, method, body);

async function run(planName: string, config: object, test: string, variant?: object) {
  const plan = await api('plan?' + new URLSearchParams({ planName, ...(variant ? { variant: JSON.stringify(variant) } : {}) }), 'POST', config);
  const module = plan.modules.find((value: { testModule: string }) => value.testModule === test);
  assert.ok(module, `Official suite must contain ${test}`);
  const created = await api('runner?' + new URLSearchParams({ plan: plan.id, test, variant: JSON.stringify(module.variant ?? {}) }), 'POST');
  const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { 'CF-Connecting-IP': fixtureIP() } });
  try {
    const page = await context.newPage(), handled = new Set<string>();
    let info = await api('info/' + created.id);
    if (info.status === 'CONFIGURED') await api('runner/' + created.id, 'POST');
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      info = await api('info/' + created.id);
      if (['FINISHED', 'INTERRUPTED'].includes(info.status)) break;
      const logs = await api('log/' + created.id);
      for (const entry of logs) {
        if (!entry.redirect_to || handled.has(entry._id)) continue;
        handled.add(entry._id);
        assert.equal(new URL(entry.redirect_to).hostname, 'host.docker.internal');
        assert.equal(entry.method, 'GET');
        await page.goto(entry.redirect_to);
        await page.locator('[name="password"]').fill('oauth-interop-fixture-password');
        await page.getByRole('button', { name: 'log in', exact: true }).click();
        await page.getByRole('button', { name: 'allow access', exact: true }).click();
      }
      await new Promise(resolvePoll => setTimeout(resolvePoll, 200));
    }
    const logs = await api('log/' + created.id);
    const findings = logs.filter((entry: any) => ['FAILURE', 'WARNING'].includes(entry.result)).map((entry: any) => ({ condition: entry.src, result: entry.result, message: entry.msg }));
    records.push({ test, version: info.version, status: info.status, result: info.result, findings });
    assert.equal(info.version, '5.3.2', 'Use the pinned conformance suite');
    assert.equal(info.status, 'FINISHED', `${test} must finish`);
    assert.equal(info.result, 'PASSED', `${test}: ${JSON.stringify(findings)}`);
  } finally { await context.close(); }
}

try {
  const readyDeadline = Date.now() + 60000;
  while (true) {
    try { await api('runner/available'); break; }
    catch (error) { if (Date.now() > readyDeadline) throw error; await new Promise(resolveRetry => setTimeout(resolveRetry, 1000)); }
  }
  for (const mount of ['', '/nested/blyg']) {
    const fixture = await startOAuthFixture(mount, certificate);
    try {
      const external = fixture.origin.replace('localhost', 'host.docker.internal');
      const server = { discoveryUrl: external + mount + '/studio/auth/.well-known/openid-configuration' };
      await run('oidcc-config-certification-test-plan', { alias: 'blyg-discovery-' + crypto.randomUUID().slice(0, 8), server }, 'oidcc-discovery-endpoint-verification');
      const alias = 'blyg-pkce-' + crypto.randomUUID().slice(0, 8);
      const callback = 'https://localhost.emobix.co.uk:8443/test/a/' + alias + '/callback';
      const client = await json(external + mount + '/studio/auth/oauth2/register', 'POST', { client_name: 'OpenID conformance fixture', redirect_uris: [callback], token_endpoint_auth_method: 'client_secret_basic', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid owner:read offline_access' });
      // The OP is an owner-access server, so the suite requests its supported
      // owner scope alongside openid. Resource remains omitted by the suite.
      await run('oidcc-basic-certification-test-plan', { alias, server, client: { client_id: client.client_id, client_secret: client.client_secret, override_openid_scope: 'openid owner:read' } }, 'oidcc-ensure-request-with-valid-pkce-succeeds', { server_metadata: 'discovery', client_registration: 'static_client' });
    } finally { await fixture.dispose(); }
  }
  console.log('OpenID conformance: 4 selected discovery/PKCE modules passed');
} finally {
  writeFileSync(resolve('build/oidc-conformance-results.json'), JSON.stringify({ records, limits: 'Selected OIDF modules only. No full Basic/Dynamic certification or live TLS/portal claim.' }, null, 2) + '\n');
  await browser.close(); rmSync(directory, { recursive: true, force: true });
}
