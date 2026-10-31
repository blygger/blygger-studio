import { operationDefinitions } from './operations.ts';
import { executeRest } from './operation-rest.ts';
import { bodyLimit } from 'hono/body-limit';
import { securityLimit, admitApi, withWorkPrincipal } from './security-budgets.ts';
import { matchedRoutes } from 'hono/route';
import { contractApp } from "./contract/app.ts";
import { verifySession } from "./auth.ts";
import { verifyBearer, bearerChallenge, authLocations } from './oauth.ts';
import { matchOperation, type OwnerAccess } from './permissions.ts';
import spec from "../openapi.json";
import { isExtensionEnabled, type ServerExtension } from "./extensions/server.ts";
import { compiledServerExtensions } from "../build/extensions.server.ts";
import { authRoutes } from './contract/auth-routes.ts';

/**
 * `extensions` is the server half of the Studio extensions compiled into this
 * build (scripts/build-extensions.ts); tests pass their own. Their routes sit
 * behind the same middleware as every other route here.
 */
export function createOwnerApi(access?: OwnerAccess, extensions: readonly ServerExtension[] = compiledServerExtensions) {
const ownerApi = contractApp();
const definitions = operationDefinitions(extensions);
const compiledRoutes = [...definitions.values()].map(definition => definition.route);
const registered = new Map([...definitions].map(([id, { route }]) => [
  `${route.method.toUpperCase()} /api${route.path.replace(/\{(\w+)\}/g, ':$1')}`, [id, route] as const,
]));
const methodInventory = [...compiledRoutes, ...Object.values(authRoutes), { path: '/openapi.json', method: 'get' }].map(route => {
  const pattern = route.path.split(/(\{\w+\})/).map(part =>
    /^\{\w+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return { pattern: new RegExp(`^${pattern}/?$`), method: route.method.toUpperCase() };
});
ownerApi.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
  c.header('Cache-Control', 'no-store');
});
ownerApi.use('*', (c, next) => bodyLimit({ maxSize: securityLimit(c.env.API_BODY_LIMIT, 8 * 1024 * 1024), onError: c => c.json({ error: 'request body exceeds byte limit' }, 413) })(c, next));
ownerApi.use("*", async (c, next) => {
  const origin = c.req.header('origin');
  const authorization = c.req.header('authorization');
  const bearer = authorization && /^Bearer(?:\s|$)/i.test(authorization) ? authorization : undefined;
  const delegated = access ?? (bearer ? await verifyBearer(c.req.raw, c.env, 'api') : null);
  const operation = matchOperation(c.req.method, matchedRoutes(c).map(route => route.path), registered);
  c.set('apiAccess', delegated);
  c.set('apiExtensions', extensions);
  if (!delegated) {
    if (bearer || !await verifySession(c.env, c.req.header('cookie'))) {
      c.header('WWW-Authenticate', bearerChallenge(c.req.url, c.env, 'api'));
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (origin && origin !== new URL(c.req.url).origin || c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'cross-origin owner request denied' }, 403);
  } else {
    if (!operation) {
      if (!['GET', 'HEAD'].includes(c.req.method)) {
        c.header('WWW-Authenticate', bearerChallenge(c.req.url, c.env, 'api', '', true));
        return c.json({ error: 'unclassified write denied' }, 403);
      }
      if (!delegated.scope.includes('owner:read')) {
        c.header('WWW-Authenticate', bearerChallenge(c.req.url, c.env, 'api', 'owner:read', true));
        return c.json({ error: 'insufficient scope' }, 403);
      }
    }
  }
  // Registered operations own their shared admission in runOperation.
  if (!operation) {
    c.env = withWorkPrincipal(c.env, delegated ?? undefined);
    if (!await admitApi(c.env, ['GET', 'HEAD'].includes(c.req.method))) {
      c.header('Retry-After', '60');
      return c.json({ error: 'API work budget exceeded' }, 429);
    }
  }
  return next();
});
for (const definition of definitions.values()) {
  ownerApi.on(definition.route.method.toUpperCase(), definition.route.path.replace(/\{(\w+)\}/g, ':$1'), c => executeRest(definition, c));
}

ownerApi.get('/openapi.json', c => {
  const document = structuredClone(spec);
  const { issuer } = authLocations(c.req.url, c.env);
  document.components.securitySchemes.ownerOAuth.flows.authorizationCode.authorizationUrl = issuer + '/oauth2/authorize';
  document.components.securitySchemes.ownerOAuth.flows.authorizationCode.tokenUrl = issuer + '/oauth2/token';
  document.servers = [{ url: new URL(c.req.url).origin }];
  return c.json(document);
});

ownerApi.all("*", async (c) => {
  const path = c.req.path.replace(/^\/api(?=\/|$)/, "");
  const extension = extensions.find(extension => path.startsWith(`/ext/${extension.name}/`));
  if (extension && !await isExtensionEnabled(c.env.DB, extension.name)) return c.json({ error: `extension ${extension.name} is not enabled` }, 404);
  const methods = methodInventory.filter(route => route.pattern.test(path)).map(route => route.method);
  if (methods.length) {
    c.header("Allow", [...new Set(methods.flatMap((method) => method === "GET" ? ["GET", "HEAD"] : [method]))].join(", "));
    return c.json({ error: "method not allowed" }, 405);
  }
  return c.json({ error: "not found" }, 404);
});

return ownerApi;
}
export const ownerApi = createOwnerApi();
