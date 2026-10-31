import { admitMcp } from './security-budgets.ts';
import { createMcpHandler, McpServer, requireScopes, type Tool } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { z } from 'zod';
import type { RouteConfig } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Env } from './types.ts';
import { routes } from './contract/routes.ts';
import { createOwnerApi } from './owner-api.ts';
import { verifyBearer, bearerChallenge, authLocations } from './oauth.ts';
import { operationScopes, type OwnerAccess } from './permissions.ts';
import { responseHeaders } from './http-response.ts';

/** Decode canonical padded RFC4648 Base64 without allowing atob's whitespace tolerance. */
function mediaForm(body: unknown) {
  const { file, ...extra } = body as { file: { filename: string; contentType: string; dataBase64: string }; item_id?: string; alt?: string; inline?: string };
  const data = file.dataBase64, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
      data.endsWith('==') && (alphabet.indexOf(data.at(-3)!) & 15) !== 0 ||
      !data.endsWith('==') && data.endsWith('=') && (alphabet.indexOf(data.at(-2)!) & 3) !== 0) {
    throw new Error('dataBase64 must be canonical padded Base64');
  }
  const decoded = atob(data), bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  const form = new FormData();
  form.set('file', new File([bytes], file.filename, { type: file.contentType }));
  for (const [name, value] of Object.entries(extra)) if (value !== undefined) form.set(name, value);
  return form;
}

// Only immutable schema metadata is shared. Servers, handlers and access stay
// request-local so one client cannot inherit another client's capabilities.
const toolDefinitions = Object.entries(routes).map(([name, definition]) => {
  const route: RouteConfig = definition;
  const body = (route.request?.body?.content['application/json'] as { schema?: z.ZodType } | undefined)?.schema as z.ZodType | undefined;
  const fields: Record<string, z.ZodType> = {};
  if (route.request?.params) fields.path = route.request.params as z.ZodType;
  if (route.request?.query) fields.query = (route.request.query as z.ZodObject).optional();
  if (name === 'uploadMedia') fields.body = z.object({ file: z.object({ filename: z.string(), contentType: z.string(), dataBase64: z.string().describe('Canonical padded Base64. Decoded image file limit: 5 MiB.') }).strict(), item_id: z.string().optional(), alt: z.string().optional(), inline: z.enum(['true', 'false']).optional() }).strict();
  else if (body) fields.body = route.request!.body!.required ? body : body.optional();
  const inputSchema = z.object(fields).strict();
  const description = `${route.method.toUpperCase()} /api${route.path}. Required scopes: ${operationScopes(name).join(', ')}.${name === 'createItem' || name === 'updateItem' ? ' For generated text, record provenance alongside TK scopes; provenance is client-asserted.' : ''}`;
  const annotations = { readOnlyHint: route.method === 'get', destructiveHint: route.method !== 'get', openWorldHint: true };
  return { name, route, inputSchema, description, annotations, scopes: operationScopes(name), wireSchema: z.toJSONSchema(inputSchema, { io: 'input' }) as Tool['inputSchema'] };
});

/** MCP dispatches in-process through the REST handlers and their Zod validators.
 * Media uses a Base64-to-multipart transport adapter; REST owns media policy. */
export async function serveMcp(request: Request, env: Env, ctx: Context['executionCtx']) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: 'cross-origin MCP request denied' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  const access = await verifyBearer(request, env, 'mcp');
  if (!access) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'WWW-Authenticate': bearerChallenge(request.url, env, 'mcp'), 'Cache-Control': 'no-store' } });
  if (!await admitMcp(env, access)) return Response.json({ error: 'MCP request budget exceeded' }, { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } });
  return serveAuthorizedMcp(request, env, ctx, access);
}

/** Shared tool dispatcher. Call only after the credential has been verified. */
export async function serveAuthorizedMcp(request: Request, env: Env, ctx: Context['executionCtx'], access: OwnerAccess) {
  const api = new Hono<{ Bindings: Env }>().route('/api', createOwnerApi(access));
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'blygger-studio', version: '1.0.0' });
    const visibleTools: Tool[] = [];
    for (const { name, route, inputSchema, description, annotations, scopes, wireSchema } of toolDefinitions) {
      if (scopes.every(scope => access.scope.includes(scope))) {
        visibleTools.push({ name, description, inputSchema: wireSchema, annotations });
      }
      server.registerTool(name, { description, inputSchema, annotations, scopeChallenge: context => {
        const required = [...scopes];
        const args = context.request.params?.arguments as { body?: { responses?: unknown; highlight?: unknown; avatar_media_id?: unknown } } | undefined;
        // Editing response display changes the public page, just as in REST.
        if (name === 'updateItem' && (args?.body?.responses !== undefined || args?.body?.highlight !== undefined)) required.push('owner:publish');
        if (name === 'updateSettings' && args?.body?.avatar_media_id !== undefined) required.push('owner:publish');
        return requireScopes(...required as [string, ...string[]])(context);
      } }, async input => {
        const args = input as { path?: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown };
        const path = route.path.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(String(args.path?.[key])));
        const url = new URL('/api' + path, request.url);
        for (const [key, value] of Object.entries(args.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
        const requestBody = args.body === undefined ? {} : name === 'uploadMedia' ? { body: mediaForm(args.body) } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args.body) };
        const response = await api.fetch(new Request(url, { method: route.method.toUpperCase(), ...requestBody }), env, ctx);
        const value = await response.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: !response.ok };
      });
    }
    // All tools retain their scope gates; discovery shows only granted capabilities.
    server.server.setRequestHandler('tools/list', () => ({ tools: visibleTools }));
    return server;
  }, { // 5 MiB media expands to about 6.67 MiB Base64, plus the JSON envelope.
    maxRequestBodySize: 8 * 1024 * 1024,
  });
  try {
    const response = await handler.fetch(request, { authInfo: { token: request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '', clientId: access.clientId, scopes: access.scope, resource: new URL(authLocations(request.url, env).mcp), resourceMetadataUrl: authLocations(request.url, env).base + '/auth/resources/mcp' } });
    return responseHeaders(response, { 'Cache-Control': 'no-store', ...(response.status === 405 ? { Allow: 'POST' } : {}) });
  } finally {
    // Stateless tools finish within this request. No Durable Object or session storage.
    await handler.close();
  }
}
