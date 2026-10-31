// How an extension declares a route in the /api contract (docs/extensions.md).
//
// Extension routes are owner reads, nothing else: GET only, under
// /api/ext/<name>/, so the permission model classifies every one as
// owner:read and no extension can add a way to write. The operationId is
// derived — ext + PascalCase(name) + PascalCase(operation) — so two extensions
// cannot collide with each other or with the base contract.
import type { z } from "@hono/zod-openapi";
import { route } from "../contract/route.ts";
import { EXTENSION_NAME } from "./names.ts";
import { readOperation } from '../operation-policy.ts';
const pascal = (text: string) => text.split(/[-_]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("");

export function extensionOperationId(extension: string, operation: string) {
  return `ext${pascal(extension)}${pascal(operation)}`;
}

/** A read route for `extension`, answering at GET /api/ext/<extension><path>. */
export function extensionRoute<E extends string, P extends string>(extension: E, operation: string, path: P, response: z.ZodType, query?: z.ZodObject) {
  if (!EXTENSION_NAME.test(extension)) throw new Error(`invalid extension name: ${extension}`);
  if (!/^(\/[\w{}-]+)+$/.test(path)) throw new Error(`invalid extension path: ${path}`);
  const config = route(extensionOperationId(extension, operation), { ...readOperation(), extension }, "get", `/ext/${extension}${path}` as `/ext/${E}${P}`, response, undefined, 200, query);
  return { ...config, tags: ["extension", `extension:${extension}`], description: `Extension "${extension}". Answers only on a node that compiles the extension in and has enabled it in Settings; otherwise 404.` };
}
