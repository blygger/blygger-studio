import { statusError } from '../api-error.ts';
import { schemaError } from '../schema-error.ts';
import { requestError } from '../request-error.ts';
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../types.ts";
import type { OwnerAccess } from '../permissions.ts';
import type { ServerExtension } from '../extensions/server.ts';

declare module 'hono' {
  interface ContextVariableMap {
    apiAccess: OwnerAccess | null;
    apiExtensions: readonly ServerExtension[];
  }
}

export function contractApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>({ strict: false, defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(schemaError(result.error), 400);
    }
  } });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json(statusError(error.status, error.message), error.status);
    console.error('API request failed', requestError(error, c));
    return c.json(statusError(500, "internal server error"), 500);
  });
  return app;
}

/** Optional JSON requests accept an empty body even with a client's default JSON header. */
export const optionalJsonBody: MiddlewareHandler = async (c, next) => {
  if (/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(c.req.header("content-type") ?? "") && await c.req.raw.clone().text() === "") {
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-type");
    c.req.raw = new Request(c.req.raw, { headers });
  }
  return next();
}

export async function readJson<T = Record<string, unknown>>(c: Context) { return (c.req.valid("json" as never) ?? {}) as T; }
