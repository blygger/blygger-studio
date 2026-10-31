// The server half of Studio extensions (docs/extensions.md).
//
// An extension's routes are mounted inside the owner API, behind the same
// middleware as every other /api route: owner session or bearer token, scope
// check (every extension route is a GET, so owner:read), CORS policy and the
// owner/grant work budgets. On top of that, each extension's prefix answers
// 404 unless the extension is enabled in this node's Settings.
//
// Nothing here reaches the wire: extension routes are /api only, never
// blyg.json, a public page or content_html.
import type { RouteConfig } from "@hono/zod-openapi";
import type { OperationHandler } from "../operation-types.ts";
import type { OperationDefinition } from "../operations.ts";
import { readOperation } from "../operation-policy.ts";
import type { FeedAlgorithm } from "../feeds/types.ts";
import { parseEnabledExtensions } from "./names.ts";

/** Registers an extension's read routes. Only routes the extension declared with extensionRoute() are accepted. */
export interface ExtensionRouter {
  get<R extends RouteConfig>(route: R, handler: OperationHandler): void;
}
export interface ServerExtension {
  /** The extension's name (extensions/catalog.ts). */
  name: string;
  routes(router: ExtensionRouter): void;
  /**
   * Home page orders (docs/extensions.md, "Feed orders"). Each id must start
   * with `<name>/`. An order sees only the blyg's public history and returns
   * ids; the core keeps the published ones and renders every card itself.
   */
  feeds?: readonly FeedAlgorithm[];
}

export async function isExtensionEnabled(db: D1Database, name: string) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'extensions'").first<{ value: string }>();
  return parseEnabledExtensions(row?.value).includes(name);
}

/** Compiled route implementations. Authority and feature state remain request-local. */
export function extensionDefinitions(extensions: readonly ServerExtension[]): OperationDefinition[] {
  const definitions: OperationDefinition[] = [];
  for (const extension of extensions) {
    const prefix = `/ext/${extension.name}/`;
    extension.routes({ get(route, handler) {
      if (route.method !== 'get' || !route.path.startsWith(prefix)) throw new Error(`extension ${extension.name} may only add GET routes under /api${prefix}: ${route.method} ${route.path}`);
      definitions.push({ route: { ...route, policy: { ...readOperation(), extension: extension.name } }, handler });
    } });
  }
  return definitions;
}
