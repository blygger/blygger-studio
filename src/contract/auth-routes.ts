import { createRoute, z } from '@hono/zod-openapi';
import { ErrorSchema } from './routes.ts';
import { OWNER_SCOPES } from '../permissions.ts';
const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
export const AuthorizationSchema = z.object({ id: z.string(), clientId: z.string(), name: z.string(), manual: z.boolean(), resource: z.string(), scope: z.array(z.string()), createdAt: z.number(), expiresAt: z.number().optional() }).openapi('Authorization');
function route(method: 'get' | 'post' | 'delete', path: string, operationId: string, response: z.ZodType, body?: z.ZodType) {
  return createRoute({ method, path, operationId, tags: ['authorization'], security: [{ ownerSession: [] }],
    request: { ...(path.includes('{id}') ? { params: z.object({ id: z.string().min(1) }) } : {}), ...(body ? { body: { required: true, content: json(body) } } : {}) },
    responses: { 200: { description: 'Success', content: json(response) }, ...Object.fromEntries([400, 401, 403, 404, 413, 429, 500].map(status => [status, { description: 'Request failed', content: json(ErrorSchema) }])) },
  });
}
export const authRoutes = {
  listAuthorizations: route('get', '/authorizations', 'listAuthorizations', z.object({ items: z.array(AuthorizationSchema) })),
  createAuthorization: route('post', '/authorizations', 'createAuthorization', z.object({ authorization: AuthorizationSchema, accessToken: z.string(), tokenType: z.literal('Bearer'), expiresIn: z.number() }), z.object({ name: z.string().trim().min(1).max(100), scope: z.array(z.enum(OWNER_SCOPES as [typeof OWNER_SCOPES[number], ...typeof OWNER_SCOPES[number][]])).min(1), resource: z.enum(['api', 'mcp']) }).strict()),
  revokeAuthorization: route('delete', '/authorizations/{id}', 'revokeAuthorization', z.object({ ok: z.boolean() })),
  revokeAllAuthorizations: route('delete', '/authorizations', 'revokeAllAuthorizations', z.object({ ok: z.boolean() })),
};
