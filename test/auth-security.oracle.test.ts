/**
 * A valid signature is necessary, but it does not grant authority by itself.
 * A normal successful login cannot expose replay, claim-confusion or error leaks.
 *
 * Contract and sources:
 * - RFC9700 §4.14.2 describes refresh rotation and replay detection:
 *   https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2
 * - RFC9068 §4 requires receiving validation of access-token claims:
 *   https://www.rfc-editor.org/rfc/rfc9068.html#section-4
 * - RFC7662 §2.2 defines active/inactive introspection responses:
 *   https://www.rfc-editor.org/rfc/rfc7662.html#section-2.2
 * - RFC6750 §5.2 requires TLS protection for bearer credentials:
 *   https://www.rfc-editor.org/rfc/rfc6750.html#section-5.2
 * - OWASP identifies secrets that logs must exclude:
 *   https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude
 * Blygger additionally revokes the whole grant after detected refresh replay,
 * rejects unsupported sender constraints, and admits HTTP only on exact loopback
 * hosts. These are selected application policies, not universal RFC status codes.
 *
 * Model: literal allow/deny relations, not a copy of the token verifier. Replay
 * makes the compromised grant unusable. Invalid scope/resource/client requests
 * leave the legitimate grant usable; they are not detected consumed-token replay.
 * Storage and logging have separate secret-exclusion laws.
 * History grammar: fixed rotations, revocation, hostile hosts, eight signed claim
 * changes, substituted keys, ID tokens and three injected dependency failures.
 * Driver: real Worker HTTP routes and native issuance. Server-only signing creates
 * hostile but cryptographically valid fixture claims; it does not judge them.
 * Refinement: compare exact status, cookies, introspection, persisted credential
 * absence and Error-aware console capture after each completed request.
 * Limits: no exhaustive JWT header grammar, platform log audit or deployed TLS
 * proof. HTTP refusal cannot undo credentials already sent. Native session bearer
 * values remain in D1. The replay witness has one grant. It does not assert that
 * another same-client grant can refresh after native client/owner family cleanup.
 * See docs/auth-security-oracles.md for mutation witnesses.
 */
import { describe, expect, it, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { decodeJwt, generateKeyPair, SignJWT } from 'jose';
import { flow } from './oauth-flow-driver.ts';
import { authorizationServer } from '../src/oauth.ts';
import { makeApp } from '../src/index.ts';

async function issued() {
  const f = await flow({ scope: 'openid owner:read owner:draft offline_access' });
  const approval = await f.decide('browser-a', true);
  const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
  const response = await f.token(code);
  expect(response.status, 'security setup must issue a real credential').toBe(200);
  return { ...f, code, tokens: await response.json() as { access_token: string; refresh_token: string; id_token: string } };
}
const refresh = (f: Awaited<ReturnType<typeof issued>>, token: string) => f.request(f.issuer + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: token, resource: f.base + '/blyg/api' }) });
const read = (f: Awaited<ReturnType<typeof flow>>, token: string) => f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + token } });
const mcp = (f: Awaited<ReturnType<typeof issued>>, token: string, name = 'getSettings') => f.request('/blyg/studio/mcp', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': 'tools/call', 'MCP-Name': name },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: name === 'createItem' ? { body: { content_md: 'must not write' } } : {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
});

// Literal security laws are independent of native provider implementation.
// Do not weaken 401 to "any error": denial must occur before protected work.
describe('security release boundaries', () => {
  it.each(['/blyg/studio/login', '/blyg/studio/auth/oauth2/token', '/blyg/api/settings', '/blyg/studio/mcp'])('rejects non-loopback cleartext auth transport at %s', async path => {
    const ctx = createExecutionContext();
    const response = await makeApp('/blyg').fetch(new Request('http://insecure.example.test' + path, { method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.251' }, body: new URLSearchParams({ password: env.OWNER_PASSWORD, grant_type: 'authorization_code' }) }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status, 'cleartext protected transport must fail closed').toBe(400);
    expect(await response.json()).toEqual({ error: 'HTTPS required' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each(['localhost', '127.0.0.1', '[::1]'])('allows HTTP development login only on exact loopback host %s', async host => {
    const ctx = createExecutionContext();
    const response = await makeApp('/blyg').fetch(new Request('http://' + host + '/blyg/studio/login', { method: 'POST', headers: { 'CF-Connecting-IP': '2001:db8:' + crypto.randomUUID().replaceAll('-', '').match(/.{4}/g)!.slice(0, 6).join(':') }, body: new URLSearchParams({ password: env.OWNER_PASSWORD }) }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).not.toBeNull();
  });
  it.each(['localhost.attacker.test', '127.0.0.2', 'localhost.'])('does not treat remote or ambiguous host %s as a development exception', async host => {
    const ctx = createExecutionContext();
    const response = await makeApp('/blyg').fetch(new Request('http://' + host + '/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400); expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('denies scope, resource and client escalation without revoking the legitimate grant', async () => {
    const f = await issued(), other = await flow();
    const patches: Record<string, string>[] = [{ scope: 'owner:publish' }, { resource: f.base + '/blyg/studio/mcp' }, { client_id: other.client.client_id }];
    for (const patch of patches) {
      const rejected = await f.request(f.issuer + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: f.tokens.refresh_token, resource: f.base + '/blyg/api', ...patch }) });
      expect(rejected.status).toBe(400);
      expect((await read(f, f.tokens.access_token)).status, 'invalid binding must not revoke the legitimate grant').toBe(200);
    }
    expect((await refresh(f, f.tokens.refresh_token)).status).toBe(200);
  });
  // The refresh replay law has two checkpoints: the successor works before replay,
  // then its access and refresh credentials both fail. The application tombstone
  // is grant-scoped; native refresh cleanup is client/owner-scoped. This history
  // checks the compromised grant only. RFC9700 requires replay
  // handling; invalidating signed access is Blygger's stronger selected policy.
  // A mere rotation response would miss a resource server accepting a stale JWT.
  it('rejects access credentials in the compromised grant after refresh ancestor replay', async () => {
    const f = await issued();
    const rotated = await refresh(f, f.tokens.refresh_token);
    expect(rotated.status).toBe(200);
    const successor = await rotated.json() as { access_token: string; refresh_token: string };
    expect((await read(f, successor.access_token)).status).toBe(200);
    expect((await refresh(f, f.tokens.refresh_token)).status).toBe(400);
    expect((await read(f, successor.access_token)).status, 'replayed grant access must be denied').toBe(401);
    expect((await refresh(f, successor.refresh_token)).status).toBe(400);
  });

  // RFC7662 §2.2 requires active to reflect current validity, not just signature.
  // The confidential introspection client must authenticate before either observation.
  // The same token is active before deletion and exactly {active:false} afterward;
  // a permanently-inactive implementation cannot satisfy the positive checkpoint.
  it.each(['access_token', 'refresh_token'] as const)('reports a revoked %s inactive through authenticated native introspection', async tokenKind => {
    const f = await issued();
    const registration = await f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [f.redirect], token_endpoint_auth_method: 'client_secret_basic' }) });
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id: string; client_secret: string };
    // Native refresh introspection is restricted to the issuing client. Issue
    // through the confidential client first; another client's inactive response
    // would be a setup failure, not evidence that revocation works.
    if (tokenKind === 'refresh_token') {
      const authorize = new URL(f.authorize); authorize.searchParams.set('client_id', client.client_id);
      const consent = await f.request(authorize.href, { headers: { cookie: f.owner } }); expect(consent.status).toBe(200);
      const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)![1];
      const binding = consent.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
      const approval = await f.request(f.issuer + '/consent', { method: 'POST', headers: { cookie: f.owner + '; ' + binding, Origin: f.base }, body: new URLSearchParams([['handle', handle], ['decision', 'allow'], ['scope', 'owner:read'], ['scope', 'owner:draft']]) });
      const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
      const exchange = await f.request(f.issuer + '/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + btoa(client.client_id + ':' + client.client_secret) }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: f.redirect, code_verifier: f.verifier, resource: f.base + '/blyg/api' }) });
      expect(exchange.status).toBe(200); f.tokens = await exchange.json() as typeof f.tokens;
      f.client.client_id = client.client_id;
    }
    const introspect = () => f.request(f.issuer + '/oauth2/introspect', { method: 'POST', headers: { Authorization: 'Basic ' + btoa(client.client_id + ':' + client.client_secret) }, body: new URLSearchParams({ token: f.tokens[tokenKind], token_type_hint: tokenKind }) });
    const before = await introspect(); expect(before.status).toBe(200); expect(await before.json()).toMatchObject({ active: true });
    const listing = await (await f.request('/blyg/api/authorizations', { headers: { cookie: f.owner } })).json() as { items: { id: string; clientId: string }[] };
    const grant = listing.items.find(value => value.clientId === f.client.client_id)!;
    expect((await f.request('/blyg/api/authorizations/' + grant.id, { method: 'DELETE', headers: { cookie: f.owner } })).status).toBe(200);
    const after = await introspect(); expect(after.status).toBe(200); expect(await after.json(), 'a revoked grant introspects inactive').toEqual({ active: false });
  });

  // This is a bounded at-rest exclusion law, not a password-hash strength proof.
  // Scan the named application tables for fixture secrets and inspect encrypted JWKS.
  // The private-key check detects the plaintext-key mutant, not every recoverable
  // encoding. Native session rows and operator/backup permissions remain outside it.
  it('does not store recoverable owner password, authorization code or refresh token in application rows', async () => {
    const f = await issued();
    const tables = ['user', 'account', 'verification', 'oauthClient', 'oauthRefreshToken', 'oauthAccessToken', 'oauthConsent', 'oauth_records', 'oauth_authorizations'];
    const serialized = JSON.stringify(await Promise.all(tables.map(table => env.DB.prepare('SELECT * FROM "' + table + '"').all())));
    const secrets = [env.OWNER_PASSWORD, f.code, f.tokens.refresh_token, f.tokens.access_token];
    expect(secrets.some(value => serialized.includes(value)), 'stored auth rows must not contain these plaintext credentials').toBe(false);
    const key = await env.DB.prepare('SELECT privateKey FROM jwks LIMIT 1').first<{ privateKey: string }>();
    expect(key).not.toBeNull();
    expect(key!.privateKey.includes('"d"'), 'private signing key must be encrypted').toBe(false);
    // Native session tokens are deliberately bearer credentials in D1. This
    // fixture does not certify database/operator access or backup confidentiality.
  });

  // The sentinel models a dependency exception containing a credential. Capture all
  // console methods and include Error.name/message/stack: JSON.stringify(Error) alone
  // would hide the leak. OWASP's log-exclusion rule applies even on failure paths.
  // The model observes local logging and HTTP output, not platform-managed sinks.
  it.each(['registration', 'owner-login', 'manual-mint'])('does not leak sentinel credentials through dependency failures or HTTP errors (%s)', async endpoint => {
    const f = await issued();
    const marker = 'security-oracle-secret-' + crypto.randomUUID();
    const captured: unknown[][] = [];
    let nativeFaultReached = false;
    const spies = (['error', 'warn', 'info', 'log', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { captured.push(args); }));
    try {
      // A driver failure can contain parameter values. This is an adversarial
      // dependency seam, not a claim that D1 currently emits this exact message.
      const database = new Proxy(env.DB, { get(target, key) {
        if (key === 'prepare') return (sql: string) => {
          if (!sql.includes('security_registrations') && !sql.startsWith('DELETE FROM oauthClient WHERE userId IS NULL') && sql.includes(endpoint === 'owner-login' ? 'rateLimit' : 'oauthClient')) {
            nativeFaultReached = true;
            const error = new Error('database failed with credential=' + marker);
            error.name = marker; // Dependency-defined names are untrusted too.
            throw error;
          }
          return target.prepare(sql);
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const ctx = createExecutionContext();
      const path = endpoint === 'registration' ? f.issuer + '/oauth2/register' : endpoint === 'owner-login' ? f.base + '/blyg/studio/login' : f.base + '/blyg/api/authorizations';
      const body = endpoint === 'registration' ? JSON.stringify({ client_name: marker, redirect_uris: [f.redirect], token_endpoint_auth_method: 'none' }) : endpoint === 'owner-login' ? new URLSearchParams({ password: marker }) : JSON.stringify({ name: marker, resource: 'api', scope: ['owner:read'] });
      const response = await makeApp('/blyg').fetch(new Request(path, { method: 'POST', headers: { ...(endpoint === 'owner-login' ? {} : { 'content-type': 'application/json' }), ...(endpoint === 'manual-mint' ? { cookie: f.owner } : {}), 'CF-Connecting-IP': '198.51.100.230' }, body }), { ...env, DB: database }, ctx);
      await waitOnExecutionContext(ctx);
      expect(nativeFaultReached, 'dependency failure must reach native provider work, not admission').toBe(true);
      expect(response.status).toBe(500);
      expect((await response.text()).includes(marker), 'HTTP error must not leak credentials').toBe(false);
      const logs = JSON.stringify(captured, (_key, value) => value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value);
      expect(logs.includes(marker), 'dependency logging must not leak credentials').toBe(false);
    } finally {
      for (const spy of spies) spy.mockRestore();
      const leaked = captured.filter(row => JSON.stringify(row, (_key, value) => value instanceof Error ? value.message : value).includes(marker));
      if (leaked.length) console.error('Sentinel sink labels', leaked.map(row => row.map(value => typeof value === 'string' ? value.replaceAll(marker, '<sentinel>').slice(0, 160) : value instanceof Error ? value.name : typeof value)));
    }
  });

  it('rejects a substituted signing key and the OIDC token at protected resources', async () => {
    const f = await issued(), payload = decodeJwt(f.tokens.access_token);
    const { privateKey } = await generateKeyPair('RS256');
    const substitute = await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'untrusted-key', typ: 'at+jwt' }).sign(privateKey);
    for (const token of [substitute, f.tokens.id_token]) {
      expect((await read(f, token)).status, 'wrong key or token type must deny protected reads').toBe(401);
      expect((await f.request('/blyg/api/items', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ content_md: 'must not write' }) })).status).toBe(401);
    }
  });

  // A trusted signature is held constant while one authorization claim changes.
  // This isolates claim validation from cryptographic rejection. A valid signed
  // neighbor reaches a tool before negatives. Receiving401 is the measured boundary;
  // these cases do not independently count every downstream side effect.
  it('rejects the hostile trusted-key claim matrix at MCP before reads or writes', async () => {
    const f = await issued();
    const minted = await f.request('/blyg/api/authorizations', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'MCP claim fixture', resource: 'mcp', scope: ['owner:read', 'owner:draft'] }) });
    expect(minted.status).toBe(200);
    const { access_token } = await minted.json() as { access_token: string };
    const payload = decodeJwt(access_token), server = await authorizationServer(f.issuer, env);
    const neighbor = await server.api.signJWT({ body: { payload } });
    expect((await mcp(f, neighbor.token)).status, 'valid MCP claim neighbor must reach its tool').toBe(200);
    const patches = [
      { iss: 'https://foreign.example.test/auth' }, { sub: 'attacker' }, { aud: f.base + '/blyg/api' },
      { exp: Math.floor(Date.now() / 1000) - 1 }, { nbf: Math.floor(Date.now() / 1000) + 3600 },
      { grantId: undefined }, { credentialVersion: 'foreign-version' }, { cnf: { jkt: 'unsupported-sender' } },
    ];
    for (const patch of patches) {
      const signed = await server.api.signJWT({ body: { payload: { ...payload, ...patch } } });
      expect((await mcp(f, signed.token)).status, 'invalid MCP claims must deny protected reads').toBe(401);
      expect((await mcp(f, signed.token, 'createItem')).status, 'invalid MCP claims must deny protected writes').toBe(401);
    }
    const { privateKey } = await generateKeyPair('RS256');
    const substitute = await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'untrusted-key', typ: 'at+jwt' }).sign(privateKey);
    for (const token of [substitute, f.tokens.id_token]) expect((await mcp(f, token)).status).toBe(401);
  });

  it.each(['issuer', 'subject', 'audience', 'expiry', 'not-before', 'grant', 'version', 'confirmation'])('rejects trusted-key tokens with invalid %s claims', async axis => {
    const f = await issued(), payload = decodeJwt(f.tokens.access_token);
    const server = await authorizationServer(f.issuer, env);
    const neighbor = await server.api.signJWT({ body: { payload } });
    expect((await read(f, neighbor.token)).status, 'trusted-key valid neighbor must reach the verifier').toBe(200);
    const patches: Record<string, Record<string, unknown>> = {
      issuer: { iss: 'https://foreign.example.test/auth' }, subject: { sub: 'attacker' }, audience: { aud: f.base + '/foreign' },
      expiry: { exp: Math.floor(Date.now() / 1000) - 1 }, 'not-before': { nbf: Math.floor(Date.now() / 1000) + 3600 },
      grant: { grantId: undefined }, version: { credentialVersion: 'foreign-version' }, confirmation: { cnf: { jkt: 'unsupported-sender' } },
    };
    // Only a server-only native API signs these test-fixture claims. No host
    // credential or private key is read, and the HTTP endpoint stays excluded.
    const signed = await server.api.signJWT({ body: { payload: { ...payload, ...patches[axis] } } });
    expect((await read(f, signed.token)).status, 'invalid claim must deny protected reads').toBe(401);
    expect((await f.request('/blyg/api/items', { method: 'POST', headers: { Authorization: 'Bearer ' + signed.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ content_md: 'must not write' }) })).status).toBe(401);
  });
  // RFC6749 §2.3.1 allows client identity in HTTP Basic rather than the form:
  // https://www.rfc-editor.org/rfc/rfc6749.html#section-2.3.1
  // The same consumed-refresh history must revoke its JWT grant for this native
  // confidential-client profile. An incorrect secret is an authentication failure,
  // not replay evidence: it must leave the valid JWT usable.
  it('revokes the JWT grant on authenticated Basic refresh replay only', async () => {
    const f = await flow();
    const registered = await f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Basic replay oracle', redirect_uris: [f.redirect], token_endpoint_auth_method: 'client_secret_basic', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    expect(registered.status).toBe(201);
    const client = await registered.json() as { client_id: string; client_secret: string };
    expect(client.client_secret).toBeTruthy();
    const authorize = new URL(f.authorize); authorize.searchParams.set('client_id', client.client_id);
    const consent = await f.request(authorize.href, { headers: { cookie: f.owner } });
    expect(consent.status).toBe(200);
    const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)![1];
    const binding = consent.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    const approval = await f.request(f.issuer + '/consent', { method: 'POST', headers: { cookie: f.owner + '; ' + binding, Origin: f.base }, body: new URLSearchParams([['handle', handle], ['decision', 'allow'], ['scope', 'owner:read']]) });
    expect(approval.status).toBe(302);
    const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
    const exchange = (values: Record<string, string>, secret = client.client_secret) => f.request(f.issuer + '/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + btoa(encodeURIComponent(client.client_id) + ':' + encodeURIComponent(secret)), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
    const first = await exchange({ grant_type: 'authorization_code', code, redirect_uri: f.redirect, code_verifier: f.verifier, resource: f.base + '/blyg/api' });
    expect(first.status).toBe(200);
    const issued = await first.json() as { refresh_token: string };
    const refresh = { grant_type: 'refresh_token', refresh_token: issued.refresh_token, resource: f.base + '/blyg/api' };
    const rotated = await exchange(refresh); expect(rotated.status).toBe(200);
    const next = await rotated.json() as { access_token: string; refresh_token: string };
    expect((await read(f, next.access_token)).status).toBe(200);
    const forged = await exchange(refresh, 'wrong-secret');
    expect(forged.status).toBe(401);
    expect((await read(f, next.access_token)).status, 'failed client authentication cannot revoke the real grant').toBe(200);
    const replay = await exchange(refresh); expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await read(f, next.access_token)).status, 'authenticated Basic replay revokes the compromised JWT grant').toBe(401);
  });

});

// A remembered grant is not new authority. Pause the real persistence write
// after native token validation, revoke through the owner API, then resume.
// The owner listing must never resurrect a tombstoned grant (RFC7009 §2.1).
it('a revoke between token validation and grant persistence cannot resurrect its listing', async () => {
  const f = await issued();
  const list = async () => (await (await f.request('/blyg/api/authorizations', { headers: { cookie: f.owner } })).json() as {items:{id:string;clientId:string}[]}).items;
  const grant = (await list()).find(row => row.clientId === f.client.client_id)!; expect(grant).toBeDefined();
  let reached!:()=>void, release!:()=>void;
  const paused = new Promise<void>(resolve=>{reached=resolve;}), resume = new Promise<void>(resolve=>{release=resolve;});
  const database = new Proxy(env.DB, { get(target,key) {
    if(key==='prepare') return (sql:string) => {
      const wrap = (statement:D1PreparedStatement):D1PreparedStatement => new Proxy(statement,{get(statement,key){
        if(key==='bind') return (...values:unknown[])=>wrap(statement.bind(...values));
        if(key==='run' && /INSERT INTO oauth_authorizations/.test(sql)) return async()=>{reached();await resume;return statement.run();};
        const value=Reflect.get(statement,key);return typeof value==='function'?value.bind(statement):value;
      }});
      return wrap(target.prepare(sql));
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const { rememberAuthorization } = await import('../src/oauth.ts');
  const pending=rememberAuthorization(f.issuer, {...env,DB:database},f.tokens.access_token);
  try {
    await paused;
    expect((await f.request('/blyg/api/authorizations/'+grant.id,{method:'DELETE',headers:{cookie:f.owner}})).status).toBe(200);
  } finally { release(); }
  await pending;
  expect(await env.DB.prepare('SELECT grant_id FROM oauth_authorizations WHERE grant_id=?').bind(grant.id).first(),'revocation tombstone must block late grant persistence').toBeNull();
  expect((await list()).some(row=>row.id===grant.id),'a completed revoke cannot be undone by a late recording write').toBe(false);
  expect((await read(f,f.tokens.access_token)).status).toBe(401);
});

// Legacy or interrupted deployments can leave a stale row beside a tombstone.
// The list is a receiving authority display and must fail closed independently
// of the write guard. This fixture does not simulate a new grant or clear revoke.
it('the owner listing excludes stale persisted rows for revoked grants', async () => {
  const f = await issued();
  const row = await env.DB.prepare('SELECT * FROM oauth_authorizations WHERE client_id=?').bind(f.client.client_id).first<Record<string, unknown>>();
  expect(row).not.toBeNull();
  expect((await f.request('/blyg/api/authorizations/'+row!.grant_id,{method:'DELETE',headers:{cookie:f.owner}})).status).toBe(200);
  await env.DB.prepare('INSERT INTO oauth_authorizations(grant_id,client_id,name,manual,resource,scopes,created,expires,version) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(...['grant_id','client_id','name','manual','resource','scopes','created','expires','version'].map(key=>row![key])).run();
  const list = await (await f.request('/blyg/api/authorizations',{headers:{cookie:f.owner}})).json() as {items:{id:string}[]};
  expect(list.items.some(entry=>entry.id===row!.grant_id),'stored stale grant rows cannot appear active').toBe(false);
  expect((await read(f,f.tokens.access_token)).status).toBe(401);
});
