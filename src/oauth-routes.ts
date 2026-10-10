import { bodyLimit } from 'hono/body-limit';
import { reserveClient, releaseClient } from './security-budgets.ts';
import { requestError } from './request-error.ts';
import { Hono, type Context } from 'hono';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import type { Env } from './types.ts';
import { verifySession } from './auth.ts';
import { authorizationServer, ownerHeaders, authLocations, credentialVersion, rememberAuthorization, hashCredential, verifyBearer } from './oauth.ts';
import { OAuthStorage } from './oauth-storage.ts';
import { OWNER_SCOPES, SCOPE_DESCRIPTIONS } from './permissions.ts';
import { escapeHtml } from './util.ts';

export function oauthRoutes() {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
app.use('*', (c, next) => bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: 'request body exceeds byte limit' }, 413) })(c, next));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    // RFC 9700 forbids CORS at the authorization endpoint, including preflight.
    const authorization = new URL(c.req.url).pathname.endsWith('/oauth2/authorize');
    if (!authorization) c.header('Access-Control-Allow-Origin', '*');
    await next();
    if (authorization) c.res.headers.delete('Access-Control-Allow-Origin');
  });
  app.onError((error, c) => {
    console.error('OAuth request failed', requestError(error, c));
    return c.json({ error: 'internal server error' }, 500);
  });
  app.get('/resources/:resource', c => {
    const resource = c.req.param('resource');
    if (resource !== 'api' && resource !== 'mcp') return c.notFound();
    const locations = authLocations(c.req.url, c.env);
    return c.json({ resource: locations[resource], authorization_servers: [locations.issuer], scopes_supported: OWNER_SCOPES, bearer_methods_supported: ['header'] });
  });
  app.options('*', c => {
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return c.body(null, 204);
  });
  const invalidAuthorization = async (c: Context<{ Bindings: Env }>, params: URLSearchParams) => {
    // A protocol error may redirect only to an exact registered callback. Invalid
    // or repeated client/redirect inputs remain local errors.
    if (params.getAll('client_id').length === 1 && params.getAll('redirect_uri').length === 1) {
      const client = await c.env.DB.prepare('SELECT redirectUris,disabled FROM oauthClient WHERE clientId=?').bind(params.get('client_id')).first<{ redirectUris: string; disabled: number }>();
      const redirect = params.get('redirect_uri');
      if (client && !client.disabled && redirect && (JSON.parse(client.redirectUris) as string[]).includes(redirect)) {
        const url = new URL(redirect); url.searchParams.set('error', 'invalid_request');
        if (params.getAll('state').length === 1) url.searchParams.set('state', params.get('state')!);
        url.searchParams.set('iss', authLocations(c.req.url, c.env).issuer);
        return c.redirect(url.href);
      }
    }
    return c.json({ error: 'invalid_request' }, 400);
  };
  const renderConsent = async (c: Context<{ Bindings: Env }>, query: string, server: Awaited<ReturnType<typeof authorizationServer>>, headers: Headers, cookies: string[] = []) => {
    if (!await verifyOAuthQueryParams(query, (await server.$context).secret)) return c.json({ error: 'invalid consent request' }, 400);
    const session = await server.api.getSession({ headers });
    if (session?.user.id !== 'owner') return c.json({ error: 'owner session required' }, 401);
    const params = new URLSearchParams(query), clientId = params.get('client_id')!;
    const client = await server.api.getOAuthClientPublic({ headers, query: { client_id: clientId } });
    const handle = crypto.randomUUID(), scope = (params.get('scope') ?? '').split(' ');
    await new OAuthStorage(c.env.DB).put('consent:' + handle, JSON.stringify({ query, session: session.session.id, version: await credentialVersion(c.env), scope }), { expirationTtl: 600 });
    const { base, issuer } = authLocations(c.req.url, c.env);
    const offline = scope.includes('offline_access') ? '<p>This client requests offline access: it can renew its access while you are away, until this grant expires within 30 days or you revoke it.</p>' : '';
    const scopeList = OWNER_SCOPES.filter(value => scope.includes(value)).map(value => `<p><label><input type="checkbox" name="scope" value="${value}" checked> ${escapeHtml(SCOPE_DESCRIPTIONS[value])}</label></p>`).join('');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize client</title><link rel="stylesheet" href="${escapeHtml(base)}/app.css"></head><body><main><h1>Allow ${escapeHtml(client.client_name ?? clientId)}?</h1><p>This client name is self-asserted. Access returns to <strong>${escapeHtml(params.get('redirect_uri')!)}</strong>.</p><p>Resource: <code>${escapeHtml(params.get('resource') ?? '')}</code></p><form method="post" action="${escapeHtml(issuer)}/consent"><input type="hidden" name="handle" value="${handle}">${scopeList}${offline}<p>Access tokens last one hour. You can revoke this grant in Studio.</p><button name="decision" value="allow">allow access</button> <button name="decision" value="deny">deny</button></form></main></body></html>`;
    const response = new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' } });
    for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
    return response;
  };
  app.get('/oauth2/authorize', async c => {
    const authorizationURL = new URL(c.req.url), requestParams = authorizationURL.searchParams;
    // Generic OAuth clients (including manually configured MCP proxies) can
    // omit RFC 8707 resource indicators. Bind that flow to MCP before login,
    // signed consent and code issuance; never add audiences at token exchange.
    // An explicit API, empty or foreign resource still goes through validation.
    if (!requestParams.has('resource')) requestParams.set('resource', authLocations(c.req.url, c.env).mcp);
    const authorizationRequest = new Request(authorizationURL, c.req.raw);
    if (!requestParams.get('response_type')) return invalidAuthorization(c, requestParams);
    if (!await verifySession(c.env, c.req.header('cookie'))) {
      if ((requestParams.get('prompt') ?? '').split(' ').includes('none')) {
        // Native OAuth cookies do not replace the separate password session.
        // Let the provider validate the client/callback and emit login_required,
        // but prevent a stale native session from authorizing silently.
        const headers = new Headers(authorizationRequest.headers); headers.delete('cookie');
        return (await authorizationServer(c.req.url, c.env)).handler(new Request(authorizationRequest, { headers }));
      }
      const { base } = authLocations(c.req.url, c.env), path = authorizationURL;
      return c.redirect(base + '/login?return_to=' + encodeURIComponent(path.pathname + path.search));
    }
    const params = requestParams, challenge = params.get('code_challenge');
    if (challenge && !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) return invalidAuthorization(c, params);
    const server = await authorizationServer(c.req.url, c.env), bridge = await ownerHeaders(authorizationRequest, server);
    const response = await server.handler(new Request(authorizationRequest, { headers: bridge.headers }));
    const location = response.headers.get('location');
    if (location && new URL(location, c.req.url).pathname === new URL(authLocations(c.req.url, c.env).issuer).pathname + '/consent') {
      return renderConsent(c, new URL(location, c.req.url).search.slice(1), server, bridge.headers, bridge.cookies);
    }
    for (const cookie of bridge.cookies) response.headers.append('Set-Cookie', cookie);
    return response;
  });
  app.get('/consent', async c => {
    if (!await verifySession(c.env, c.req.header('cookie'))) return c.json({ error: 'owner session required' }, 401);
    const server = await authorizationServer(c.req.url, c.env);
    return renderConsent(c, new URL(c.req.url).search.slice(1), server, c.req.raw.headers);
  });
  app.post('/consent', async c => {
    if (!await verifySession(c.env, c.req.header('cookie'))) return c.json({ error: 'owner session required' }, 401);
    if (c.req.header('origin') && c.req.header('origin') !== new URL(c.req.url).origin || c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'cross-origin consent denied' }, 403);
    const server = await authorizationServer(c.req.url, c.env), session = await server.api.getSession({ headers: c.req.raw.headers });
    const form = await c.req.formData(), key = 'consent:' + String(form.get('handle') ?? '');
    const record = await new OAuthStorage(c.env.DB).get(key, 'json') as { query: string; session: string; version: string; scope: string[] } | null;
    if (!record || record.session !== session?.session.id || record.version !== await credentialVersion(c.env)) return c.json({ error: 'invalid or expired consent' }, 400);
    const allowed = form.get('decision') === 'allow', denied = form.get('decision') === 'deny';
    const scope = form.getAll('scope').map(String);
    if ((!allowed && !denied) || allowed && (!scope.length || scope.some(value => !OWNER_SCOPES.includes(value as typeof OWNER_SCOPES[number]) || !record.scope.includes(value)))) return c.json({ error: 'select valid scopes' }, 400);
    const consumed = await c.env.DB.prepare('DELETE FROM oauth_records WHERE key=? AND expires > ? RETURNING key').bind(key, Math.floor(Date.now() / 1000)).first();
    if (!consumed) return c.json({ error: 'invalid or expired consent' }, 400);
    const protocolScopes = record.scope.filter(value => value === 'openid' || value === 'offline_access');
    const headers = new Headers(c.req.raw.headers); headers.set('Content-Type', 'application/json');
    const decision = await server.handler(new Request(authLocations(c.req.url, c.env).issuer + '/oauth2/consent', { method: 'POST', headers, body: JSON.stringify({ accept: allowed, scope: [...scope, ...protocolScopes].join(' '), oauth_query: record.query }) }));
    if (!decision.ok) return decision;
    const value = await decision.json() as { url: string };
    return c.redirect(value.url);
  });
  app.post('/oauth2/token', async c => {
    if (c.req.header('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') return c.json({ error: 'invalid_request', error_description: 'Token requests require form encoding' }, 400);
    const form = new URLSearchParams(await c.req.raw.clone().text());
    const singular = ['grant_type', 'code', 'client_id', 'client_secret', 'redirect_uri', 'code_verifier', 'refresh_token', 'scope', 'client_assertion', 'client_assertion_type'];
    if (singular.some(key => form.getAll(key).length > 1)) return c.json({ error: 'invalid_request', error_description: 'Token parameters must not repeat' }, 400);
    const verifier = form.get('code_verifier');
    if (verifier && !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return c.json({ error: 'invalid_request', error_description: 'Invalid PKCE verifier syntax' }, 400);
    const server = await authorizationServer(c.req.url, c.env);
    const code = form.get('grant_type') === 'authorization_code' && String(form.get('code') ?? '');
    // The package validates signatures and protocol bindings. This owner layer
    // makes already-issued JWTs revocable too when a code is replayed.
    const codeHash = code ? await hashCredential(code) : undefined;
    const refresh = form.get('grant_type') === 'refresh_token' && form.get('refresh_token');
    const credentialKey = codeHash ? 'code:' + codeHash : refresh ? 'refresh:' + await hashCredential(refresh) : undefined;
    const storage = new OAuthStorage(c.env.DB), seen = credentialKey ? await storage.get(credentialKey, 'json') as { client: string; family: string } | null : null;
    const response = await server.handler(c.req.raw);
    if (response.ok) {
      const value = await response.clone().json() as { access_token: string; refresh_token?: string };
      // A concurrent replay can revoke this family while native issuance runs.
      // Check shared owner revocation before returning the issued credentials.
      const credential = new Request(c.req.url, { headers: { Authorization: 'Bearer ' + value.access_token } });
      if (!await verifyBearer(credential, c.env, 'api') && !await verifyBearer(credential, c.env, 'mcp')) return c.json({ error: 'invalid_grant' }, 400);
      if (!await rememberAuthorization(c.req.url, c.env, value.access_token)) return c.json({ error: 'invalid_grant' }, 400);
      if (codeHash || value.refresh_token) {
        const payload = await server.api.delegatedAccess({ body: { token: value.access_token } });
        const family = JSON.stringify({ client: payload.client_id, family: payload.grantId });
        const expirationTtl = Number(payload.grantExpires) - Math.floor(Date.now() / 1000);
        if (codeHash) await storage.put('code:' + codeHash, family, { expirationTtl });
        if (value.refresh_token) await storage.put('refresh:' + await hashCredential(value.refresh_token), family, { expirationTtl });
      }
    } else {
      const error = await response.clone().json().catch(() => ({})) as { error?: string; error_description?: string };
      // Better Auth 1.7.7 reports this specific failed binding as invalid_request.
      // RFC 7636 §4.6 requires invalid_grant; leave parser/authentication errors intact.
      if (error.error === 'invalid_request' && error.error_description === 'code verification failed') return c.json({ ...error, error: 'invalid_grant' }, 400);
      // Native invalid_grant follows client authentication. HTTP Basic carries
      // its client id in the header, not the form. A bad secret produces
      // invalid_client and must never serve as evidence to revoke a grant.
      let clientId = form.get('client_id');
      const basic = c.req.header('authorization')?.match(/^Basic\s+(\S+)$/i);
      if (basic) {
        try { clientId = decodeURIComponent(atob(basic[1]).split(':')[0]); }
        catch { clientId = null; }
      }
      if (seen && seen.client === clientId && error.error === 'invalid_grant') await c.env.DB.prepare('INSERT OR IGNORE INTO oauth_revocations(grant_id) VALUES (?)').bind(seen.family).run();
      // RFC 6749: grant failures are 400; invalid client authentication may be 401.
      if (response.status >= 400 && response.status < 500 && error.error) return new Response(response.body, { status: error.error === 'invalid_client' ? 401 : 400, headers: response.headers });
    }
    return response;
  });
  app.post('/oauth2/register', async c => {
    const reservation = await reserveClient(c.env);
    if (!reservation) return c.json({ error: 'temporarily_unavailable', error_description: 'OAuth client storage limit reached' }, 429, { 'Retry-After': '300' });
    let response: Response;
    try { response = await (await authorizationServer(c.req.url, c.env)).handler(c.req.raw); }
    finally { await releaseClient(c.env, reservation); }
    if (response.status === 400) {
      const error = await response.clone().json().catch(() => ({})) as { error?: string };
      if (error.error === 'invalid_scope') return c.json({ ...error, error: 'invalid_client_metadata' }, 400);
    }
    return response;
  });
  app.all('/oauth2/userinfo', async c => {
    if (!await verifyBearer(c.req.raw, c.env, 'api') && !await verifyBearer(c.req.raw, c.env, 'mcp')) return c.json({ error: 'invalid_token' }, 401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
    return (await authorizationServer(c.req.url, c.env)).handler(c.req.raw);
  });
  app.post('/oauth2/introspect', async c => {
    const response = await (await authorizationServer(c.req.url, c.env)).handler(c.req.raw);
    if (!response.ok) return response;
    const value = await response.clone().json() as { active: boolean };
    if (value.active) {
      const form = new URLSearchParams(await c.req.raw.clone().text()), token = form.get('token');
      if (token && token.split('.').length === 3) {
        const request = new Request(c.req.url, { headers: { Authorization: 'Bearer ' + token } });
        if (!await verifyBearer(request, c.env, 'api') && !await verifyBearer(request, c.env, 'mcp')) return c.json({ active: false });
      } else {
        // Native introspection authenticates the issuing client and checks token
        // lifetime. Owner revocation/epoch is an additional boundary for opaque
        // refresh credentials. Unrecorded opaque profiles are not supported.
        const record = token ? await new OAuthStorage(c.env.DB).get('refresh:' + await hashCredential(token), 'json') as { client: string; family: string } | null : null;
        const grant = record ? await c.env.DB.prepare(`SELECT 1 FROM oauth_authorizations
          WHERE grant_id=? AND client_id=? AND version=? AND expires>?
          AND NOT EXISTS (SELECT 1 FROM oauth_revocations WHERE grant_id=?)`)
          .bind(record.family, record.client, await credentialVersion(c.env), Math.floor(Date.now() / 1000), record.family).first() : null;
        if (!grant) return c.json({ active: false });
      }
    }
    return response;
  });
  // Forward only protocol endpoints. Native account and client-management APIs
  // remain unreachable; Studio's cookie-only /api/authorizations owns those.
  for (const path of ['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server', '/jwks', '/oauth2/revoke']) app.all(path, async c => (await authorizationServer(c.req.url, c.env)).handler(c.req.raw));
  return app;
}
