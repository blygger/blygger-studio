import type { ChangeDomain, ChangeState } from './change-state.ts';
import { PATH_SHAPE, RESERVED_PATHS } from './front-page.ts';
/** Only public HTML reads enter Workers Cache. The gateway remains uncached. */
export function publicHtmlRequest(request: Request, mount: string): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const path = new URL(request.url).pathname;
  if (path === '/api' || path.startsWith('/api/')) return false;
  if (mount && path !== mount && !path.startsWith(mount + '/')) return false;
  const page = path.slice(mount.length).replace(/\/$/, '');
  return page === '' || page === '/archive' || /^\/(?:f|t)\/[^/]+(?:\/v\d+)?$/.test(page) || /^\/h\/[^/]+$/.test(page) ||
    // A hopper feed (src/hopper-feed.ts) is cached like its page: the key's
    // revision carries `hoppers`, `items`, `subscriptions` and `settings`, so a
    // membership change, a hopper taken private or the setting turned off
    // reads a fresh entry at once, and a 404 is never cached.
    /^\/h\/[^/]+\/feed\.xml$/.test(page) ||
    // The posts page's address is a setting this check cannot read, so any
    // segment that could be one is a candidate; a wrong one renders a 404,
    // which is never cached. Reserved names include the studio's own path.
    (PATH_SHAPE.test(page.slice(1)) && !RESERVED_PATHS.includes(page.slice(1)));
}

// Every domain a public page can read. Reading, signals and mentions are the
// owner's private state, so moving them must not empty the cache. `responses`
// is the one mentions fact a page shows: the responses list under an item
// (listPublicResponses: verified and not hidden). Its triggers (0032) move it
// only when a row enters, leaves or changes inside that set, so a verified
// response or a hide/show appears at once, while a stranger's unverified claim,
// or a flood of them, cannot roll the key and empty the cache.
const PUBLIC_DOMAINS: readonly ChangeDomain[] = ['items', 'subscriptions', 'hoppers', 'settings', 'feed', 'responses'];

/** A token that moves whenever a publish, withdrawal or setting can change public HTML. */
export function publicHtmlRevision(changes: ChangeState): string {
  return [changes.epoch, ...PUBLIC_DOMAINS.map(domain => changes.domains[domain])].join('.');
}

/** Public pages ignore query parameters; origins must never share HTML. A
 * revision in the key sends reads after a change to a fresh entry, so a
 * publish shows at once instead of after the edge cache expires. */
export function publicHtmlKey(request: Request, revision?: string): string {
  const url = new URL(request.url);
  url.search = revision ? `rev=${encodeURIComponent(revision)}` : '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '') || '/';
  return url.href;
}

/** What the public cache stores: HTML pages, and hopper feeds beside them. */
const CACHEABLE_TYPES = ['text/html', 'application/rss+xml'];

export async function htmlCacheResponse(request: Request, response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  if (response.status !== 200 ||
      !CACHEABLE_TYPES.includes(headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '') ||
      headers.has('set-cookie') || /\b(?:private|no-store)\b/i.test(headers.get('cache-control') ?? '')) {
    headers.set('Cache-Control', 'no-store');
    headers.delete('Cloudflare-CDN-Cache-Control');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  const body = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', body);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  // Weak validation also works when Cloudflare compresses these HTML bytes.
  const etag = `W/"${hash}"`;
  headers.set('ETag', etag);
  headers.set('Cache-Control', 'no-cache');
  headers.set('Cloudflare-CDN-Cache-Control', 'public, max-age=60, stale-while-revalidate=300, stale-if-error=0');
  return conditionalHtmlResponse(request, new Response(body, { headers }));
}

/** Validate the browser against saved edge bytes without another render. */
export function conditionalHtmlResponse(request: Request, response: Response): Response {
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
