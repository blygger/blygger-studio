import { admitMcp } from './security-budgets.ts';
import { createMcpHandler, McpServer, requireScopes, type Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RouteConfig } from '@hono/zod-openapi';
import type { OperationPolicy } from './operation-policy.ts';
import type { Context } from 'hono';
import type { Env } from './types.ts';
import { routes } from './contract/routes.ts';
import { operationDefinitions } from './operations.ts';
import { runOperation } from './operation-runner.ts';
import { failure, type MediaInput } from './operation-types.ts';
import { verifyBearer, bearerChallenge, authLocations } from './oauth.ts';
import { operationScopes, type OwnerAccess } from './permissions.ts';
import { responseHeaders } from './http-response.ts';
import { operationHints, API_CONTRACT_VERSION } from './operation-policy.ts';
import { operationAvailability } from './operation-availability.ts';
import { compiledServerExtensions } from '../build/extensions.server.ts';
import type { ServerExtension } from './extensions/server.ts';

/** Decode canonical padded RFC4648 Base64 without allowing atob's whitespace tolerance. */
function mediaInput(body: unknown): MediaInput {
  const { file, ...extra } = body as { file: { filename: string; contentType: string; dataBase64: string }; item_id?: string; alt?: string; inline?: string };
  const data = file.dataBase64, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
      data.endsWith('==') && (alphabet.indexOf(data.at(-3)!) & 15) !== 0 ||
      !data.endsWith('==') && data.endsWith('=') && (alphabet.indexOf(data.at(-2)!) & 3) !== 0) {
    throw new Error('dataBase64 must be canonical padded Base64');
  }
  const decoded = atob(data), bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return { file: { bytes, mime: /^[\x20-\x7e]*$/.test(file.contentType) ? file.contentType.toLowerCase() : '', name: file.filename }, itemId: extra.item_id, alt: extra.alt, inline: extra.inline === 'true' };
}

// Only immutable schema metadata is shared. Servers, handlers and access stay
// request-local so one client cannot inherit another client's capabilities.
const toolDefinitions = Object.entries(routes).map(([name, definition]) => {
  const route: RouteConfig & { policy: OperationPolicy } = definition;
  const body = (route.request?.body?.content['application/json'] as { schema?: z.ZodType } | undefined)?.schema as z.ZodType | undefined;
  const fields: Record<string, z.ZodType> = {};
  if (route.request?.params) fields.path = route.request.params as z.ZodType;
  if (route.request?.query) fields.query = (route.request.query as z.ZodObject).optional();
  if (name === 'uploadMedia') fields.body = z.object({ file: z.object({ filename: z.string(), contentType: z.string(), dataBase64: z.string().describe('Canonical padded Base64. Decoded image file limit: 5 MiB.') }).strict(), item_id: z.string().optional(), alt: z.string().optional(), inline: z.enum(['true', 'false']).optional() }).strict();
  else if (body) fields.body = route.request!.body!.required ? body : body.optional();
  const inputSchema = z.object(fields).strict();
  const description = `${route.method.toUpperCase()} {api}${route.path}. Required scopes: ${operationScopes(name).join(', ') || 'any authenticated identity'}.${route.policy.conditionalScopes ? ' ' + route.policy.conditionalScopes.description : ''}${route.policy.scopeNotes ? ' ' + route.policy.scopeNotes : ''}${name === 'createItem' || name === 'updateItem' ? ' For generated text, record provenance alongside TK scopes; provenance is client-asserted.' : ''}`;
  const annotations = operationHints(route.policy);
  return { name, route, inputSchema, description, annotations, wireSchema: z.toJSONSchema(inputSchema, { io: 'input' }) as Tool['inputSchema'] };
});

/** MCP supplies decoded arguments to the same operation runner as REST. */
export async function serveMcp(request: Request, env: Env, ctx: Context['executionCtx']) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: 'cross-origin MCP request denied' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  const access = await verifyBearer(request, env, 'mcp');
  if (!access) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'WWW-Authenticate': bearerChallenge(request.url, env, 'mcp'), 'Cache-Control': 'no-store' } });
  if (!await admitMcp(env, access)) return Response.json({ error: 'MCP request budget exceeded' }, { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } });
  return serveAuthorizedMcp(request, env, ctx, access);
}

/** Shared tool dispatcher. Call only after the credential has been verified. */
export async function serveAuthorizedMcp(request: Request, env: Env, ctx: Context['executionCtx'], access: OwnerAccess, extensions: readonly ServerExtension[] = compiledServerExtensions) {
  const definitions = operationDefinitions(extensions);
  const handler = createMcpHandler(() => {
    const apiBase = authLocations(request.url, env).api;
    const tools = toolDefinitions.map(tool => ({ ...tool, description: tool.description.replace('{api}', apiBase) }));
    const server = new McpServer({ name: 'blygger-studio', version: API_CONTRACT_VERSION });
    for (const { name, route, inputSchema, description, annotations } of tools) {
      server.registerTool(name, { description, inputSchema, annotations, scopeChallenge: context => {
        const args = context.request.params?.arguments as { body?: unknown } | undefined;
        const required = operationScopes(name, args);
        return required.length ? requireScopes(...required as [string, ...string[]])(context) : undefined;
      } }, async input => {
        const args = input as { path?: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown };
        let media: MediaInput | undefined;
        if (name === 'uploadMedia') {
          try { media = mediaInput(args.body); } catch (error) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: (error as Error).message }) }], isError: true };
          }
        }
        const definition = definitions.get(name) ?? { route, handler: async () => failure('not-found', { error: 'not found' }) };
        const strings = (values: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, String(value)]));
        const result = await runOperation(definition, { path: strings(args.path), query: strings(args.query), body: media ? undefined : args.body, media },
          { env, url: request.url, access, extensions, defer: task => ctx.waitUntil(task) });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.value) }], isError: !result.ok };
      });
    }
    // All tools retain their scope gates; discovery shows only granted capabilities.
    server.server.setRequestHandler('tools/list', async () => {
      let available;
      try { available = await operationAvailability(env.DB, access, extensions); }
      catch (error) {
        console.error('MCP discovery failed', { errorType: error instanceof Error ? error.name : typeof error });
        throw new Error('internal server error');
      }
      return { tools: tools.filter(tool => available.operations.includes(tool.name)).map(({ name, description, wireSchema, annotations }) =>
        ({ name, description, inputSchema: wireSchema, annotations })) };
    });
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
