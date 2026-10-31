import { deploymentPaths } from './util.ts';
import type { ChangeDomain, ChangeState } from './change-state.ts';
import { PATH_SHAPE, RESERVED_PATHS } from './front-page.ts';
import { conditionalResponse, representationEtag } from './http-response.ts';
/** Only public HTML reads enter Workers Cache. The gateway remains uncached. */
export function publicHtmlRequest(request: Request, mount: string): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const path = new URL(request.url).pathname;
  const api = deploymentPaths(mount).api;
  if (path === api || path.startsWith(api + '/')) return false;
  if (mount && path !== mount && !path.startsWith(mount + '/')) return false;
  const page = path.slice(mount.length).replace(/\/$/, '');
  return page === '' || page === '/archive' || /^\/(?:f|t)\/[^/]+(?:\/v\d+)?$/.test(page) || /^\/h\/[^/]+$/.test(page) ||
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

export async function htmlCacheResponse(request: Request, response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  if (response.status !== 200 ||
      headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/html' ||
      headers.has('set-cookie') || /\b(?:private|no-store)\b/i.test(headers.get('cache-control') ?? '')) {
    headers.set('Cache-Control', 'no-store');
    headers.delete('Cloudflare-CDN-Cache-Control');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  const body = await response.arrayBuffer();
  headers.set('ETag', await representationEtag(body));
  headers.set('Cache-Control', 'no-cache');
  headers.set('Cloudflare-CDN-Cache-Control', 'public, max-age=60, stale-while-revalidate=300, stale-if-error=0');
  return conditionalHtmlResponse(request, new Response(body, { headers }));
}

/** Validate the browser against saved edge bytes without another render. */
export function conditionalHtmlResponse(request: Request, response: Response): Response {
  return conditionalResponse(request, response);
}
