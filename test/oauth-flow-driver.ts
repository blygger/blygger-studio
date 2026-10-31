import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect } from 'vitest';
import { makeApp } from '../src/index.ts';
import { OAuthModel } from './auth-oracle-model.ts';
import { atCheckpoint } from './oracle-campaign.ts';

// Production driver only: register a public client, log in the owner and request
// real consent through makeApp. S256 is constructed from literal verifier bytes.
// The driver parses cookies/handles as opaque data; it does not decode authority.
// OAuthModel receives independent browser labels and selected contract facts.
// Its consent scopes are the default read/draft pair, so suites with other scope
// options use their own literal expectations rather than claiming that model covers
// every supplied scope. HTTP requests here do not emulate browser SameSite/Origin
// behavior; e2e/client-access.spec.ts owns those browser receiving witnesses.
export async function flow(options: { redirect?: string; authorize?: Record<string, string>; scope?: string } = {}) {
  const model = new OAuthModel();
  const app = makeApp('/blyg'), base = 'https://oauth-oracle.example.test', issuer = base + '/blyg/studio/auth';
  const verifier = 'oracle-verifier-that-is-at-least-forty-three-characters';
  const redirect = options.redirect ?? 'https://client.example.test/callback';
  // Each independent browser flow has its own simulated edge IP. Repeated
  // requests within a flow retain it, so limiter bypass is never the oracle.
  const edgeIP = 'fd00:' + crypto.randomUUID().replaceAll('-', '').match(/.{4}/g)!.slice(0, 7).join(':');
  const request = async (path: string, init: RequestInit = {}, bindings = env) => {
    const headers = new Headers(init.headers); headers.set('CF-Connecting-IP', edgeIP);
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(path.startsWith('https:') ? path : base + path, { ...init, headers }), bindings, ctx);
    await waitOnExecutionContext(ctx); return res;
  };
  const login = await request('/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
  const owner = login.headers.get('set-cookie')!.split(';')[0];
  const registered = await request(issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: '<untrusted client>', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  atCheckpoint('OAuth public registration', () => expect(registered.status).toBe(201));
  const client = await registered.json() as { client_id: string };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const authorize = issuer + '/oauth2/authorize?' + new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: redirect, state: 'oracle-state', scope: options.scope ?? 'owner:read owner:draft offline_access', resource: base + '/blyg/api', code_challenge_method: 'S256', code_challenge: challenge, ...options.authorize });
  const consent = await request(authorize, { headers: { cookie: owner } });
  atCheckpoint('OAuth consent is rendered safely', () => { expect(consent.status).toBe(200); expect(consent.headers.get('content-security-policy')).toContain('frame-ancestors'); });
  const html = await consent.text();
  atCheckpoint('OAuth client metadata escaping', () => { expect(html).toContain('&lt;untrusted client&gt;'); expect(html).not.toContain('Allow <untrusted client>'); });
  const handle = html.match(/name="handle" value="([^"]+)"/)![1];
  const binding = consent.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
  model.consent(handle, 'browser-a', ['owner:read', 'owner:draft']);
  const decide = (browser: 'browser-a' | 'browser-b', allow: boolean, origin = base) => request(issuer + '/consent', { method: 'POST', headers: { cookie: owner + (browser === 'browser-a' ? '; ' + binding : ''), Origin: origin }, body: new URLSearchParams([['handle', handle], ['decision', allow ? 'allow' : 'deny'], ['scope', 'owner:read'], ['scope', 'owner:draft']]) });
  const token = (code: string, values: Record<string, string> = {}) => request(issuer + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: redirect, resource: base + '/blyg/api', code_verifier: verifier, ...values }) });
  return { model, base, issuer, verifier, redirect, client, request, owner, binding, handle, decide, token, authorize };
}
