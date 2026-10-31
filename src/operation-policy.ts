import type { OwnerScope } from './auth-scopes.ts';

export const API_CONTRACT_VERSION = '1.0.0';
export type WorkBudget = 'read' | 'write';
export interface OperationInput { body?: unknown }
export interface OperationEffects {
  writes: readonly ('items' | 'publication' | 'presentation' | 'media' | 'settings' | 'subscriptions' | 'imports' | 'hoppers' | 'signals' | 'mentions' | 'readingState' | 'browse' | 'cache' | 'changeClass')[];
  destructive?: boolean;
  network?: boolean;
  background?: boolean;
}
export interface ScopeCondition {
  description: string;
  resolve(input: OperationInput): OwnerScope[];
}
export interface OperationPolicy {
  scopes: readonly OwnerScope[];
  budget: WorkBudget;
  effects: OperationEffects;
  conditionalScopes?: ScopeCondition;
  scopeNotes?: string;
  extension?: string;
}

function scoped(scope: OwnerScope, effects: OperationEffects, budget: WorkBudget, conditionalScopes?: ScopeCondition): OperationPolicy {
  return { scopes: [scope], effects, budget, conditionalScopes };
}
export function readOperation(effects: OperationEffects = { writes: [] }, budget: WorkBudget = 'read'): OperationPolicy {
  return scoped('owner:read', effects, budget);
}
export function draftOperation(effects: OperationEffects, budget: WorkBudget = 'write', conditionalScopes?: ScopeCondition): OperationPolicy {
  return scoped('owner:draft', effects, budget, conditionalScopes);
}
export function publishOperation(effects: OperationEffects): OperationPolicy {
  return scoped('owner:publish', effects, 'write');
}
export function manageOperation(effects: OperationEffects, conditionalScopes?: ScopeCondition): OperationPolicy {
  return scoped('owner:manage', effects, 'write', conditionalScopes);
}
export function readingStateOperation(effects: OperationEffects): OperationPolicy {
  return scoped('reading:state', effects, 'write');
}
export const authenticatedOperation: OperationPolicy = { scopes: [], budget: 'read', effects: { writes: [] } };

function bodyRecord(input: OperationInput): Record<string, unknown> {
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
  description: 'Choosing avatar_media_id also requires owner:publish because the avatar publishes those bytes.',
  resolve(input) {
    return bodyRecord(input).avatar_media_id !== undefined ? ['owner:publish'] : [];
  },
};

export function requiredScopes(policy: OperationPolicy, input?: OperationInput): OwnerScope[] {
  return [...new Set([...policy.scopes, ...(input ? policy.conditionalScopes?.resolve(input) ?? [] : [])])];
}
export function operationHints(policy: OperationPolicy) {
  return { readOnlyHint: policy.effects.writes.length === 0, destructiveHint: policy.effects.destructive ?? false, openWorldHint: policy.effects.network ?? false };
}
