/**
 * A forged forwarding header must not buy a fresh password or registration budget.
 * Sequential success alone cannot reveal a factory-local counter or admission race.
 *
 * Contract: local policy allows five requests per sixty-second address budget;
 * IPv6 addresses share a /64 budget, and missing authoritative IP uses one fallback.
 * RFC9700 §4.13 explains the trust boundary at a TLS-terminating proxy:
 * https://www.rfc-editor.org/rfc/rfc9700.html#section-4.13
 * OWASP recommends throttling login attempts and secure session cookies:
 * https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#login-throttling
 * https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#cookies
 * Model: literal counts and host/cookie constraints; no native limiter calculation.
 * History grammar: concurrent admission, spoofed identities, IPv6 neighbors,
 * window advance, password guesses, missing IP and forged origin headers.
 * Driver: makeApp HTTP routes plus D1; registration reconstructs provider instances.
 * Refinement: statuses, retry delay, counter ceiling, cookie flags and issuer after
 * responses settle. A distinct address and endpoint provide admission neighbors.
 * Limits: this fixture supplies CF-Connecting-IP. It cannot establish that a live
 * proxy strips client-supplied values or that an unprotected origin is unreachable.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { makeApp } from '../src/index.ts';

// Receiving boundaries, with literal budgets. Requests enter the real Worker
// routes and native database limiter rather than an auth.api bypass.
function driver(ip: string) {
  const app = makeApp('/blyg'), base = 'https://deployment-oracle.example.test';
  const fetch = async (path: string, init: RequestInit = {}, spoof = '203.0.113.1') => {
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(base + path, { ...init, headers: { 'cf-connecting-ip': ip, 'x-forwarded-for': spoof, ...Object.fromEntries(new Headers(init.headers)) } }), env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  const register = (spoof?: string) => fetch('/blyg/studio/auth/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'deployment oracle', redirect_uris: ['https://client.example.test/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) }, spoof);
  return { fetch, register };
}

describe('auth deployment receiving boundaries', () => {
  it('shares an atomic registration budget and rejects spoofed forwarded identities', async () => {
    const d = driver('198.51.100.101');
    // Each request constructs the configured provider anew. Its shared D1
    // counter, not factory-local state, must decide the admission race.
    const responses = await Promise.all(Array.from({ length: 9 }, (_, index) => d.register('203.0.113.' + (index + 10))));
    expect(responses.filter(response => response.status === 201), 'spoofed forwarded addresses share one edge budget').toHaveLength(5);
    expect(responses.filter(response => response.status === 429)).toHaveLength(4);
    const limited = await d.register('203.0.113.99');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('x-retry-after'))).toBeGreaterThan(0);
    const row = await env.DB.prepare('SELECT MAX(count) AS count FROM rateLimit').first<{ count: number }>();
    expect(row?.count).toBe(5);
    expect((await driver('198.51.100.102').register()).status).toBe(201);
    // Exhausting registration must not consume a distinct token endpoint.
    expect((await d.fetch('/blyg/studio/auth/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code' }) })).status).toBe(400);
  });

  it('normalizes IPv6 subnets and starts a fresh budget after the window', async () => {
    const d = driver('2001:db8:1234:1::1');
    for (let i = 0; i < 5; i++) expect((await d.register()).status).toBe(201);
    expect((await driver('2001:0db8:1234:0001:0000:0000:0000:0002').register()).status).toBe(429);
    expect((await driver('2001:db8:1234:2::1').register()).status).toBe(201);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    try { expect((await d.register()).status).toBe(201); }
    finally { clock.mockRestore(); }
  });

  it('limits owner password guesses without blocking another address or minting cookies', async () => {
    const d = driver('198.51.100.110');
    for (let i = 0; i < 5; i++) {
      const rejected = await d.fetch('/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: 'wrong' }) });
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get('set-cookie')).toBeNull();
    }
    const limited = await d.fetch('/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('set-cookie')).toBeNull();
    const admitted = await driver('198.51.100.111').fetch('/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
    expect(admitted.status).toBe(302);
    expect(admitted.headers.get('set-cookie')).toContain('blyg_session=');
    expect((await d.fetch('/blyg/studio/auth/internal/owner-login-budget', { method: 'POST' })).status).toBe(404);
  });

  it('uses a shared fallback budget when no authoritative IP header reaches the Worker', async () => {
    const d = driver('198.51.100.120');
    const responses = [];
    for (let i = 0; i < 7; i++) responses.push(await d.fetch('/blyg/studio/auth/oauth2/register', {
      method: 'POST', headers: { 'cf-connecting-ip': '', 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://client.example.test/callback'], token_endpoint_auth_method: 'none' }),
    }, '203.0.113.' + (i + 20)));
    expect(responses.map(response => response.status)).toEqual([201, 201, 201, 201, 201, 429, 429]);
  });

  it('keeps native cookies host-only and ignores forged forwarded origins', async () => {
    const d = driver('198.51.100.121');
    const response = await d.fetch('/blyg/studio/auth/.well-known/openid-configuration', { headers: { 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' } });
    const metadata = await response.json() as { issuer: string };
    expect(metadata.issuer).toBe('https://deployment-oracle.example.test/blyg/studio/auth');
    const registered = await (await d.register()).json() as { client_id: string };
    const login = await d.fetch('/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const authorization = await d.fetch('/blyg/studio/auth/oauth2/authorize?' + new URLSearchParams({ client_id: registered.client_id, response_type: 'code', redirect_uri: 'https://client.example.test/callback', scope: 'owner:read', resource: 'https://deployment-oracle.example.test/blyg/api', code_challenge: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', code_challenge_method: 'S256' }), { headers: { cookie } });
    expect(authorization.status).toBe(200);
    const sessionCookie = authorization.headers.getSetCookie().find(value => value.includes('better-auth.session_token='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toContain('Path=/blyg/studio/auth');
    expect(sessionCookie?.toLowerCase()).not.toContain('domain=');
  });
});
