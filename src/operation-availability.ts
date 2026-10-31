import { EXTENSIONS } from '../extensions/catalog.ts';
import { compiledExtensionNames } from '../build/extensions.names.ts';
import { routes } from './contract/routes.ts';
import { parseEnabledExtensions } from './extensions/names.ts';
import type { ServerExtension } from './extensions/server.ts';
import { requiredScopes } from './operation-policy.ts';
import type { OwnerAccess } from './permissions.ts';

/** Request-local discovery. Execution must read current feature state again. */
export async function operationAvailability(db: D1Database, access: OwnerAccess | null, extensions: readonly ServerExtension[]) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'extensions'").first<{ value: string }>();
  const enabled = new Set(parseEnabledExtensions(row?.value));
  const serverNames = new Set(extensions.map(extension => extension.name));
  const apiNames = new Set(Object.values(routes).flatMap(route => route.policy.extension ? [route.policy.extension] : []));
  const granted = (scopes: readonly string[]) => access === null || scopes.every(scope => access.scope.includes(scope));
  const states = EXTENSIONS.map(name => ({
    name, declared: true,
    compiled: apiNames.has(name) ? serverNames.has(name) : compiledExtensionNames.includes(name),
    enabled: enabled.has(name),
    granted: granted(['owner:read']),
  }));
  const availableExtensions = new Set<string>(states.filter(state => state.compiled && state.enabled).map(state => state.name));
  const operations = Object.entries(routes).filter(([, route]) =>
    granted(requiredScopes(route.policy)) && (!route.policy.extension || availableExtensions.has(route.policy.extension)),
  ).map(([id]) => id).sort();
  return { operations, extensions: states };
}
