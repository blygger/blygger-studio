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
    draftOnlyMedia: boolean;
    apiAccess: OwnerAccess | null;
    apiExtensions: readonly ServerExtension[];
  }
}

export function contractApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>({ strict: false, defaultHook: (result, c) => {
    if (!result.success) {
      const error = result.error;
      const flatten = (issues: typeof error.issues): typeof error.issues => issues.flatMap((issue) => issue.code === "invalid_union" ? flatten([...issue.errors].sort((a, b) => a.length - b.length)[0] ?? []) : [issue]);
      const issues = flatten(error.issues).map(({ path, message }) => ({ path: path.map((key) => typeof key === "symbol" ? String(key) : key), message }));
      return c.json({ error: issues.map(({ path, message }) => `${path.join(".") || "request"}: ${message}`).join("; "), issues }, 400);
    }
  } });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    console.error('API request failed', requestError(error, c));
    return c.json({ error: "internal server error" }, 500);
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
export async function readForm(c: Context) { return await c.req.formData(); }
