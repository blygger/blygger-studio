import type { OwnerScope } from './auth-scopes.ts';

export const API_CONTRACT_VERSION = '7.2.0';
export type WorkBudget = 'read' | 'write';
export interface ScopeInput { body?: unknown }
export interface OperationEffects {
  writes: readonly ('items' | 'publication' | 'presentation' | 'media' | 'settings' | 'subscriptions' | 'imports' | 'hoppers' | 'signals' | 'mentions' | 'readingState' | 'browse' | 'shelf' | 'dictionary' | 'cache' | 'changeClass')[];
  destructive?: boolean;
  network?: boolean;
  background?: boolean;
}
export interface ScopeCondition {
  description: string;
  resolve(input: ScopeInput): OwnerScope[];
}
export interface OperationPolicy {
  scopes: readonly OwnerScope[];
  budget: WorkBudget;
  effects: OperationEffects;
  conditionalScopes?: ScopeCondition;
  scopeNotes?: string;
  extension?: string;
  /**
   * 'in-statement': the handler reads the item through visibleItemsSql in the statement
   * that decides its answer (private-access.ts), so the runner does not look the id up
   * first. Keeps a delegated getItem batch within its read budget (studio#178 R01).
   */
  itemVisibility?: 'in-statement';
}

function scoped(scope: OwnerScope, effects: OperationEffects, budget: WorkBudget, conditionalScopes?: ScopeCondition): OperationPolicy {
  return { scopes: [scope], effects, budget, conditionalScopes };
}
export function readOperation(effects: OperationEffects = { writes: [] }, budget: WorkBudget = 'read'): OperationPolicy {
  return scoped('owner:read', effects, budget);
}
/** Private items and their private versions (the notebook): owner:private, which owner:read does not imply. */
export function privateReadOperation(effects: OperationEffects = { writes: [] }): OperationPolicy {
  return scoped('owner:private', effects, 'read');
}
/**
 * A write that is notebook access as well as management: the Agentic feed, whose editions
 * may name any own item (Venkat, studio#178 session 88). Needs both scopes.
 */
export function notebookManageOperation(effects: OperationEffects): OperationPolicy {
  return { scopes: ['owner:manage', 'owner:private'], effects, budget: 'write' };
}
export function draftOperation(effects: OperationEffects, budget: WorkBudget = 'write', conditionalScopes?: ScopeCondition): OperationPolicy {
  return scoped('owner:draft', effects, budget, conditionalScopes);
}
export function publishOperation(effects: OperationEffects, conditionalScopes?: ScopeCondition): OperationPolicy {
  return scoped('owner:publish', effects, 'write', conditionalScopes);
}
export function manageOperation(effects: OperationEffects, conditionalScopes?: ScopeCondition): OperationPolicy {
  return scoped('owner:manage', effects, 'write', conditionalScopes);
}
export function readingStateOperation(effects: OperationEffects): OperationPolicy {
  return scoped('reading:state', effects, 'write');
}
export const authenticatedOperation: OperationPolicy = { scopes: [], budget: 'read', effects: { writes: [] } };

function bodyRecord(input: ScopeInput): Record<string, unknown> {
  return input.body !== null && typeof input.body === 'object' ? input.body as Record<string, unknown> : {};
}
export const presentationScopes: ScopeCondition = {
  description: 'Changing responses or highlight also requires owner:publish because it changes public presentation immediately.',
  resolve(input) {
    const body = bodyRecord(input);
    return body.responses !== undefined || body.highlight !== undefined ? ['owner:publish'] : [];
  },
};
export const avatarScopes: ScopeCondition = {
  description: 'Choosing avatarMediaId also requires owner:publish because the avatar publishes those bytes.',
  resolve(input) {
    return bodyRecord(input).avatarMediaId !== undefined ? ['owner:publish'] : [];
  },
};

export const privateVisibilityScopes: ScopeCondition = {
  description: 'Publishing with visibility private also requires owner:private, because the item becomes one the token could otherwise not see.',
  resolve(input) {
    return bodyRecord(input).visibility === 'private' ? ['owner:private'] : [];
  },
};

export function requiredScopes(policy: OperationPolicy, input?: ScopeInput): OwnerScope[] {
  return [...new Set([...policy.scopes, ...(input ? policy.conditionalScopes?.resolve(input) ?? [] : [])])];
}
export function operationHints(policy: OperationPolicy) {
  return { readOnlyHint: policy.effects.writes.length === 0, destructiveHint: policy.effects.destructive ?? false, openWorldHint: policy.effects.network ?? false };
}
