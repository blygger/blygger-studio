import { Hono } from 'hono';
import script from '../build/studio-spa.txt';
import style from '../build/studio-spa-style.txt';
import {
  checkPassword,
  clearSessionCookie,
  issueSessionCookie,
  verifySession,
} from './auth.ts';
import { deploymentPaths, escapeHtml } from './util.ts';
import { authorizationServer, ownerLoginRateLimit } from './oauth.ts';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { CLIENT } from './client.ts';
import {
  STUDIO_ICON_180_PNG_BASE64,
  STUDIO_ICON_512_PNG_BASE64,
  STUDIO_ICON_SVG,
} from './studio-icon.ts';
import type { Env } from './types.ts';
import { validatedResponse } from './http-response.ts';

/** The pencil accent of the default (auto, light) palette — the shell's
 *  theme-color until settings load and the studio repaints it. */
const DEFAULT_ACCENT = '#23608c';

function png(base64: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The web app manifest. Scope and start_url are the studio base, so a
 *  path-mounted blyg (`/blyg/studio`) installs as its own app. No owner data:
 *  the name is the studio's, not the site title, because the manifest is
 *  fetched without credentials. */
export function studioManifest(base: string) {
  return {
    name: 'blyg studio',
    short_name: 'blyg studio',
    id: base,
    start_url: base,
    scope: base,
    display: 'standalone',
    background_color: '#eef1f3',
    theme_color: DEFAULT_ACCENT,
    icons: [
      { src: `${base}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: `${base}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${base}/icon-180.png`, sizes: '180x180', type: 'image/png', purpose: 'any' },
    ],
  };
}

/**
 * The service worker. It caches the app shell's static assets (app.js,
 * app.css, the icon) network-first, so a deploy is picked up as soon as the
 * network answers and the installed app still launches offline. It never
 * touches /api or any server-rendered page: navigations it can't reach fall
 * back to an owner-free shell (the same markup the Worker serves, which
 * carries only deployment paths), never to a cached response.
 *
 * It is a TS template literal emitted as JavaScript, so the AGENTS.md escape
 * hazard applies: no backslashes in it. test/inline-scripts.test.ts parses it.
 */
export function studioServiceWorker(base: string, offlineShell: string) {
  const assets = [`${base}/app.js`, `${base}/app.css`, `${base}/icon.svg`];
  return `/* blyg studio service worker — ${CLIENT.name} ${CLIENT.version} */
const CACHE = ${JSON.stringify(`blyg-studio-${CLIENT.version}`)};
const ASSETS = ${JSON.stringify(assets)};
const BASE = ${JSON.stringify(base)};
const OFFLINE_SHELL = ${JSON.stringify(offlineShell)};
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => undefined));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('blyg-studio-') && key !== CACHE).map((key) => caches.delete(key)),
  )));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (ASSETS.includes(url.pathname)) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
      }
      return response;
    }).catch(() => caches.match(url.pathname).then((hit) => hit || Response.error())));
    return;
  }
  const inStudio = url.pathname === BASE || url.pathname.startsWith(BASE + '/');
  if (request.mode === 'navigate' && inStudio) {
    event.respondWith(fetch(request).catch(() => new Response(OFFLINE_SHELL, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })));
  }
});
`;
}

/** Serve the owner UI at the deployment mount. Public pages keep server rendering. */
export function studioSpa(mount: string) {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  const base = `${mount}/studio`;
  app.use('*', async (c, next) => {
    await next();
    if (c.res.status === 200 && !/\b(?:private|no-store)\b/i.test(c.res.headers.get('Cache-Control') ?? '')) {
      c.res = await validatedResponse(c.req.raw, c.res);
    }
  });
  const returnTo = (value: unknown) => typeof value === 'string' && value.startsWith(base + '/auth/oauth2/authorize?') && !value.includes('\\') ? value : base;
  const b = escapeHtml(base);
  const head = (title: string) =>
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<title>${title}</title>` +
    `<meta name="theme-color" content="${DEFAULT_ACCENT}">` +
    `<link rel="manifest" href="${b}/manifest.webmanifest">` +
    `<link rel="icon" href="${b}/icon.svg" type="image/svg+xml">` +
    `<link rel="apple-touch-icon" href="${b}/icon-180.png">` +
    `<meta name="mobile-web-app-capable" content="yes">` +
    `<meta name="apple-mobile-web-app-capable" content="yes">` +
    `<meta name="apple-mobile-web-app-title" content="blyg studio">` +
    `<meta name="apple-mobile-web-app-status-bar-style" content="default">` +
    `<link rel="authorization_endpoint" href="${b}/auth/oauth2/authorize">` +
    `<link rel="oauth-metadata" href="${b}/auth/.well-known/openid-configuration">` +
    `<link rel="stylesheet" href="${b}/app.css">`;
  const shell = (body: string, spa = false) =>
    `<!doctype html><html lang="en" class="js" data-theme="auto"><head>${head(`blyg studio${spa ? '' : ' — login'}`)}</head><body>${body}${spa ? `<script defer src="${b}/app.js"></script>` : ''}</body></html>`;
  const spaShell = shell(
    `<div id="studio-root" data-mount="${escapeHtml(mount)}" data-api-base="${escapeHtml(deploymentPaths(mount).api)}"></div>`,
    true,
  );
  const login = (error = '', next = base, oauthQuery?: string) =>
    shell(
      `<main class="login"><h1>blyg studio</h1>${error ? `<p role="alert" class="banner banner-alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="${b}/login"><input type="hidden" name="return_to" value="${escapeHtml(next)}">${oauthQuery === undefined ? '' : `<input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery)}">`}<p><input type="password" name="password" placeholder="password" aria-label="password" autofocus required></p><p><button type="submit" class="btn btn-primary">log in</button></p></form></main>`,
    );
  app.get('/app.js', (c) =>
    c.body(script, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    }),
  );
  app.get('/app.css', (c) =>
    c.body(style, 200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'no-cache',
    }),
  );
  // Install surface: public on purpose (a manifest is fetched without
  // credentials) and free of owner data.
  app.get('/manifest.webmanifest', (c) =>
    c.body(JSON.stringify(studioManifest(base)), 200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-cache',
    }),
  );
  app.get('/sw.js', (c) =>
    c.body(studioServiceWorker(base, spaShell), 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      // The worker's script lives at {base}/sw.js, whose default scope is
      // {base}/ — which does not cover the studio's own root, {base}.
      'Service-Worker-Allowed': base,
    }),
  );
  app.get('/icon.svg', (c) =>
    c.body(STUDIO_ICON_SVG, 200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    }),
  );
  for (const [path, data] of [
    ['/icon-180.png', STUDIO_ICON_180_PNG_BASE64],
    ['/icon-512.png', STUDIO_ICON_512_PNG_BASE64],
  ] as const)
    app.get(path, (c) =>
      c.body(png(data), 200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
      }),
    );
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'same-origin');
    await next();
  });
  app.get('/login', async (c) => {
    const oauthQuery = c.req.query('oauth_query') ?? (c.req.query('sig') === undefined ? undefined : new URL(c.req.url).search.slice(1));
    if (oauthQuery !== undefined) {
      const server = await authorizationServer(c.req.url, c.env);
      if (!await verifyOAuthQueryParams(oauthQuery, (await server.$context).secret)) return c.json({ error: 'invalid_request' }, 400);
      return c.html(login('', base, oauthQuery));
    }
    return await verifySession(c.env, c.req.header('cookie'))
      ? c.redirect(base)
      : c.html(login('', returnTo(c.req.query('return_to'))));
  });
  app.post('/login', async (c) => {
    if (c.req.header('origin') && c.req.header('origin') !== new URL(c.req.url).origin || c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'cross-origin login denied' }, 403);
    const limited = await ownerLoginRateLimit(c.req.raw, c.env);
    if (limited) return limited;
    const form = await c.req.formData(), query = form.get('oauth_query');
    const server = query === null ? undefined : await authorizationServer(c.req.url, c.env);
    if (query !== null && (typeof query !== 'string' || !await verifyOAuthQueryParams(query, (await server!.$context).secret))) return c.json({ error: 'invalid_request' }, 400);
    if (!(await checkPassword(c.env, String(form.get('password') ?? ''))))
      return c.html(login('Wrong password.', returnTo(form.get('return_to')), query === null ? undefined : String(query)), 403);
    const ownerCookie = await issueSessionCookie(c.env);
    if (server && typeof query === 'string') {
      const headers = new Headers(c.req.raw.headers);
      headers.set('cookie', ownerCookie.split(';')[0]);
      headers.set('origin', new URL(c.req.url).origin);
      headers.set('accept', 'application/json');
      headers.set('content-type', 'application/json');
      const body = { oauth_query: query };
      const request = new Request(new URL(base + '/auth/internal/owner-session', c.req.url), { method: 'POST', headers, body: JSON.stringify(body) });
      const response = await server.api.ownerSession({ headers, body, request, asResponse: true });
      if (!response.ok) return response;
      const continuation = await response.json() as { url: string };
      c.header('Set-Cookie', ownerCookie);
      for (const cookie of response.headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
      return c.redirect(continuation.url);
    }
    c.header('Set-Cookie', ownerCookie);
    return c.redirect(returnTo(form.get('return_to')));
  });
  app.post('/logout', (c) => {
    c.header('Set-Cookie', clearSessionCookie());
    return c.redirect(`${base}/login`);
  });
  app.get('*', async (c) => {
    if (!(await verifySession(c.env, c.req.header('cookie'))))
      return c.redirect(`${base}/login`);
    return c.html(spaShell);
  });
  return app;
}
