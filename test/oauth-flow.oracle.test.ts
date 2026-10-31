/**
 * Consent belongs to one browser, and a code belongs to one exchange binding.
 * Testing only the happy path misses foreign-browser approval and credential replay.
 *
 * Contract: OAuth code binding and one-use codes (RFC6749 §4.1.2/§4.1.3), S256
 * proof (RFC7636 §4.6), and selected resource (RFC8707 §2):
 * https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.2
 * https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.3
 * https://www.rfc-editor.org/rfc/rfc7636.html#section-4.6
 * https://www.rfc-editor.org/rfc/rfc8707.html#section-2
 * Blygger's consent handle lasts600 seconds. Its zero-grace replay policy revokes
 * the whole grant, including signed access tokens; that is local policy.
 * Model: OAuthModel retains browser, use, deadline and exact exchange bindings.
 * History grammar: fixed foreign-browser/origin decisions, allow/deny/reuse,
 * one-field exchange substitutions, refresh ancestry and the exact consent deadline.
 * Driver: flow drives real registration, owner login, consent, token and API routes.
 * Refinement: completed redirects retain callback/state/issuer; rejected exchanges
 * issue no access token. Refresh rotation and later API401 are distinct checkpoints.
 * Limits: fixed witnesses are not random grammar coverage or exhaustive concurrency.
 * The replay history uses one grant. It proves denial of that grant, not that
 * another same-client grant retains refresh access after native replay cleanup.
 */
import { describe, expect, it, vi } from 'vitest';
import { flow } from './oauth-flow-driver.ts';
import { atCheckpoint } from './oracle-campaign.ts';

describe('OAuth protocol oracles', () => {
  it('binds consent to the browser and consumes approval once', async () => {
    const f = await flow();
    const wrong = await f.decide('browser-b', true);
    atCheckpoint('OAuth consent browser binding', () => expect(wrong.status).toBe(f.model.decide(f.handle, 'browser-b', true) === 'rejected' ? 400 : 302));
    const approved = await f.decide('browser-a', true);
    expect(f.model.decide(f.handle, 'browser-a', true)).toBe('code');
    atCheckpoint('OAuth approval redirect', () => { expect(approved.status).toBe(302); const url = new URL(approved.headers.get('location')!); expect(url.origin + url.pathname).toBe(f.redirect); expect(url.searchParams.get('state')).toBe('oracle-state'); expect(url.searchParams.get('iss')).toBe(f.issuer); });
    atCheckpoint('OAuth consent single use', () => expect((f.model.decide(f.handle, 'browser-a', true))).toBe('rejected'));
    expect((await f.decide('browser-a', true)).status).toBe(400);
  });
  it('denies without minting a code, and rejects cross-site consent', async () => {
    const f = await flow();
    expect((await f.decide('browser-a', true, 'https://attacker.example.test')).status).toBe(403);
    const denied = await f.decide('browser-a', false);
    expect(f.model.decide(f.handle, 'browser-a', false)).toBe('denied');
    atCheckpoint('OAuth denial is not authorization', () => { const location = new URL(denied.headers.get('location')!); expect(location.searchParams.get('error')).toBe('access_denied'); expect(location.searchParams.has('code')).toBe(false); });
  });
  it.each(['code_verifier', 'redirect_uri', 'resource', 'client_id'])('rejects mismatched %s at code exchange', async field => {
    const f = await flow();
    const approved = await f.decide('browser-a', true);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    f.model.codes.set(code, { verifier: f.verifier, client: f.client.client_id, redirect: f.redirect, resource: 'api', used: false, expires: 600 });
    // Use a registered foreign client to reach code binding rather than fail
    // earlier at the provider's client authentication check.
    let wrong = 'wrong-input';
    if (field === 'client_id') {
      wrong = (await flow()).client.client_id;
    } else if (field === 'resource') {
      wrong = f.base + '/blyg/studio/mcp';
    } else if (field === 'redirect_uri') {
      wrong = 'https://wrong.example.test/callback';
    }
    const expected = f.model.exchange(code, field === 'code_verifier' ? wrong : f.verifier, field === 'client_id' ? wrong : f.client.client_id, field === 'redirect_uri' ? wrong : f.redirect, field === 'resource' ? 'mcp' : 'api');
    expect(expected).toBe('rejected');
    const res = await f.token(code, { [field]: wrong });
    const error = await res.clone().json();
    atCheckpoint('OAuth code binding', () => expect(res.status, JSON.stringify(error)).toBe(400));
    expect((await res.json() as { access_token?: string }).access_token).toBeUndefined();
  });
  it('rejects an unknown client before exchanging a code', async () => {
    const f = await flow();
    const approved = await f.decide('browser-a', true);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const response = await f.token(code, { client_id: 'unknown-client' });
    const body = await response.json() as { error: string; access_token?: string; refresh_token?: string };
    atCheckpoint('OAuth unknown client authentication', () => {
      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
      expect(body.access_token).toBeUndefined();
      expect(body.refresh_token).toBeUndefined();
    });
  });
  it('exchanges a code once, rotates refresh credentials, and keeps the selected audience', async () => {
    const f = await flow();
    const approved = await f.decide('browser-a', true);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    f.model.codes.set(code, { verifier: f.verifier, client: f.client.client_id, redirect: f.redirect, resource: 'api', used: false, expires: 600 });
    expect(f.model.exchange(code, f.verifier, f.client.client_id, f.redirect, 'api')).toBe('token');
    const response = await f.token(code);
    atCheckpoint('OAuth code acceptance', () => expect(response.status).toBe(200));
    const original = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
    expect(original.expires_in).toBe(3600);
    expect(f.model.exchange(code, f.verifier, f.client.client_id, f.redirect, 'api')).toBe('rejected');
    const refresh = (token: string, scope = 'owner:read owner:draft') => f.request(f.issuer + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: token, resource: f.base + '/blyg/api', scope }) });
    const refreshed = await refresh(original.refresh_token);
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json() as { access_token: string; refresh_token: string; scope: string };
    atCheckpoint('OAuth refresh rotation', () => expect(next.refresh_token).not.toBe(original.refresh_token));
    // The selected zero-grace policy rotates once and treats ancestor reuse
    // as compromise of the whole grant, including its signed access tokens.
    const rotation = await refresh(next.refresh_token);
    expect(rotation.status).toBe(200);
    expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + next.access_token } })).status).toBe(200);
    expect((await refresh(original.refresh_token)).status).toBe(400);
    atCheckpoint('OAuth refresh cannot escalate scope', () => expect(next.scope.split(' ').sort()).toEqual(['owner:draft', 'owner:read']));
    const latest = await rotation.json() as { refresh_token: string };
    expect((await refresh(latest.refresh_token, 'owner:publish')).status).toBe(400);
    expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + next.access_token } })).status).toBe(401);
    expect((await f.request('/blyg/studio/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + next.access_token } })).status).toBe(401);
    const replay = await f.token(code);
    atCheckpoint('OAuth code single use', () => expect(replay.status).toBe(400));
    const revoked = await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + next.access_token } });
    atCheckpoint('OAuth code replay revokes the grant', () => expect(revoked.status).toBe(401));
  });
  it('rejects a consent handle at its exact expiry boundary', async () => {
    const f = await flow(), time = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(time + 600000);
    try { f.model.now = 600; expect(f.model.decide(f.handle, 'browser-a', true)).toBe('rejected'); const response = await f.decide('browser-a', true); atCheckpoint('OAuth consent expiry', () => expect(response.status).toBe(400)); }
    finally { clock.mockRestore(); }
  });
});
