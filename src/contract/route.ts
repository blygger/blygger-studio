import { API_ERROR_CODES } from '../api-error.ts';
// The route builder every /api operation is declared with: the base contract
// (routes.ts) and extension routes (src/extensions/contract.ts) alike. Its own
// module so an extension's contract can use it without importing routes.ts,
// which imports the extension catalog.
import { optionalJsonBody } from "./app.ts";
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { OperationPolicy } from '../operation-policy.ts';

export const json = (schema: z.ZodType) => ({ "application/json": { schema } });
export const ErrorSchema = z.object({
  code: z.enum(API_ERROR_CODES),
  message: z.string(),
  details: z.object({
    issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
    errors: z.array(z.object({ reason: z.string().optional(), at: z.number().optional(), id: z.string().optional(), directive: z.string().optional() }).passthrough()).optional(),
    tried: z.array(z.string()).optional(),
    itemId: z.string().optional(), mediaId: z.string().optional(), expectedRevision: z.number().int().positive().optional(),
  }).passthrough().optional(),
}).strict().openapi("ApiError");

export function route<P extends string>(id: string, policy: OperationPolicy, method: RouteConfig["method"], path: P, response: z.ZodType, body?: z.ZodType, status = 200, query?: z.ZodObject, optionalBody = false): RouteConfig & { path: P; policy: OperationPolicy } {
  if (body instanceof z.ZodObject) body = body.strict();
  const params = Object.fromEntries([...path.matchAll(/\{(\w+)\}/g)].map((m) => [m[1], ["v", "version"].includes(m[1]) ? z.coerce.number().int().positive() : z.string().min(1)]));
  return createRoute({ policy,
    operationId: id, method, path, ...(body ? { middleware: optionalBody ? optionalJsonBody : undefined } : {}), tags: ["studio"], security: [{ ownerSession: [] }],
    request: { ...(Object.keys(params).length ? { params: z.object(params) } : {}), ...(query ? { query } : {}), ...(body ? { body: { required: !optionalBody, content: json(body) } } : {}) },
    responses: { [status]: { description: "Success", content: json(response) }, ...Object.fromEntries([400, 401, 403, 404, 405, 409, 413, 415, 422, 429, 500, 502].map((s) => [s, { description: "Request failed", content: json(ErrorSchema) }])) },
  });
}
