import { routes } from './contract/routes.ts';
import { requiredScopes, type OperationInput } from './operation-policy.ts';

import type { OwnerScope } from './auth-scopes.ts';
export { OWNER_SCOPES, SCOPE_DESCRIPTIONS } from './auth-scopes.ts';
export interface OwnerAccess { scope: string[]; clientId: string; userId: string; grantId?: string }
export function operationScopes(operation: string, input?: OperationInput): OwnerScope[] {
  const route = routes[operation as keyof typeof routes];
  if (!route) throw new Error(`Unknown operation: ${operation}`);
  return requiredScopes(route.policy, input);
}
// Use the route patterns Hono actually matched, not a second URL router.
const registeredOperations = new Map(Object.entries(routes).map(([id, route]) => [
  `${route.method.toUpperCase()} /api${route.path.replace(/\{(\w+)\}/g, ':$1')}`,
  [id, route] as const,
]));
export function matchOperation(method: string, paths: Iterable<string>) {
  const verb = method === 'HEAD' ? 'GET' : method.toUpperCase();
  for (const path of paths) {
    const operation = registeredOperations.get(`${verb} ${path}`);
    if (operation) return operation;
  }
}
