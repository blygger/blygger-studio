/**
 * Replay must be visible across isolates before paused issuance can return.
 * RFC9700 §4.14.2 motivates family replay detection:
 * https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2
 * Blygger additionally denies existing signed access and pending issuance.
 * Model: after replay settles, both isolates deny the compromised grant.
 * Both isolates use the same grantId; shared D1 is the cross-isolate boundary.
 * History grammar: A claims native rotation; B replays; B reads; A resumes; A reads.
 * Driver: two compiled workerd isolates sharing D1. A test-only service gate pauses
 * outside the completed native atomic claim, before successor insertion.
 * Refinement: assert the gate was reached, replay invalid_grant, API401 in both
 * isolates and resumed issuance invalid_grant. A timeout is not a security failure.
 * Modes add individual/all owner revocation at the same native claim checkpoint.
 * Both must invalidate prior access and refuse paused successor issuance.
 * Limits: one controlled checkpoint per mode, not all distributed schedules or a proof that
 * native multi-call cleanup is transactional. No second same-client grant is
 * present, so this witness makes no cross-grant refresh isolation claim.
 * No gate enters the release Worker.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { URLSearchParams } from 'node:url';

// Two real workerd isolates share D1. A test-only service binding controls the
// native rotation checkpoint. No production deployment, credentials or sleeps.
const mode = process.argv[2] ?? 'replay';
if (!['replay', 'revoke', 'revoke-all'].includes(mode)) throw new Error('Unknown race mode');
let reached!: () => void, release!: () => void;
const claimed = new Promise<void>(resolve => { reached = resolve; });
const resume = new Promise<void>(resolve => { release = resolve; });
const output = await build({ entryPoints: ['test/security-race-worker.ts'], bundle: true, platform: 'neutral', conditions: ['workerd'], external: ['cloudflare:*', 'node:*'], mainFields: ['module', 'main'], format: 'esm', target: 'es2022', loader: { '.txt': 'text' }, write: false });
const workers = ['auth-a', 'auth-b'].map(name => ({ name, routes: ['race-oracle.example.test/*'], modules: [{ type: 'ESModule' as const, path: 'worker.mjs', contents: output.outputFiles[0].text }], compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], bindings: { MOUNT: '/blyg', OWNER_PASSWORD: 'security-race-fixture-password', COOKIE_SECRET: 'security-race-fixture-secret-32-characters' }, d1Databases: { DB: 'shared-security-race' }, r2Buckets: { MEDIA: 'shared-media' }, outboundService: () => new Response(null, { status: 503 }), serviceBindings: { ORACLE_GATE: async () => { reached(); await resume; return new Response('released'); } } }));
const mf = new Miniflare(convertV4MiniflareOptions({ workers }));
let pending: ReturnType<Awaited<ReturnType<typeof mf.getWorker>>['fetch']> | undefined;
try {
  const db = await mf.getD1Database('DB', 'auth-a');
  for (const migration of await readD1Migrations('migrations')) await db.batch(migration.queries.map(sql => db.prepare(sql)));
  const [a, b] = await Promise.all([mf.getWorker('auth-a'), mf.getWorker('auth-b')]);
  const origin = 'https://race-oracle.example.test', redirect = 'https://client.example/callback';
  const request = (worker: typeof a, path: string, init: NonNullable<Parameters<typeof a.fetch>[1]> = {}) => worker.fetch(origin + path, { ...init, redirect: 'manual' as const, headers: { Accept: 'text/html', 'CF-Connecting-IP': '198.51.100.244', ...Object.fromEntries(new Headers(init.headers as HeadersInit)) } });
  const login = await request(a, '/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: 'security-race-fixture-password' }) });
  assert.equal(login.status, 302); const owner = login.headers.get('set-cookie')!.split(';')[0];
  const registered = await request(a, '/blyg/studio/auth/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Race oracle', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  assert.equal(registered.status, 201); const { client_id } = await registered.json() as { client_id: string };
  const verifier = 'controlled-security-race-verifier-'.padEnd(64, 'a');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = Buffer.from(digest).toString('base64url');
  let consent = await request(a, '/blyg/studio/auth/oauth2/authorize?' + new URLSearchParams({ client_id, response_type: 'code', redirect_uri: redirect, scope: 'owner:read offline_access', resource: origin + '/api', code_challenge_method: 'S256', code_challenge: challenge }), { headers: { cookie: owner } });
  const nativeCookies = consent.headers.getSetCookie().map(value => value.split(';')[0]);
  if (consent.headers.get('content-type')?.includes('application/json')) {
    // Service fetch negotiation returns the native continuation as JSON. Follow
    // its signed query unchanged with the real owner/native cookie binding.
    const continuation = await consent.clone().json() as { redirect: boolean; url: string };
    const url = new URL(continuation.url);
    assert.equal(continuation.redirect, true); assert.equal(url.origin, origin); assert.equal(url.pathname, '/blyg/studio/auth/consent');
    const cookies = consent.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    consent = await request(a, url.pathname + url.search, { headers: { cookie: owner + '; ' + cookies } });
  }
  assert.equal(consent.status, 200); const html = await consent.text();
  const match = html.match(/name="handle" value="([^"]+)"/);
  assert.ok(match, 'Expected consent form, got ' + consent.headers.get('content-type') + ' / ' + (html.startsWith('{') ? Object.keys(JSON.parse(html)).join(',') : html.match(/<title>([^<]+)<\/title>/)?.[1]));
  const handle = match[1];
  const binding = [...nativeCookies, ...consent.headers.getSetCookie().map(value => value.split(';')[0])].join('; ');
  const approval = await request(a, '/blyg/studio/auth/consent', { method: 'POST', headers: { cookie: owner + '; ' + binding, Origin: origin }, body: new URLSearchParams({ handle, decision: 'allow', scope: 'owner:read' }) });
  assert.equal(approval.status, 302, 'Owner consent: ' + (approval.status === 302 ? 'approved' : (await approval.clone().json() as { error?: string }).error)); const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
  const issuance = await request(a, '/blyg/studio/auth/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id, redirect_uri: redirect, resource: origin + '/api', code_verifier: verifier }) });
  assert.equal(issuance.status, 200); const tokens = await issuance.json() as { access_token: string; refresh_token: string };
  const refresh = (worker: typeof a, gated = false) => request(worker, '/blyg/studio/auth/oauth2/token', { method: 'POST', headers: gated ? { 'x-oracle-gate': 'claimed' } : {}, body: new URLSearchParams({ grant_type: 'refresh_token', client_id, refresh_token: tokens.refresh_token, resource: origin + '/api' }) });
  pending = refresh(a, true);
  const rotation = pending;
  // Fail on an absent seam rather than inventing evidence from a timeout.
  await Promise.race([claimed, rotation.then(() => { throw new Error('Rotation did not reach its controlled checkpoint'); })]);
  console.log('Reached native rotation claim in isolate A');
  if (mode === 'replay') {
    const replay = await refresh(b); assert.equal(replay.status, 400);
    assert.equal((await replay.json() as { error: string }).error, 'invalid_grant');
  } else {
    const listing = await request(b, '/api/authorizations', { headers: { cookie: owner } });
    assert.equal(listing.status, 200);
    const grants = await listing.json() as { items: { id: string; clientId: string }[] };
    const grant = grants.items.find(value => value.clientId === client_id);
    assert.ok(grant, 'Issued grant must be listed before owner revocation');
    const path = '/api/authorizations' + (mode === 'revoke' ? '/' + encodeURIComponent(grant.id) : '');
    const revoked = await request(b, path, { method: 'DELETE', headers: { cookie: owner } });
    assert.equal(revoked.status, 200);
  }
  const dead = await request(b, '/api/settings', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
  assert.equal(dead.status, 401, 'Cross-isolate replay must revoke the existing signed access token');
  release(); const winner = await rotation;
  assert.equal(winner.status, 400, 'Paused issuance must not return usable credentials after family revocation');
  assert.equal((await winner.json() as { error: string }).error, 'invalid_grant');
  const observer = await request(a, '/api/settings', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
  assert.equal(observer.status, 401);
  console.log('Controlled cross-isolate ' + mode + ' denies prior access and pending issuance');
} finally {
  release();
  if (pending) await pending.catch(() => undefined);
  await mf.dispose();
}
