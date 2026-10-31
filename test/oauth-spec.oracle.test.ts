/**
 * Protocol errors and token types must stay distinct at the receiving boundary.
 * An ID token can be valid for its client without authorizing protected API access.
 *
 * Contract sources: RFC6749 §5.2 token errors and §5.1 cache protection;
 * RFC7636 §4.6 incorrect verifier; RFC9700 §2.1/§4.14/§4.16 browser and replay safety:
 * https://www.rfc-editor.org/rfc/rfc6749.html#section-5.2
 * https://www.rfc-editor.org/rfc/rfc6749.html#section-5.1
 * https://www.rfc-editor.org/rfc/rfc7636.html#section-4.6
 * https://www.rfc-editor.org/rfc/rfc9700.html#section-4.16
 * OIDC token validation requires issuer, client audience and nonce:
 * https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation
 * Model: literal response/error laws and independently verified OIDC claims.
 * History grammar: unsupported media/grant types, omitted versus wrong verifier,
 * refresh ancestors, browser endpoints and wrong client audience.
 * Driver: real flow HTTP routes; jose verifies issued ID tokens using published JWKS.
 * Refinement: errors, headers, descendant refresh denial, public-key fields and signed
 * claims at completed responses. Header presence is not proof of browser framing;
 * e2e/client-access.spec.ts owns that receiving witness.
 * Limits: no full algorithm suite, CORS browser matrix or complete OIDC conformance.
 * Refresh ancestry here belongs to one grant. Its denial does not prove the
 * isolation of another same-client grant from native refresh-family cleanup.
 */
import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { flow } from './oauth-flow-driver.ts';

// Independent public contract probes. Literal expectations come from the RFC /
// OIDC source ledger; production helpers never calculate expected outcomes.
describe('OAuth source-boundary oracles', () => {
  it('does not enable CORS on authorization, while allowing browser token access', async () => {
    const f = await flow();
    const response = await f.request(f.authorize, { headers: { Origin: 'https://external-client.example', cookie: f.owner } });
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    const preflight = await f.request(f.issuer + '/oauth2/authorize', { method: 'OPTIONS', headers: { Origin: 'https://external-client.example' } });
    expect(preflight.headers.has('access-control-allow-origin')).toBe(false);
    const token = await f.request(f.issuer + '/oauth2/token', { method: 'OPTIONS' });
    expect(token.headers.get('access-control-allow-origin')).toBe('*');
  });
  it('keeps owner interaction out of frames', async () => {
    const f = await flow();
    const login = await f.request('/blyg/studio/login');
    expect(login.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(login.headers.get('x-frame-options')).toBe('DENY');
  });
  it.each(['application/json', 'text/plain'])('rejects unsupported token body %s as a protocol error', async contentType => {
    const f = await flow();
    const response = await f.request(f.issuer + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': contentType }, body: '{}' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });
  it('uses invalid_grant for a well-formed wrong PKCE verifier', async () => {
    const f = await flow(), accepted = await f.decide('browser-a', true);
    const code = new URL(accepted.headers.get('location')!).searchParams.get('code')!;
    const response = await f.token(code, { code_verifier: 'a'.repeat(43) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });
  it('keeps missing-verifier and unsupported-grant errors distinct', async () => {
    const f = await flow(), accepted = await f.decide('browser-a', true);
    const code = new URL(accepted.headers.get('location')!).searchParams.get('code')!;
    const missing = await f.token(code, { code_verifier: '' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'invalid_request' });
    const password = await f.request(f.issuer + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: f.client.client_id, username: 'owner', password: 'not-an-owner-login' }) });
    expect(password.status).toBe(400);
    expect(await password.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });
  it('revokes the live refresh descendant when an older ancestor is reused', async () => {
    const f = await flow(), accepted = await f.decide('browser-a', true);
    const initial = await (await f.token(new URL(accepted.headers.get('location')!).searchParams.get('code')!)).json() as { refresh_token: string };
    const refresh = (token: string) => f.request(f.issuer + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: token, resource: f.base + '/blyg/api' }) });
    const second = await (await refresh(initial.refresh_token)).json() as { refresh_token: string };
    const third = await (await refresh(second.refresh_token)).json() as { refresh_token: string };
    expect((await refresh(initial.refresh_token)).status).toBe(400);
    expect((await refresh(third.refresh_token)).status).toBe(400);
  });
  it('validates production OIDC metadata, public keys, signed claims and nonce', async () => {
    const f = await flow({ scope: 'openid offline_access owner:read owner:draft', authorize: { nonce: 'source-oracle-nonce' } });
    const metadataResponse = await f.request(f.issuer + '/.well-known/openid-configuration');
    expect(metadataResponse.status).toBe(200);
    expect(metadataResponse.headers.get('content-type')).toContain('application/json');
    const metadata = await metadataResponse.json() as Record<string, any>;
    expect(metadata.issuer).toBe(f.issuer);
    expect(metadata.response_types_supported).toContain('code');
    expect(metadata.subject_types_supported).toContain('public');
    expect(metadata.scopes_supported).toContain('openid');
    expect(metadata.code_challenge_methods_supported).toContain('S256');
    expect(metadata.id_token_signing_alg_values_supported).toContain('RS256');
    for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'jwks_uri']) expect(metadata[field]).toMatch(new RegExp('^' + f.issuer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'));
    const keys = await (await f.request(metadata.jwks_uri)).json() as { keys: any[] };
    expect(keys.keys.length).toBeGreaterThan(0);
    for (const key of keys.keys) {
      expect(key.kty).toBe('RSA');
      expect(key.kid).toBeTruthy();
      for (const privateField of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) expect(key).not.toHaveProperty(privateField);
    }
    const accepted = await f.decide('browser-a', true);
    const response = await f.token(new URL(accepted.headers.get('location')!).searchParams.get('code')!);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const tokens = await response.json() as { id_token: string; token_type: string };
    expect(tokens.token_type.toLowerCase()).toBe('bearer');
    const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(keys), { issuer: f.issuer, audience: f.client.client_id });
    expect(verified.protectedHeader.alg).toBe('RS256');
    expect(verified.payload).toMatchObject({ sub: 'owner', nonce: 'source-oracle-nonce' });
    expect(typeof verified.payload.exp).toBe('number');
    expect(typeof verified.payload.iat).toBe('number');
    await expect(jwtVerify(tokens.id_token, createLocalJWKSet(keys), { issuer: f.issuer, audience: 'wrong-client' })).rejects.toThrow();
  });
});
