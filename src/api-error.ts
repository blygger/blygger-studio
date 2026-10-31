/** Private API errors. OAuth and provider-native errors keep their native formats. */
export const API_ERROR_CODES = ['invalid-input', 'unauthorized', 'forbidden', 'not-found', 'method-not-allowed', 'conflict', 'revision-conflict', 'too-large', 'unsupported-media', 'unprocessable', 'rate-limit', 'internal', 'bad-gateway'] as const;
export type ApiErrorCode = typeof API_ERROR_CODES[number];
export function apiError(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
  return { code, message, ...(details && Object.keys(details).length ? { details } : {}) };
}
export function failureBody(code: ApiErrorCode, value: Record<string, unknown>) {
  const { error, message, code: supplied, details, ...extra } = value;
  return apiError(API_ERROR_CODES.includes(supplied as ApiErrorCode) ? supplied as ApiErrorCode : code,
    typeof message === 'string' ? message : typeof error === 'string' ? error : 'request failed',
    { ...(details && typeof details === 'object' ? details as Record<string, unknown> : {}), ...extra });
}
export function statusError(status: number, message: string) {
  const codes: Record<number, ApiErrorCode> = { 400: 'invalid-input', 401: 'unauthorized', 403: 'forbidden', 404: 'not-found', 405: 'method-not-allowed', 409: 'conflict', 413: 'too-large', 415: 'unsupported-media', 422: 'unprocessable', 429: 'rate-limit', 502: 'bad-gateway' };
  return apiError(codes[status] ?? 'internal', message);
}
