/**
 * Public protocol validation must preserve the client's bindings and the owner's
 * intent. Broad failure assertions can hide a wrong redirect or leaked credential.
 *
 * Contract sources are separate from local choices:
 * - RFC6749 §4.1/§5: redirects, code exchange, refresh and token response errors.
 *   https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1
 *   https://www.rfc-editor.org/rfc/rfc6749.html#section-5
 * - RFC6750 §3: Bearer challenge grammar and insufficient scope.
 *   https://www.rfc-editor.org/rfc/rfc6750.html#section-3
 * - RFC7591 §2/§3.2.1: client metadata and authoritative registration results.
 *   https://www.rfc-editor.org/rfc/rfc7591.html#section-2
 * - OIDC Core: prompt, max_age, auth_time and offline consent.
 *   https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest
 *   https://openid.net/specs/openid-connect-core-1_0.html#OfflineAccess
 * Model: independent literal protocol relations; there is no general provider clone.
 * History grammar: fixed valid/invalid neighbors for callbacks, unknown parameters,
 * parallel exchanges, scope/resource/client binding, challenge syntax, signed-token
 * mutation, registration defaults and password reauthentication continuations.
 * Driver: flow through real Worker routes; fake Date controls authentication age.
 * Refinement: exact callback fields, error/token bodies, cache headers, challenges,
 * owner-page resources and authentication claims after each completed response.
 * Concurrent exchange permits at most one winner; this is a safety witness, not
 * an exhaustive scheduler. Token signature corruption must reach a protected route.
 * Limits: these cases do not certify every normative clause. Source-to-gap records
 * live in docs/oauth-protocol-hardening.md. Mounted resource metadata does not
 * establish the deferred RFC9728 host-root publication requirement.
 */
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { flow } from './oauth-flow-driver.ts';

// OAuth/OIDC AS duties from the frozen RFC source ledger. Fixed bounded cases,
// real Worker routes, literal outcomes; this is not complete protocol conformance.
async function approved(options: Parameters<typeof flow>[0] = {}) {
  const f = await flow(options), accepted = await f.decide('browser-a', true);
  expect(accepted.status).toBe(302);
  const callback = new URL(accepted.headers.get('location')!);
  expect(callback.searchParams.get('error'), callback.searchParams.get('error_description') ?? '').toBeNull();
  const code = callback.searchParams.get('code'); expect(code).toBeTruthy();
  return { ...f, code: code! };
}
async function authorizationError(response: Response, f: Awaited<ReturnType<typeof flow>>, error?: string) {
  const location = response.headers.get('location');
  if (location) {
    const url = new URL(location, f.base);
    expect(url.origin + url.pathname).toBe(new URL(f.redirect).origin + new URL(f.redirect).pathname);
    const params = url.search ? url.searchParams : new URLSearchParams(url.hash.slice(1));
    expect(params.get('state')).toBe('oracle-state');
    expect(params.has('code')).toBe(false);
    expect(params.get('error')).toEqual(error ?? expect.any(String));
  } else {
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toEqual(error ?? expect.any(String));
  }
}
const authorize = (f: Awaited<ReturnType<typeof flow>>, mutate: (url: URL) => void, cookie = f.owner) => {
  const url = new URL(f.authorize); mutate(url);
  return f.request(url.href, { headers: cookie ? { cookie } : {} });
};

describe('OAuth public validation oracles', () => {
  it.each(['https://evil.example/callback', 'https://client.example.test/callback/', 'https://CLIENT.example.test/callback', 'https://client.example.test/callback?changed=1'])('does not redirect an authorization to unregistered exact URI %s', async redirect => {
    const f = await flow();
    const response = await authorize(f, url => url.searchParams.set('redirect_uri', redirect));
    const location = response.headers.get('location');
    if (location) { const target = new URL(location, f.base); expect(target.origin).toBe(f.base); expect(target.searchParams.has('code')).toBe(false); }
    else expect(response.status).toBe(400);
  });
  // The callback is an exact binding, not merely a trusted origin. Preserve the
  // registered query and opaque state while adding protocol fields. Avoid307 because
  // it can forward the incoming method/body (RFC9700 §4.12):
  // https://www.rfc-editor.org/rfc/rfc9700.html#section-4.12
  it('retains query parameters and exact state in a registered callback, without 307', async () => {
    const f = await flow({ redirect: 'https://client.example.test/callback?keep=a%2Bb&empty=' });
    const response = await f.decide('browser-a', true), url = new URL(response.headers.get('location')!);
    expect(response.status).toBe(302);
    expect(url.searchParams.get('keep')).toBe('a+b'); expect(url.searchParams.has('empty')).toBe(true);
    expect(url.searchParams.get('state')).toBe('oracle-state'); expect(url.searchParams.get('code')).toBeTruthy();
  });
  it.each(['/relative', 'https://client.example.test/callback#fragment', 'http://remote.example/callback'])('rejects invalid remote registered redirect %s', async redirect => {
    const f = await flow();
    const response = await f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_redirect_uri' });
  });
  it('requires owner authentication before producing consent for a registered client', async () => {
    const f = await flow(), response = await authorize(f, () => {}, '');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!, f.base);
    expect(location.origin).toBe(f.base); expect(location.pathname).toBe('/blyg/studio/login');
  });
  it.each(['response_type', 'client_id', 'code_challenge'])('treats missing and empty authorization %s alike', async field => {
    const f = await flow();
    for (const value of [undefined, '']) {
      const response = await authorize(f, url => value === undefined ? url.searchParams.delete(field) : url.searchParams.set(field, value));
      if (field === 'client_id') { const location = response.headers.get('location'); if (location) expect(new URL(location, f.base).origin).toBe(f.base); else expect(response.status).toBe(400); }
      else await authorizationError(response, f, 'invalid_request');
    }
  });
  it.each(['response_type', 'client_id', 'code_challenge'])('rejects duplicate authorization %s', async field => {
    const f = await flow();
    const response = await authorize(f, url => url.searchParams.append(field, url.searchParams.get(field)!));
    if (field === 'client_id' && response.headers.get('location')) { const location = new URL(response.headers.get('location')!, f.base); expect(location.origin).toBe(f.base); expect(location.searchParams.has('code')).toBe(false); }
    else await authorizationError(response, f, 'invalid_request');
  });
  it('ignores unknown authorization and token parameters', async () => {
    const f = await flow({ authorize: { unknown_oracle_extension: 'ignored' } });
    const response = await f.decide('browser-a', true), code = new URL(response.headers.get('location')!).searchParams.get('code')!;
    expect((await f.token(code, { unknown_oracle_extension: 'ignored' })).status).toBe(200);
  });
  it.each(['token', 'id_token', 'nonsense'])('rejects unsupported authorization response_type %s', async responseType => {
    const f = await flow();
    await authorizationError(await authorize(f, url => url.searchParams.set('response_type', responseType)), f, 'unsupported_response_type');
  });
  it.each(['plain', 'unsupported', ''])('does not silently downgrade S256 to method %s', async method => {
    const f = await flow();
    await authorizationError(await authorize(f, url => method ? url.searchParams.set('code_challenge_method', method) : url.searchParams.delete('code_challenge_method')), f, 'invalid_request');
  });
  it.each(['grant_type', 'code', 'client_id', 'code_verifier'])('rejects empty token %s without minting credentials', async field => {
    const f = await approved(), response = await f.token(f.code, { [field]: '' });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; access_token?: string };
    expect(body.error).toBeTruthy(); expect(body.access_token).toBeUndefined();
  });
  it.each(['grant_type', 'code', 'client_id', 'code_verifier'])('rejects duplicate token %s', async field => {
    const f = await approved();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: f.code, client_id: f.client.client_id, redirect_uri: f.redirect, resource: f.base + '/blyg/api', code_verifier: f.verifier });
    body.append(field, body.get(field)!);
    const response = await f.request(f.issuer + '/oauth2/token', { method: 'POST', body });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });
  it('rejects an unknown code with invalid_grant', async () => {
    const f = await flow(), response = await f.token('unknown-oracle-code');
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });
  it.each([599, 600, 601])('checks the native short-code lifetime at age %s seconds', async age => {
    const now = Math.floor(Date.now() / 1000) * 1000; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    try {
      const f = await approved(); vi.setSystemTime(now + age * 1000);
      const response = await f.token(f.code);
      expect(response.status).toBe(age <= 600 ? 200 : 400);
      if (age === 601) expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
    } finally { vi.useRealTimers(); }
  });
  it('permits at most one concurrent exchange of the same code', async () => {
    const f = await approved(), responses = await Promise.all([f.token(f.code), f.token(f.code)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
    expect(await responses.find(response => response.status === 400)!.json()).toMatchObject({ error: 'invalid_grant' });
  });
  it.each(['/relative', 'https://oauth-oracle.example.test/blyg/api#fragment', 'https://foreign.example/api'])('does not grant malformed or foreign resource %s', async resource => {
    const f = await flow(); await authorizationError(await authorize(f, url => url.searchParams.set('resource', resource)), f);
  });
  it('preserves refresh scope on omission and rejects a new audience or client', async () => {
    const f = await approved(), initial = await (await f.token(f.code)).json() as { refresh_token: string; scope: string };
    const refresh = (fields: Record<string, string> = {}) => f.request(f.issuer + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: initial.refresh_token, resource: f.base + '/blyg/api', ...fields }) });
    const response = await refresh(); expect(response.status).toBe(200);
    expect((await response.json() as { scope: string }).scope.split(' ').sort()).toEqual(initial.scope.split(' ').sort());
    const wrongAudience = await refresh({ resource: f.base + '/blyg/studio/mcp' }); expect(wrongAudience.status).toBe(400);
    const other = await flow(); const wrongClient = await refresh({ client_id: other.client.client_id }); expect(wrongClient.status).toBe(400);
  });
  it.each([3599, 3600])('checks OAuth-issued access at age %s seconds', async age => {
    const now = Math.floor(Date.now() / 1000) * 1000; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    try {
      const f = await approved(), tokens = await (await f.token(f.code)).json() as { access_token: string };
      vi.setSystemTime(now + age * 1000);
      const response = await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
      expect(response.status).toBe(age === 3599 ? 200 : 401);
    } finally { vi.useRealTimers(); }
  });
  it.each([2591999, 2592000])('checks the fixed thirty-day OAuth grant at age %s seconds', async age => {
    const now = Math.floor(Date.now() / 1000) * 1000; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    try {
      const f = await approved(), tokens = await (await f.token(f.code)).json() as { refresh_token: string };
      vi.setSystemTime(now + age * 1000);
      const response = await f.request(f.issuer + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: f.client.client_id, resource: f.base + '/blyg/api' }) });
      expect(response.status).toBe(age === 2591999 ? 200 : 400);
      if (age === 2592000) expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
    } finally { vi.useRealTimers(); }
  });
  it('keeps exact state on consent denial without forwarding owner credentials', async () => {
    const f = await flow(), response = await f.decide('browser-a', false);
    expect(response.status).not.toBe(307);
    const callback = new URL(response.headers.get('location')!);
    expect(callback.searchParams.get('state')).toBe('oracle-state'); expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.has('password')).toBe(false); expect(callback.searchParams.has('code')).toBe(false);
  });
  it.each(['<script>alert(1)</script>', 'e\u0301é + %'])('echoes exact escaped state %s', async state => {
    const f = await flow({ authorize: { state } }), response = await f.decide('browser-a', true);
    expect(new URL(response.headers.get('location')!).searchParams.get('state')).toBe(state);
  });
  it('does not expose the PKCE challenge in the issued code', async () => {
    const f = await approved(), challenge = new URL(f.authorize).searchParams.get('code_challenge')!;
    expect(f.code.includes(challenge)).toBe(false);
  });
  it('returns typed token fields with both sensitive-response cache headers', async () => {
    const f = await approved(), response = await f.token(f.code), body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/json');
    expect(typeof body.access_token).toBe('string'); expect(typeof body.refresh_token).toBe('string'); expect(typeof body.expires_in).toBe('number');
    expect(String(body.token_type).toLowerCase()).toBe('bearer');
    expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('pragma')).toBe('no-cache');
  });
  it('rejects a mutated production access-token signature before returning protected data', async () => {
    const f = await approved(), response = await f.token(f.code), tokens = await response.json() as { access_token: string };
    const parts = tokens.access_token.split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    const bad = await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + parts.join('.') } });
    expect(bad.status).toBe(401); expect(await bad.json()).not.toHaveProperty('site_title');
  });
  it('uses syntactically valid, nonduplicated Bearer challenge attributes for missing, invalid and insufficient credentials', async () => {
    const f = await approved(), tokens = await (await f.token(f.code)).json() as { access_token: string };
    const cases: [string, RequestInit, number][] = [
      ['/blyg/api/settings', {}, 401],
      ['/blyg/api/settings', { headers: { Authorization: 'Bearer bad-oracle-token' } }, 401],
      ['/blyg/api/items/missing/publish', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.access_token, 'Content-Type': 'application/json' }, body: '{}' }, 403],
    ];
    for (const [path, init, status] of cases) {
      const response = await f.request(path, init); expect(response.status).toBe(status);
      const header = response.headers.get('www-authenticate')!; expect(header.startsWith('Bearer ')).toBe(true);
      const attributes = [...header.matchAll(/([a-z_]+)="([^"\\]*)"/g)];
      const names = attributes.map(match => match[1]); expect(new Set(names).size).toBe(names.length);
      for (const [, name, value] of attributes) { expect(/^[\x20-\x7E]*$/.test(value)).toBe(true); if (name === 'resource_metadata') expect(new URL(value).origin).toBe(f.base); }
      if (status === 403) expect(header).toContain('error="insufficient_scope"');
      if (!init.headers) expect(header).not.toContain('error=');
    }
  });
  it('keeps authorization-page resources on the owner origin', async () => {
    const f = await flow(), response = await f.request(f.authorize, { headers: { cookie: f.owner } });
    const html = await response.text();
    for (const [, value] of html.matchAll(/(?:href|src)="([^"]+)"/g)) expect(new URL(value, f.base).origin).toBe(f.base);
  });
  it('publishes explicit protected resource metadata fields', async () => {
    const f = await flow();
    for (const [name, expected] of [['api', f.base + '/blyg/api'], ['mcp', f.base + '/blyg/studio/mcp']]) {
      const response = await f.request(f.issuer + '/resources/' + name); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ resource: expected, authorization_servers: [f.issuer], scopes_supported: expect.arrayContaining(['owner:read']), bearer_methods_supported: ['header'] });
    }
  });
  it('does not display a login page for unauthenticated prompt=none', async () => {
    const f = await flow({ scope: 'openid owner:read owner:draft' });
    const response = await authorize(f, url => url.searchParams.set('prompt', 'none'), '');
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get('location')!, f.base);
    expect(callback.origin).toBe(new URL(f.redirect).origin); expect(callback.searchParams.get('error')).toBe('login_required');
    expect(callback.searchParams.get('state')).toBe('oracle-state');
  });
  it('accepts unknown DCR metadata and returns authoritative registered defaults', async () => {
    const f = await flow();
    const response = await f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [f.redirect], token_endpoint_auth_method: 'none', unknown_oracle_metadata: 'ignored' }) });
    expect(response.status).toBe(201); expect(response.headers.get('content-type')).toContain('application/json');
    const client = await response.json() as Record<string, any>;
    expect(client.client_id).toBeTruthy(); expect(client.client_id).not.toBe(f.client.client_id);
    expect(client.redirect_uris).toEqual([f.redirect]); expect(client.token_endpoint_auth_method).toBe('none');
    expect(client.grant_types).toEqual(['authorization_code']); expect(client.response_types).toEqual(['code']);
  });
  it('uses the confidential client authentication default when DCR omits that field', async () => {
    const f = await flow();
    const response = await f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [f.redirect] }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ token_endpoint_auth_method: 'client_secret_basic', grant_types: ['authorization_code'], response_types: ['code'] });
  });
  it.each(['display', 'ui_locales', 'claims_locales', 'acr_values'])('accepts OIDC advisory %s without demanding unsupported profiles', async field => {
    const f = await flow({ scope: 'openid owner:read owner:draft' });
    const value = field === 'display' ? 'page' : field === 'acr_values' ? 'urn:oracle:unsupported-acr' : 'en';
    const response = await authorize(f, url => url.searchParams.set(field, value));
    expect(response.status).toBe(200);
  });
  it.each(['none', 'login', 'none login'])('honors OIDC prompt %s rather than displaying ordinary consent', async prompt => {
    const f = await flow({ scope: 'openid owner:read owner:draft' });
    const response = await authorize(f, url => url.searchParams.set('prompt', prompt));
    if (prompt === 'none') { expect(response.status).toBe(302); const location = new URL(response.headers.get('location')!); expect(location.origin).toBe(new URL(f.redirect).origin); expect(location.searchParams.get('error')).toBe('consent_required'); }
    else if (prompt === 'login') { expect(response.status).toBe(302); expect(new URL(response.headers.get('location')!, f.base).pathname).toBe('/blyg/studio/login'); }
    else await authorizationError(response, f, 'invalid_request');
  });
  it('does not refresh owner authentication age merely by recreating a provider bridge', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    try {
      const f = await flow({ scope: 'openid owner:read owner:draft' });
      vi.setSystemTime(now + 2000);
      const response = await authorize(f, url => url.searchParams.set('max_age', '1'), f.owner + '; ' + f.binding);
      expect(response.status).toBe(302); expect(new URL(response.headers.get('location')!, f.base).pathname).toBe('/blyg/studio/login');
    } finally { vi.useRealTimers(); }
  });
  it('includes the owner authentication time when an OIDC request makes it essential', async () => {
    const f = await approved({ scope: 'openid owner:read owner:draft', authorize: { claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }) } });
    const tokens = await (await f.token(f.code)).json() as { id_token: string };
    const payload = JSON.parse(atob(tokens.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(typeof payload.auth_time).toBe('number'); expect(payload.auth_time).toBeLessThanOrEqual(payload.iat);
  });
  it('explains offline access visibly before asking the owner to grant it', async () => {
    const f = await flow({ scope: 'openid offline_access owner:read owner:draft' });
    const response = await f.request(f.authorize, { headers: { cookie: f.owner } });
    const visible = (await response.text()).replace(/<input[^>]*>/g, '').replace(/<[^>]*>/g, ' ');
    expect(visible).toMatch(/offline|when you are away|when you are not using/i);
  });
  it.each(['login', 'max_age'])('completes password reauthentication and resumes the pending OIDC %s request', async mode => {
    const f = await flow({ scope: 'openid owner:read owner:draft' });
    const cookie = f.owner + '; ' + f.binding;
    const response = await authorize(f, url => mode === 'login' ? url.searchParams.set('prompt', 'login') : url.searchParams.set('max_age', '0'), cookie);
    expect(response.status).toBe(302);
    const loginURL = new URL(response.headers.get('location')!, f.base);
    expect(loginURL.pathname).toBe('/blyg/studio/login');
    const page = await f.request(loginURL.href, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text(); expect(html).toContain('type="password"');
    const returnTo = html.match(/name="return_to" value="([^"]+)"/)?.[1].replaceAll('&amp;', '&');
    expect(returnTo).toBeTruthy();
    const fields = new URLSearchParams({ password: env.OWNER_PASSWORD, return_to: returnTo! });
    for (const [input] of html.matchAll(/<input[^>]*>/g)) {
      if (!input.includes('type="hidden"')) continue;
      const name = input.match(/name="([^"]+)"/)?.[1], value = input.match(/value="([^"]*)"/)?.[1];
      if (name && value !== undefined) fields.set(name, value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'"));
    }
    const posted = await f.request('/blyg/studio/login', { method: 'POST', headers: { cookie, Origin: f.base }, body: fields });
    expect(posted.status).toBe(302);
    const cookies = new Map(cookie.split('; ').map(value => [value.split('=')[0], value]));
    for (const value of posted.headers.getSetCookie()) { const entry = value.split(';')[0]; cookies.set(entry.split('=')[0], entry); }
    const resumed = await f.request(new URL(posted.headers.get('location')!, f.base).href, { headers: { cookie: [...cookies.values()].join('; ') } });
    expect(resumed.status).toBe(200);
    const consent = await resumed.text(); expect(consent).toContain('Allow');
    const handle = consent.match(/name="handle" value="([^"]+)"/)?.[1]; expect(handle).toBeTruthy();
    for (const value of resumed.headers.getSetCookie()) { const entry = value.split(';')[0]; cookies.set(entry.split('=')[0], entry); }
    const decision = await f.request(f.issuer + '/consent', { method: 'POST', headers: { cookie: [...cookies.values()].join('; '), Origin: f.base }, body: new URLSearchParams([['handle', handle!], ['decision', 'allow'], ['scope', 'owner:read'], ['scope', 'owner:draft']]) });
    expect(decision.status).toBe(302);
    const callback = new URL(decision.headers.get('location')!); expect(callback.searchParams.get('state')).toBe('oracle-state');
    expect(callback.searchParams.get('error')).toBeNull(); expect(callback.searchParams.get('code')).toBeTruthy();
    expect((await f.token(callback.searchParams.get('code')!)).status).toBe(200);
  });
  // OIDC max_age and prompt=login concern a password authentication event.
  // Following only the GET redirect would miss a broken password POST continuation.
  // These witnesses complete login, native continuation, consent and code exchange;
  // rebuilding a provider session is not a fresh password check.
  it('requires reauthentication for max_age=0 despite an existing owner session', async () => {
    const f = await flow({ scope: 'openid owner:read owner:draft' });
    const response = await authorize(f, url => url.searchParams.set('max_age', '0'));
    expect(response.status).toBe(302); expect(new URL(response.headers.get('location')!, f.base).pathname).toBe('/blyg/studio/login');
  });
});
