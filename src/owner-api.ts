import { bodyLimit } from 'hono/body-limit';
import { securityLimit, admitApi, withWorkPrincipal } from './security-budgets.ts';
import { matchedRoutes } from 'hono/route';
import { routes } from "./contract/routes.ts";
import { contractApp } from "./contract/app.ts";
import { verifySession } from "./auth.ts";
import { api } from "./api.ts";
import { importerApi } from "./importer/api.ts";
import { mentionsApi } from "./mentions/api.ts";
import { verifyBearer, bearerChallenge, authLocations } from './oauth.ts';
import { matchOperation, operationScopes, type OwnerAccess } from './permissions.ts';
import spec from "../openapi.json";
import { readApi } from "./read-api.ts";
import { extensionApi, type ServerExtension } from "./extensions/server.ts";
import { compiledServerExtensions } from "../build/extensions.server.ts";
import { authRoutes } from './contract/auth-routes.ts';

/**
 * `extensions` is the server half of the Studio extensions compiled into this
 * build (scripts/build-extensions.ts); tests pass their own. Their routes sit
 * behind the same middleware as every other route here.
 */
export function createOwnerApi(access?: OwnerAccess, extensions: readonly ServerExtension[] = compiledServerExtensions) {
const ownerApi = contractApp();
const compiledRoutes = Object.values(routes).filter(route => !route.policy.extension || extensions.some(extension => extension.name === route.policy.extension));
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
  const operation = matchOperation(c.req.method, matchedRoutes(c).map(route => route.path));
  c.set('apiAccess', delegated);
  c.set('apiExtensions', extensions);
  if (!delegated) {
    if (bearer || !await verifySession(c.env, c.req.header('cookie'))) {
      c.header('WWW-Authenticate', bearerChallenge(c.req.url, c.env, 'api'));
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (origin && origin !== new URL(c.req.url).origin || c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'cross-origin owner request denied' }, 403);
  } else {
    c.set('draftOnlyMedia', !delegated.scope.includes('owner:publish'));
    if (!operation && !['GET', 'HEAD'].includes(c.req.method)) {
      c.header('WWW-Authenticate', bearerChallenge(c.req.url, c.env, 'api', '', true));
      return c.json({ error: 'unclassified write denied' }, 403);
    }
    const input = operation?.[1].policy.conditionalScopes
      ? { body: await c.req.raw.clone().json().catch(() => undefined) } : undefined;
    const required = operation ? operationScopes(operation[0], input) : ['owner:read'];
    if (required.some(scope => !delegated.scope.includes(scope))) {
      c.header('WWW-Authenticate', bearerChallenge(c.req.url, c.env, 'api', required.join(' '), true));
      return c.json({ error: 'insufficient scope' }, 403);
    }
  }
  c.env = withWorkPrincipal(c.env, delegated ?? undefined);
  const reads = operation ? operation[1].policy.budget === 'read' : ['GET', 'HEAD'].includes(c.req.method);
  if (!await admitApi(c.env, reads)) {
    c.header('Retry-After', '60');
    return c.json({ error: 'API work budget exceeded' }, 429);
  }
  return next();
});
ownerApi.route("/", api);
ownerApi.route("/", importerApi);
ownerApi.route("/", mentionsApi);
ownerApi.route("/", readApi);
ownerApi.route("/", extensionApi(extensions));

ownerApi.get('/openapi.json', c => {
  const document = structuredClone(spec);
  const { issuer } = authLocations(c.req.url, c.env);
  document.components.securitySchemes.ownerOAuth.flows.authorizationCode.authorizationUrl = issuer + '/oauth2/authorize';
  document.components.securitySchemes.ownerOAuth.flows.authorizationCode.tokenUrl = issuer + '/oauth2/token';
  document.servers = [{ url: new URL(c.req.url).origin }];
  return c.json(document);
});

ownerApi.all("*", (c) => {
  const path = c.req.path.replace(/^\/api(?=\/|$)/, "");
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
