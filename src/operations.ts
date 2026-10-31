import type { RouteConfig } from '@hono/zod-openapi';
import { routes } from './contract/routes.ts';
import { extensionRoutes } from '../extensions/catalog.ts';
import { itemOperations } from './api.ts';
import { readOperations } from './read-api.ts';
import { importOperations } from './importer/api.ts';
import { mentionOperations } from './mentions/api.ts';
import type { OperationHandler } from './operation-types.ts';
import type { OperationPolicy } from './operation-policy.ts';
import { extensionDefinitions, type ServerExtension } from './extensions/server.ts';

export interface OperationDefinition {
  route: RouteConfig & { policy: OperationPolicy };
  handler: OperationHandler;
}
const handlers = { ...itemOperations, ...readOperations, ...importOperations, ...mentionOperations } satisfies Record<Exclude<keyof typeof routes, keyof typeof extensionRoutes>, OperationHandler>;

export function operationDefinitions(extensions: readonly ServerExtension[]) {
  const definitions = new Map<string, OperationDefinition>(Object.entries(handlers).map(([name, handler]) =>
    [name, { route: routes[name as keyof typeof handlers], handler }]));
  for (const definition of extensionDefinitions(extensions)) definitions.set(definition.route.operationId!, definition);
  return definitions;
}
