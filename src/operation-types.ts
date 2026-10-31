import type { Env } from './types.ts';
import type { OwnerAccess } from './permissions.ts';
import type { ServerExtension } from './extensions/server.ts';

export interface MediaInput {
  file?: { bytes: Uint8Array; mime: string; name: string };
  itemId?: string;
  alt?: string;
  inline?: boolean;
}
export interface OperationInput {
  path: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
  media?: MediaInput;
  inputFailure?: OperationFailure;
}
export interface OperationContext {
  env: Env;
  url: string;
  access: OwnerAccess | null;
  extensions: readonly ServerExtension[];
  defer(task: Promise<unknown>): void;
}
export const FAILURE_STATUS = {
  'invalid-input': 400, unauthorized: 401, forbidden: 403, 'not-found': 404,
  conflict: 409, 'too-large': 413, 'unsupported-media': 415, unprocessable: 422,
  'rate-limit': 429, internal: 500, 'bad-gateway': 502,
} as const;
export type FailureKind = keyof typeof FAILURE_STATUS;
export interface OperationFailure { ok: false; kind: FailureKind; value: Record<string, unknown>; requiredScopes?: string[] }
export type OperationResult<T = unknown> = { ok: true; value: T; created: boolean; location?: string } | OperationFailure;
export type OperationHandler = (context: OperationContext, input: OperationInput) => Promise<OperationResult>;
export function success<T>(value: T): OperationResult<T> { return { ok: true, value, created: false }; }
export function created<T>(value: T, location?: string): OperationResult<T> { return { ok: true, value, created: true, location }; }
export function failure(kind: FailureKind, value: Record<string, unknown>, requiredScopes?: string[]): OperationFailure {
  return { ok: false, kind, value, requiredScopes };
}
/** Preserve existing model error classifications while adapters map typed failures. */
export function modelFailure(value: Record<string, unknown>, status: number): OperationResult<never> {
  const kind = (Object.keys(FAILURE_STATUS) as FailureKind[]).find(kind => FAILURE_STATUS[kind] === status) ?? 'internal';
  return failure(kind, value);
}
export class OperationError extends Error {
  constructor(readonly kind: FailureKind, message: string) { super(message); }
}
