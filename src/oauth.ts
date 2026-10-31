import { deploymentUrls } from './deployment-urls.ts';
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { getOAuthProviderApi, oauthProvider, type OAuthOptions } from '@better-auth/oauth-provider';
import { z } from 'zod';
import type { Env } from './types.ts';
import { OWNER_SCOPES, type OwnerAccess } from './permissions.ts';
import { verifySession, sessionAuthenticatedAt } from './auth.ts';
import { hex } from './util.ts';

export function authLocations(url: string, env: Env) {
  const { studio: base, issuer, api, mcp } = deploymentUrls(url, env);
  return { base, issuer, api, mcp };
}
export async function hashCredential(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
export async function credentialVersion(env: Env) {
  const epoch = (await env.DB.prepare('SELECT epoch FROM oauth_state WHERE id = 1').first<{ epoch: number }>())!.epoch;
  // Delegated grants survive owner-password reset (decision #31). Their
  // authority changes only with signing-secret rotation or explicit revoke-all.
  return hashCredential(JSON.stringify([env.COOKIE_SECRET, epoch]));
}
async function grantReference(env: Env, createdAt: Date = new Date(Date.now()), manual = false) { return await credentialVersion(env) + '.' + (Math.floor(new Date(createdAt).getTime() / 1000) + 30 * 86400) + (manual ? '.' + crypto.randomUUID() : ''); }
async function grantClaims(env: Env, reference?: string) {
  const [version, deadline, grantId] = (reference ?? '').split('.'), expires = Number(deadline);
  if (grantId && await env.DB.prepare('SELECT grant_id FROM oauth_revocations WHERE grant_id=?').bind(grantId).first() || version !== await credentialVersion(env) || !Number.isInteger(expires) || expires <= Math.floor(Date.now() / 1000)) throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Authorization has expired or been revoked' });
  return { credentialVersion: version, grantExpires: expires, ...(grantId ? { grantId } : {}) };
}
const manualBody = z.object({ clientId: z.string(), scope: z.array(z.enum(OWNER_SCOPES)).min(1), resource: z.enum(['api', 'mcp']) }).strict();

/** Exported configuration also supplies the native schema generator. */
export async function betterAuthOptions(url: string, env: Env, manual = false) {
  const locations = authLocations(url, env), path = new URL(locations.issuer).pathname;
  const oauth: OAuthOptions<string[]> = {
    scopes: ['openid', 'offline_access', ...OWNER_SCOPES],
    loginPage: locations.base + '/login', consentPage: locations.issuer + '/consent',
    allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true,
    grantTypes: ['authorization_code', 'refresh_token'],
    accessTokenExpiresIn: manual ? 30 * 86400 : 3600, refreshTokenExpiresIn: 30 * 86400,
    resources: [locations.api, locations.mcp], clientRegistrationDefaultResources: [locations.api, locations.mcp],
    clientPrivileges: ({ user }) => user?.id === 'owner',
    postLogin: { page: locations.issuer + '/consent', shouldRedirect: () => false, consentReferenceId: ({ session }) => grantReference(env, session?.createdAt) },
    customAccessTokenClaims: ({ referenceId }) => grantClaims(env, referenceId),
    extensions: [{ claims: { accessToken: async info => {
      const provider = getOAuthProviderApi(info.ctx, oauth);
      let codeId: string | undefined;
      if (info.grantType === 'authorization_code') codeId = await provider.hashToken(info.ctx.body.code, 'authorization_code');
      if (info.grantType === 'refresh_token') {
        const stored = await provider.hashToken(info.ctx.body.refresh_token, 'refresh_token');
        const row = await info.ctx.context.adapter.findOne<{ authorizationCodeId?: string }>({ model: 'oauthRefreshToken', where: [{ field: 'token', value: stored }] });
        codeId = row?.authorizationCodeId;
      }
      if (codeId && await env.DB.prepare('SELECT grant_id FROM oauth_revocations WHERE grant_id = ?').bind(codeId).first()) throw new APIError('BAD_REQUEST', { error: 'invalid_grant' });
      return codeId ? { authorizationCodeId: codeId, grantId: codeId } : {};
    } } }],
  };
  const owner = async (headers?: Headers) => {
    if (/^Bearer(?:\s|$)/i.test(headers?.get('authorization') ?? '') || !await verifySession(env, headers?.get('cookie') ?? undefined)) throw new APIError('UNAUTHORIZED');
    const origin = headers?.get('origin');
    if (origin && origin !== new URL(url).origin || headers?.get('sec-fetch-site') === 'cross-site') throw new APIError('FORBIDDEN');
  };
  return {
    database: env.DB, baseURL: new URL(url).origin, basePath: path,
    secret: await hashCredential(env.COOKIE_SECRET),
    // Dependency failures can carry SQL parameters or credentials in messages
    // and Error stacks. Keep the native logger, but emit only a bounded event.
    logger: { level: 'warn' as const, log: (level: 'debug' | 'info' | 'warn' | 'error') => {
      if (level === 'error') console.error('OAuth provider event', level);
      else console.warn('OAuth provider event', level);
    } },
    // Let the outer Worker sanitize unexpected failures. Better Call preserves
    // native APIError responses, but its fallback otherwise logs raw Errors.
    onAPIError: { throw: true },
    session: { expiresIn: 30 * 86400 },
    // Only the OAuth surface and mounted discovery are forwarded by oauth-routes.
    disabledPaths: ['/token', '/sign-up/email', '/sign-in/email'],
    // Workers do not imply NODE_ENV=production. D1 shares counters across
    // isolates; the proxy must overwrite this authoritative address header.
    rateLimit: { enabled: true, storage: 'database' as const, customRules: { '/internal/owner-login-budget': { window: 60, max: 5 } } },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] }, defaultCookieAttributes: { path, sameSite: 'lax' as const } },
    plugins: [jwt({ jwks: { keyPairConfig: { alg: 'RS256' as const } } }), oauthProvider(oauth), {
      id: 'blygger-owner', endpoints: {
        ownerLoginBudget: createAuthEndpoint('/internal/owner-login-budget', { method: 'POST' }, async ctx => ctx.json({ ok: true })),
        ownerSession: createAuthEndpoint('/internal/owner-session', { method: 'POST', metadata: { SERVER_ONLY: true }, body: z.object({ oauth_query: z.string().optional() }) }, async ctx => {
          await owner(ctx.headers);
          let user = await ctx.context.internalAdapter.findUserById('owner');
          if (!user) {
            try { user = await ctx.context.internalAdapter.createUser({ id: 'owner', name: 'Owner', email: 'owner@blygger.invalid', emailVerified: true }, { method: 'admin' }); }
            catch (error) { user = await ctx.context.internalAdapter.findUserById('owner'); if (!user) throw error; }
          }
          // Only the password-checked SPA continuation supplies oauth_query.
          // Ordinary cookie bridges retain the signed owner's original age.
          const authenticatedAt = ctx.body.oauth_query ? new Date(Date.now()) : await sessionAuthenticatedAt(env, ctx.headers?.get('cookie') ?? undefined);
          if (!authenticatedAt) throw new APIError('UNAUTHORIZED');
          const session = await ctx.context.internalAdapter.createSession(user.id, false, { createdAt: authenticatedAt }, true);
          await setSessionCookie(ctx, { user, session });
          return ctx.json({ ok: true });
        }),
        delegatedAccess: createAuthEndpoint('/internal/access', { method: 'POST', metadata: { SERVER_ONLY: true }, body: z.object({ token: z.string() }) }, async ctx => await getOAuthProviderApi(ctx, oauth).requireActiveAccessToken(ctx.body.token)),
        issueManual: createAuthEndpoint('/internal/manual', { method: 'POST', metadata: { SERVER_ONLY: true }, body: manualBody }, async ctx => {
          await owner(ctx.headers);
          const provider = getOAuthProviderApi(ctx, oauth, 'urn:blygger:manual');
          const client = await provider.getClient(ctx.body.clientId), user = await ctx.context.internalAdapter.findUserById('owner');
          if (!client || client.userId !== 'owner' || !user) throw new APIError('UNAUTHORIZED');
          return provider.issueTokens({ client, user, scopes: ctx.body.scope, resources: [locations[ctx.body.resource]], referenceId: await grantReference(env, new Date(Date.now()), true) });
        }),
      },
    }],
  };
}
async function createAuthorizationServer(url: string, env: Env, manual: boolean) {
  const secretVersion = await hashCredential(env.COOKIE_SECRET);
  // D1 batch is atomic: rotate encrypted signing keys when their wrapping secret
  // changes. Native cookies rotate too; credential version rejects old credentials.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM jwks WHERE (SELECT secret_version FROM oauth_state WHERE id=1) IS NOT NULL AND (SELECT secret_version FROM oauth_state WHERE id=1) <> ?').bind(secretVersion),
    env.DB.prepare('UPDATE oauth_state SET secret_version = ? WHERE id=1 AND (secret_version IS NULL OR secret_version <> ?)').bind(secretVersion, secretVersion),
  ]);
  return betterAuth(await betterAuthOptions(url, env, manual));
}
// Cache provider configuration, never credentials or authorization decisions.
// Each DB binding owns an isolated, bounded cache. Live epoch/revocation checks
// remain in grantClaims/verifyBearer so cache hits cannot resurrect a grant.
type AuthorizationServer = Awaited<ReturnType<typeof createAuthorizationServer>>;
const servers = new WeakMap<Env['DB'], { secret: string; configurations: Map<string, Promise<AuthorizationServer>> }>();
export async function authorizationServer(url: string, env: Env, manual = false) {
  const secret = await hashCredential(env.COOKIE_SECRET);
  const key = JSON.stringify([authLocations(url, env).issuer, await hashCredential(env.OWNER_PASSWORD), manual]);
  let cache = servers.get(env.DB);
  if (!cache || cache.secret !== secret) {
    cache = { secret, configurations: new Map() };
    servers.set(env.DB, cache);
  }
  let server = cache.configurations.get(key);
  if (!server) {
    if (cache.configurations.size >= 16) cache.configurations.delete(cache.configurations.keys().next().value!);
    server = createAuthorizationServer(url, env, manual);
    cache.configurations.set(key, server);
    const entry = cache;
    server.catch(() => { if (entry.configurations.get(key) === server) entry.configurations.delete(key); });
  }
  return server;
}
/** Enter the native HTTP limiter before checking the separate owner password.
 * This endpoint is never forwarded by oauth-routes; direct auth.api calls
 * would bypass Better Auth's HTTP rate limiter.
 */
export async function ownerLoginRateLimit(request: Request, env: Env): Promise<Response | null> {
  const server = await authorizationServer(request.url, env);
  const headers = new Headers(request.headers);
  headers.set('Content-Type', 'application/json');
  const response = await server.handler(new Request(authLocations(request.url, env).issuer + '/internal/owner-login-budget', { method: 'POST', headers, body: '{}' }));
  return response.ok ? null : response;
}
export async function ownerHeaders(request: Request, server: Awaited<ReturnType<typeof authorizationServer>>) {
  const headers = new Headers(request.headers);
  const session = await server.api.getSession({ headers });
  if (session?.user.id === 'owner') return { headers, cookies: [] as string[] };
  const response = await server.api.ownerSession({ headers, body: {}, asResponse: true });
  if (!response.ok) throw new Error('Owner bridge failed');
  const cookies = response.headers.getSetCookie();
  headers.set('cookie', [headers.get('cookie'), ...cookies.map(cookie => cookie.split(';')[0])].filter(Boolean).join('; '));
  return { headers, cookies };
}
export function bearerChallenge(url: string, env: Env, resource: 'api' | 'mcp', scope = 'owner:read', insufficient = false) {
  const { base } = authLocations(url, env);
  return `Bearer resource_metadata="${base}/auth/resources/${resource}", scope="${scope}"${insufficient ? ', error="insufficient_scope"' : ''}`;
}
export async function verifyBearer(request: Request, env: Env, resource: 'api' | 'mcp'): Promise<OwnerAccess | null> {
  const header = request.headers.get('authorization');
  if (!header || !/^Bearer\s+\S+$/i.test(header)) return null;
  try {
    const server = await authorizationServer(request.url, env);
    const validated = await server.api.delegatedAccess({ body: { token: header.replace(/^Bearer\s+/i, '') } });
    const audience = Array.isArray(validated.aud) ? validated.aud : [validated.aud];
    if (validated.sub !== 'owner' || validated.cnf || !audience.includes(authLocations(request.url, env)[resource]) || validated.credentialVersion !== await credentialVersion(env)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof validated.exp !== 'number' || validated.exp <= now || typeof validated.grantExpires !== 'number' || validated.grantExpires <= now) return null;
    if (typeof validated.grantId !== 'string' || await env.DB.prepare('SELECT grant_id FROM oauth_revocations WHERE grant_id = ?').bind(validated.grantId).first()) return null;
    if (typeof validated.authorizationCodeId === 'string' && await env.DB.prepare('SELECT grant_id FROM oauth_revocations WHERE grant_id = ?').bind(validated.authorizationCodeId).first()) return null;
    if (typeof validated.client_id !== 'string' || typeof validated.scope !== 'string') return null;
    return { scope: validated.scope.split(' '), clientId: validated.client_id, userId: 'owner', grantId: validated.grantId };
  } catch { return null; }
}
export async function revokeGrant(_url: string, env: Env, id: string) {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO oauth_revocations(grant_id) SELECT grant_id FROM oauth_authorizations WHERE grant_id=?').bind(id),
    // Remove the owner's remembered approval before deleting its lookup row.
    // Other same-client access grants remain valid, but a new grant needs consent.
    env.DB.prepare('DELETE FROM oauthConsent WHERE userId=? AND clientId IN (SELECT client_id FROM oauth_authorizations WHERE grant_id=?)').bind('owner', id),
    env.DB.prepare('DELETE FROM oauth_authorizations WHERE grant_id=?').bind(id),
  ]);
}
export async function revokeAll(_url: string, env: Env) {
  await env.DB.prepare('UPDATE oauth_state SET epoch = epoch + 1 WHERE id = 1').run();
  await env.DB.prepare('DELETE FROM oauth_authorizations WHERE version <> ?').bind(await credentialVersion(env)).run();
}
export async function rememberAuthorization(url: string, env: Env, accessToken: string, manual = false) {
  const server = await authorizationServer(url, env), value = await server.api.delegatedAccess({ body: { token: accessToken } });
  if (typeof value.client_id !== 'string' || typeof value.grantId !== 'string') throw new Error('Issued credential has no client');
  const client = await (await server.$context).adapter.findOne<{ name?: string }>({ model: 'oauthClient', where: [{ field: 'clientId', value: value.client_id }] });
  const locations = authLocations(url, env), audiences = Array.isArray(value.aud) ? value.aud : [value.aud];
  const resource = [locations.api, locations.mcp].filter(audience => audiences.includes(audience)).join(' ');
  const epoch = (await env.DB.prepare('SELECT epoch FROM oauth_state WHERE id=1').first<{epoch:number}>())!.epoch;
  if (value.credentialVersion !== await credentialVersion(env)) return false;
  // Recording and the tombstone check share one SQL statement. A completed
  // revoke must win even when issuance already validated the access credential.
  const result = await env.DB.prepare('INSERT INTO oauth_authorizations(grant_id,client_id,name,manual,resource,scopes,created,expires,version) SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM oauth_revocations WHERE grant_id=?) AND (SELECT epoch FROM oauth_state WHERE id=1)=? ON CONFLICT(grant_id) DO UPDATE SET resource=excluded.resource, scopes=excluded.scopes, expires=excluded.expires, version=excluded.version')
    .bind(value.grantId, value.client_id, client?.name ?? value.client_id, manual ? 1 : 0, resource, JSON.stringify(String(value.scope).split(' ').filter(scope => OWNER_SCOPES.includes(scope as typeof OWNER_SCOPES[number]))), Math.floor(Date.now() / 1000), value.grantExpires, value.credentialVersion, value.grantId, epoch).run();
  return result.meta.changes > 0;
}
