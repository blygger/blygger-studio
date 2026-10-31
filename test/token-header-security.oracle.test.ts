/**
 * JWTs must be verified with the selected key/algorithm, not with a key named by
 * an attacker-controlled header. RFC8725 §3.1 and §3.10 define those boundaries:
 * https://www.rfc-editor.org/rfc/rfc8725.html#section-3.1
 * https://www.rfc-editor.org/rfc/rfc8725.html#section-3.10
 * Model: a native valid credential reaches a protected read. Unsigned, HMAC-key
 * confusion, substituted RSA and malformed header neighbors must return 401 for reads
 * and writes. Attacker jku/x5u locations must never be fetched. The fixture keys
 * and public JWKS are disposable; no host credentials are read.
 * Driver: native OAuth flow and the real owner API. The fetch spy observes only
 * attacker-key destinations and does not supply an alternate verifier.
 * Grammar: bounded fixed headers, not every JOSE extension/algorithm or entropy.
 */
import { expect, it, vi } from 'vitest';
import { decodeJwt, SignJWT, generateKeyPair } from 'jose';
import { flow } from './oauth-flow-driver.ts';
const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
it('rejects hostile JWT headers and algorithms without consulting attacker keys', async () => {
  const f = await flow();
  const approved = await f.decide('browser-a', true); expect(approved.status).toBe(302);
  const issued = await f.token(new URL(approved.headers.get('location')!).searchParams.get('code')!); expect(issued.status).toBe(200);
  const { access_token } = await issued.json() as { access_token: string };
  const read = (token: string) => f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + token } });
  expect((await read(access_token)).status).toBe(200);
  const keys = await (await f.request(f.issuer + '/jwks')).json() as { keys: { kid: string }[] };
  expect(keys.keys.length).toBeGreaterThan(0);
  const payload = decodeJwt(access_token), attacker = 'https://attacker-key.example/keys';
  const { privateKey } = await generateKeyPair('RS256');
  const candidates = [
    `${encode({ alg: 'none', typ: 'at+jwt' })}.${encode(payload)}.`,
    await new SignJWT(payload).setProtectedHeader({ alg: 'HS256', kid: keys.keys[0].kid, typ: 'at+jwt' }).sign(new TextEncoder().encode(JSON.stringify(keys))),
    await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: keys.keys[0].kid, typ: 'at+jwt', jku: attacker }).sign(privateKey),
    await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: keys.keys[0].kid, typ: 'at+jwt', x5u: attacker }).sign(privateKey),
    `${encode({ alg: 'RS256', kid: { url: attacker }, crit: ['unknown'], unknown: true })}.${access_token.split('.').slice(1).join('.')}`,
    'not-a-jwt', access_token + '.extra', access_token.split('.').slice(0, 2).join('.'),
  ];
  const spy = vi.spyOn(globalThis, 'fetch');
  try {
    for (const token of candidates) {
      expect((await read(token)).status, 'hostile JWT cannot read owner material').toBe(401);
      expect((await f.request('/blyg/api/items', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ content_md: 'forbidden header write' }) })).status).toBe(401);
    }
    expect(spy.mock.calls.some(([input]) => String(input instanceof Request ? input.url : input).startsWith(attacker)), 'untrusted JOSE headers cannot trigger network key lookup').toBe(false);
  } finally { spy.mockRestore(); }
});
