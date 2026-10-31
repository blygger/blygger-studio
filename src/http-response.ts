/** Headers browser clients need beyond Fetch's safelisted response headers. */
export const EXPOSED_RESPONSE_HEADERS = 'ETag, Retry-After, Allow, Location, WWW-Authenticate';

/** Hono's res setter preserves old headers. Set final policy through header()
 * so replacements cannot restore headers that the policy removed. */
export function setResponseHeaders(context: { header(name: string, value?: string): void }, values: Record<string, string | null>): void {
  for (const [name, value] of Object.entries(values)) context.header(name, value ?? undefined);
}

/** Copy final headers without relying on a framework's prepared context headers. */
export function responseHeaders(response: Response, values: Record<string, string | null>): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(values)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Weak validators remain usable when the edge compresses the representation. */
export async function representationEtag(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `W/"${hash}"`;
}

/** Evaluate only after access, resource existence and normal request checks. */
export function conditionalResponse(request: Request, response: Response): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return response;
  const etag = response.headers.get('etag');
  const matches = etag && request.headers.get('if-none-match')?.split(',').some(tag =>
    tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));
  if (response.status === 200 && matches) {
    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
    : response;
}

/** Validate rendered text/assets. Streaming media supplies its storage ETag. */
export async function validatedResponse(request: Request, response: Response): Promise<Response> {
  if (response.status !== 200 || response.headers.has('etag') ||
      !['GET', 'HEAD'].includes(request.method)) return conditionalResponse(request, response);
  const body = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set('ETag', await representationEtag(body));
  return conditionalResponse(request, new Response(body, { status: response.status, statusText: response.statusText, headers }));
}
