import { deploymentPaths } from './util.ts';
import { bodyLimit } from 'hono/body-limit';
import { securityLimit, admitApi } from './security-budgets.ts';
import { contractApp, readJson } from './contract/app.ts';
import { authRoutes, AuthorizationSchema } from './contract/auth-routes.ts';
import type { OwnerScope } from './auth-scopes.ts';
import { verifySession } from './auth.ts';
import { authorizationServer, ownerHeaders, credentialVersion, authLocations, rememberAuthorization, revokeGrant, revokeAll } from './oauth.ts';

export const authorizationApi = contractApp();
authorizationApi.use('*', async (c, next) => {
  const prefix = deploymentPaths(c.env.MOUNT).api + '/authorizations';
  if (c.req.path !== prefix && !c.req.path.startsWith(prefix + '/')) return next();
  c.header('Cache-Control', 'no-store');
  if (/^Bearer(?:\s|$)/i.test(c.req.header('authorization') ?? '') || !await verifySession(c.env, c.req.header('cookie'))) return c.json({ error: 'owner session required' }, 401);
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin || c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'cross-origin owner request denied' }, 403);
  if (!await admitApi(c.env, ['GET', 'HEAD'].includes(c.req.method))) return c.json({ error: 'API work budget exceeded' }, 429, { 'Retry-After': '60' });
  return bodyLimit({ maxSize: securityLimit(c.env.API_BODY_LIMIT, 8 * 1024 * 1024), onError: c => c.json({ error: 'request body exceeds byte limit' }, 413) })(c, next);
});
export async function authorizationResources(env: import('./types.ts').Env) {
  const { results } = await env.DB.prepare('SELECT * FROM oauth_authorizations WHERE version=? AND expires > ? AND NOT EXISTS (SELECT 1 FROM oauth_revocations WHERE grant_id=oauth_authorizations.grant_id) ORDER BY created,grant_id').bind(await credentialVersion(env), Math.floor(Date.now() / 1000)).all<{ grant_id: string; client_id: string; name: string; manual: number; resource: string; scopes: string; created: number; expires: number }>();
  return results.map(row => AuthorizationSchema.parse({ id: row.grant_id, clientId: row.client_id, name: row.name, manual: row.manual === 1, resource: row.resource, scope: JSON.parse(row.scopes), createdAt: row.created, expiresAt: row.expires }));
}
authorizationApi.openapi(authRoutes.listAuthorizations, async c => c.json({ items: await authorizationResources(c.env) }));
authorizationApi.openapi(authRoutes.createAuthorization, async c => {
  const body = await readJson<{ name: string; scope: OwnerScope[]; resource: 'api' | 'mcp' }>(c);
  const server = await authorizationServer(c.req.url, c.env, true), { headers } = await ownerHeaders(c.req.raw, server);
  const locations = authLocations(c.req.url, c.env);
  const host = new URL(locations.issuer).hostname;
  const applicationType = ['localhost', '127.0.0.1', '[::1]'].includes(host) ? 'native' : 'web';
  const client = await server.api.adminCreateOAuthClient({ headers, body: { client_name: body.name, application_type: applicationType, redirect_uris: [locations.issuer + '/manual-callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: body.scope.join(' ') } });
  const token = await server.api.issueManual({ headers: c.req.raw.headers, body: { clientId: client.client_id, scope: body.scope, resource: body.resource } });
  await rememberAuthorization(c.req.url, c.env, token.access_token, true);
  const authorization = (await authorizationResources(c.env)).find(value => value.clientId === client.client_id)!;
  return c.json({ authorization, access_token: token.access_token, token_type: 'Bearer' as const, expires_in: token.expires_in });
});
authorizationApi.openapi(authRoutes.revokeAuthorization, async c => { await revokeGrant(c.req.url, c.env, c.req.param('id')!); return c.json({ ok: true }); });
authorizationApi.openapi(authRoutes.revokeAllAuthorizations, async c => { await revokeAll(c.req.url, c.env); return c.json({ ok: true }); });
