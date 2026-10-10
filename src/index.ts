import { WorkerEntrypoint } from 'cloudflare:workers';
import { conditionalHtmlResponse, htmlCacheResponse, publicHtmlKey, publicHtmlRequest } from './html-cache.ts';
import { verifySession } from "./auth.ts";
import { verifyBearer } from "./oauth.ts";
import { requestError } from './request-error.ts';
import { fontCss } from "./fonts.ts";
import { listFeedItems } from "./public-feed.ts";
import { studioSpa } from "./spa.ts";
import { authorizationApi } from './authorization-api.ts';
import { oauthRoutes } from './oauth-routes.ts';
import { serveMcp } from './mcp.ts';
import { ownerApi } from "./owner-api.ts";
// Studio is mounted at {mount}/studio and its assets share that range.
// The owner API remains host-rooted at /api. Register both before the public
// sub-app so public-page cache middleware cannot wrap private responses.

import { type Context, Hono } from "hono";


import { buildBlogrollOpml } from "./importer/opml.ts";
import { publicHopperPage } from "./importer/pages.ts";
import { repairImportedUrls, runScheduledPoll } from "./importer/schedule.ts";
import { getHopperBySlug, getImportedItem, getSubscription, listBlogrollSubscriptions, listHopperItems } from "./importer/store.ts";
import { authoredKind, getItem, getMedia, getSettings, getVersion, listPublic } from "./model.ts";
import { archivePage, feedPage, generatedHighlightCss, permalinkPage, pinnedVersionPage, STYLE_CSS, themeCss, threadPage } from "./pages.ts";
import { buildArchiveIndex, buildItemJson, buildManifest, buildPinnedVersionJson, siteOrigin } from "./protocol.ts";
import { cachedFeed, refreshConfiguredFeed } from './feed-cache.ts';
import { platformFetchFor } from "./importer/http.ts";
import { mentionFetchFor } from "./mentions/http.ts";
import { receiveMention, verifyMention } from "./mentions/receive.ts";

import { drainOutbound } from "./mentions/send.ts";
import { pruneFailedInbound } from "./mentions/store.ts";
import type { Env, Settings } from "./types.ts";
import { FEED_PAGE_SIZE, WEBMENTION_PATH } from "./types.ts";
import { normalizeMount, studioPath } from "./util.ts";

const cors = (c: { header: (k: string, v: string) => void }) =>
  c.header("Access-Control-Allow-Origin", "*");

/** Build the app for one normalized mount ("" = root, else "/path"). */
export function makeApp(mount: string) {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  app.onError((_error, c) => {
    // Authentication driver failures can contain SQL parameters and secrets.
    // Keep a bounded event rather than Hono's default raw Error/stack output.
    console.error('Worker request failed', requestError(_error, c));
    return c.json({ error: 'internal server error' }, 500, { 'Cache-Control': 'no-store' });
  });
  app.use('*', async (c, next) => {
    const path = c.req.path, studio = studioPath(mount);
    if (path === '/api' || path.startsWith('/api/') || path === studio || path.startsWith(studio + '/')) {
      const url = new URL(c.req.url);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !loopback) return c.json({ error: 'HTTPS required' }, 400, { 'Cache-Control': 'no-store' });
    }
    await next();
  });

  // --- Studio: cookie auth, mount-relative (see header note). API: cookie auth, host-rooted. Registered first. ---

  app.route(studioPath(mount) + '/auth', oauthRoutes());
  app.all(studioPath(mount) + '/mcp', c => serveMcp(c.req.raw, c.env, c.executionCtx));
  app.use('/api/*', async (c, next) => {
    if (c.req.header('authorization') || c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Origin', '*');
      c.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      c.header('Access-Control-Expose-Headers', 'WWW-Authenticate, Location');
      if (c.req.method === 'OPTIONS') return c.body(null, 204);
    }
    await next();
  });
  app.route('/api', authorizationApi);
  app.route(studioPath(mount), studioSpa(mount));

  app.route("/api", ownerApi);

  // --- Public surface: mount-relative — cache 60s; JSON/XML get permissive CORS. ---

  const pub = new Hono<{ Bindings: Env }>({ strict: false });

  pub.use("*", async (c, next) => {
    await next();
    if (c.res.ok && !c.res.headers.has("Cache-Control")) {
      c.res.headers.set("Cache-Control", "public, max-age=60");
    }
  });

  // strict:false: serves both {mount} and {mount}/ (and "/" at root mount).
  pub.get("/", async (c) => {
    const [settings, items] = await Promise.all([getSettings(c.env.DB), listFeedItems(c.env.DB, FEED_PAGE_SIZE + 1)]);
    const hasMore = items.length > FEED_PAGE_SIZE;
    return c.html(await feedPage(c.env.DB, settings, items.slice(0, FEED_PAGE_SIZE), hasMore, mount, siteOrigin(settings, c.req.url, mount)));
  });

  // The stylesheet carries the author's chosen theme appended to the base, so
  // a theme change is one file for every page and the static export picks it
  // up by fetching this route like any other.
  pub.get("/style.css", async (c) => {
    const settings = await getSettings(c.env.DB);
    return c.text(STYLE_CSS + themeCss(settings.theme, settings.custom_theme, settings.custom_theme_dark) + fontCss(settings.font) + generatedHighlightCss(settings.highlight_generated_default), 200, { "Content-Type": "text/css; charset=utf-8" });
  });

  pub.get("/feed.xml", async (c) => {
    return cachedFeed(c.req.raw, c.env, mount, work => c.executionCtx.waitUntil(work));
  });

  pub.get("/blyg.json", async (c) => {
    const settings = await getSettings(c.env.DB);
    cors(c);
    return c.json(await buildManifest(c.env.DB, settings, siteOrigin(settings, c.req.url, mount)));
  });

  pub.get("/items/index.json", async (c) => {
    cors(c);
    return c.json(await buildArchiveIndex(c.env.DB));
  });

  // §2.2 blogroll: 404 when no subscription is flagged public.
  pub.get("/blogroll.opml", async (c) => {
    const subs = await listBlogrollSubscriptions(c.env.DB);
    if (!subs.length) return c.notFound();
    const settings = await getSettings(c.env.DB);
    cors(c);
    return c.body(buildBlogrollOpml(subs, settings.site_title), 200, { "Content-Type": "text/x-opml; charset=utf-8" });
  });

  // §4.2 public hopper page: curation display only (decision #12) — 404 unless the hopper is public.
  pub.get("/h/:slug", async (c) => {
    const hopper = await getHopperBySlug(c.env.DB, c.req.param("slug"));
    if (!hopper || hopper.public !== 1) return c.notFound();
    const memberships = await listHopperItems(c.env.DB, hopper.id);
    const subCache = new Map<string, Awaited<ReturnType<typeof getSubscription>>>();
    const items: { row: NonNullable<Awaited<ReturnType<typeof getImportedItem>>>; sub: NonNullable<Awaited<ReturnType<typeof getSubscription>>> }[] = [];
    for (const m of memberships) {
      const row = await getImportedItem(c.env.DB, m.subscription_id, m.remote_id);
      if (!row) continue;
      let sub = subCache.get(m.subscription_id);
      if (sub === undefined) {
        sub = await getSubscription(c.env.DB, m.subscription_id);
        subCache.set(m.subscription_id, sub);
      }
      if (!sub) continue;
      items.push({ row, sub });
    }
    const settings = await getSettings(c.env.DB);
    return c.html(await publicHopperPage(c.env.DB, settings, hopper, items, mount, siteOrigin(settings, c.req.url, mount)));
  });

  pub.get("/items/:file", async (c) => {
    const file = c.req.param("file");
    if (!file.endsWith(".json")) return c.notFound();
    const item = await getItem(c.env.DB, file.slice(0, -5));
    // 404 for drafts/unknown; withdrawn endcaps are 200 forever (§3.3).
    if (!item || item.status === "draft") return c.notFound();
    const settings = await getSettings(c.env.DB);
    cors(c);
    return c.json(await buildItemJson(c.env.DB, settings, item, siteOrigin(settings, c.req.url, mount)));
  });

  // §2.8 pinned version files: 404 unless pinned; 200 forever once pinned,
  // surviving edits and withdrawal of the live stream.
  pub.get("/items/:id/:vfile", async (c) => {
    const m = /^v(\d+)\.json$/.exec(c.req.param("vfile"));
    if (!m) return c.notFound();
    const item = await getItem(c.env.DB, c.req.param("id") ?? "");
    if (!item || item.status === "draft") return c.notFound();
    const row = await getVersion(c.env.DB, item.id, Number(m[1]));
    if (!row || row.pinned !== 1) return c.notFound();
    const settings = await getSettings(c.env.DB);
    cors(c);
    return c.json(buildPinnedVersionJson(settings, item, row, siteOrigin(settings, c.req.url, mount)));
  });

  /**
   * Webmention endpoint (§2.3.1, decision #28) — inside the origin surface,
   * unlike host-rooted /studio and /api, because it is a protocol surface: a
   * stranger's client finds it from the manifest or a page link, both of
   * which are origin-relative.
   *
   * 202, not 200: the claim is accepted here and *verified* afterwards,
   * against the network. Saying 200 would assert something not yet checked.
   */
  pub.post("/webmention", async (c) => {
    const settings = await getSettings(c.env.DB);
    // §15 is OPTIONAL at every level, so a blyg may decline to receive. 404
    // rather than 403: when mentions are off nothing here is advertised, so the
    // honest answer to a sender is that this blyg has no endpoint — the same
    // answer a static export gives.
    if (!settings.accept_mentions) return c.notFound();
    const origin = siteOrigin(settings, c.req.url, mount);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const outcome = await receiveMention(
      c.env.DB,
      { source: typeof form.source === "string" ? form.source : undefined, target: typeof form.target === "string" ? form.target : undefined },
      origin,
    );
    // Never cacheable: the public sub-app stamps 60s on anything without a
    // Cache-Control, and a mention endpoint's answer is about one claim.
    c.header("Cache-Control", "no-store");
    // Said in the header so a well-behaved sender waits instead of retrying
    // into the cap: an hour for the rolling-hour limits, less for a repeat
    // claim or a full verification queue.
    if (outcome.status === 429) c.header("Retry-After", String(outcome.retryAfter));
    if (outcome.status !== 202) return c.json({ error: outcome.error }, outcome.status);
    const { mentionId, source } = outcome;
    const itemId = (await c.env.DB.prepare("SELECT target_item_id FROM mentions_in WHERE id = ?").bind(mentionId).first<{ target_item_id: string }>())!
      .target_item_id;
    // Verification runs after the response and can never fail the response:
    // an error here leaves the row `pending` for a later re-send to re-verify.
    c.executionCtx.waitUntil(verifyMention(c.env.DB, mentionId, source, itemId, origin, mentionFetchFor(c.env)).catch(() => {}));
    return c.json({ ok: true, status: "accepted, pending verification" }, 202);
  });

  /** W3C discovery also allows the endpoint in a Link header, so item pages carry both. */
  const webmentionLink = (c: Context<{ Bindings: Env }>, settings: Settings) => {
    if (!settings.accept_mentions) return;
    c.header("Link", `<${siteOrigin(settings, c.req.url, mount)}${WEBMENTION_PATH}>; rel="webmention"`);
  };

  pub.get("/f/:id", async (c) => {
    const item = await getItem(c.env.DB, c.req.param("id"));
    if (!item || item.status === "draft") return c.notFound();
    if ((await authoredKind(c.env.DB, item)) !== "fragment") return c.notFound();
    const settings = await getSettings(c.env.DB);
    webmentionLink(c, settings);
    return c.html(await permalinkPage(c.env.DB, settings, item, mount, siteOrigin(settings, c.req.url, mount)));
  });

  // Pinned-version HTML pages (session-18 decision, additive per §2.8's
  // reserved path): the live permalink + /v{n}/. Same gate as the JSON —
  // 404 unless that exact version is pinned; 200 forever once it is,
  // surviving withdrawal. The authored kind of the *pinned version* decides
  // which route serves it (a withdrawn item's kind is 'withdrawn', but its
  // pinned v1 was authored as fragment or thread — transclusions tells us).
  const pinnedPage = (wantThread: boolean) => async (c: Context<{ Bindings: Env }>) => {
    const m = /^v(\d+)$/.exec(c.req.param("vseg") ?? "");
    if (!m) return c.notFound();
    const item = await getItem(c.env.DB, c.req.param("id") ?? "");
    if (!item || item.status === "draft") return c.notFound();
    const row = await getVersion(c.env.DB, item.id, Number(m[1]));
    if (!row || row.pinned !== 1) return c.notFound();
    const isThread = row.transclusions !== null;
    if (isThread !== wantThread) return c.notFound();
    const settings = await getSettings(c.env.DB);
    return c.html(await pinnedVersionPage(c.env.DB, settings, item, row, isThread, mount, siteOrigin(settings, c.req.url, mount)));
  };
  pub.get("/f/:id/:vseg", pinnedPage(false));
  pub.get("/t/:id/:vseg", pinnedPage(true));

  // §2.9 thread permalink page.
  pub.get("/t/:id", async (c) => {
    const item = await getItem(c.env.DB, c.req.param("id"));
    if (!item || item.status === "draft") return c.notFound();
    if ((await authoredKind(c.env.DB, item)) !== "thread") return c.notFound();
    const settings = await getSettings(c.env.DB);
    webmentionLink(c, settings);
    return c.html(await threadPage(c.env.DB, settings, item, mount, siteOrigin(settings, c.req.url, mount)));
  });

  pub.get("/archive", async (c) => {
    const settings = await getSettings(c.env.DB);
    return c.html(await archivePage(c.env.DB, settings, await listPublic(c.env.DB), mount, siteOrigin(settings, c.req.url, mount)));
  });

  pub.get("/media/:file", async (c) => {
    const file = c.req.param("file");
    const media = await getMedia(c.env.DB, file.split(".")[0]);
    if (!media || media.r2_key !== `media/${file}`) return c.notFound();
    // §5.4: a published media URL MUST always serve the same bytes, and §9
    // withdrawal does not cascade. Public uses: the avatar, an attachment on an
    // item ever published (attaching there needs publish scope), and anything
    // a published version's text shows. Unused uploads stay owner-only.
    // Indexed checks run first; the scan of every version is the last resort.
    const publicUse = await c.env.DB.prepare(`SELECT 1 WHERE
      EXISTS (SELECT 1 FROM settings WHERE key='avatar_media_id' AND value=?)
      OR EXISTS (SELECT 1 FROM items WHERE id=? AND version>0 AND ?<>1)
      OR EXISTS (SELECT 1 FROM versions WHERE item_id=? AND instr(content_html, ?) > 0)
      OR EXISTS (SELECT 1 FROM versions WHERE instr(content_html, ?) > 0)`)
      .bind(media.id, media.item_id, media.inline ?? 0, media.item_id, media.r2_key, media.r2_key).first();
    if (!publicUse) {
      c.header('Cache-Control', 'no-store');
      const url = new URL(c.req.url);
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return c.notFound();
      const bearer = /^Bearer(?:\s|$)/i.test(c.req.header('authorization') ?? '');
      const access = bearer ? await verifyBearer(c.req.raw, c.env, 'api') : null;
      if (bearer ? !access?.scope.includes('owner:read') : !await verifySession(c.env, c.req.header('cookie'))) return c.notFound();
    }
    const object = await c.env.MEDIA.get(media.r2_key);
    if (!object) return c.notFound();
    return c.body(object.body as ReadableStream, 200, {
      "Content-Type": media.mime,
      // Uploaded SVG can be opened as a document. Keep it inert and give it an
      // opaque origin so delegated uploads cannot inherit an owner's authority.
      "Content-Security-Policy": "sandbox; script-src 'none'",
      "Cache-Control": publicUse ? "public, max-age=31536000, immutable" : "no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });

  if (mount === "") {
    app.route("/", pub);
  } else {
    app.get("/", (c) => c.redirect(mount + "/"));
    app.route(mount, pub);
  }

  return app;
}

const apps = new Map<string, ReturnType<typeof makeApp>>();

function fetchApp(req: Request, env: Env, ctx: ExecutionContext) {
  const mount = normalizeMount(env.MOUNT);
  let app = apps.get(mount);
  if (!app) {
    app = makeApp(mount);
    apps.set(mount, app);
  }
  return app.fetch(req, env, ctx);
}

/** Cloudflare caches only this entrypoint, never the Studio/API router. */
export class PublicHtml extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    if (!publicHtmlRequest(req, normalizeMount(this.env.MOUNT))) {
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    // Render the same bytes for GET and HEAD so their validators agree.
    const response = await fetchApp(new Request(req, { method: 'GET' }), this.env, this.ctx);
    return htmlCacheResponse(req, response);
  }
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    if (publicHtmlRequest(req, normalizeMount(env.MOUNT))) {
      // Browser reloads validate saved bytes; HTML ignores range requests.
      const headers = new Headers(req.headers);
      for (const name of ['cache-control', 'pragma', 'if-none-match', 'if-modified-since', 'range', 'if-range']) headers.delete(name);
      const read = new Request(req, { method: 'GET', headers });
      return ctx.exports.PublicHtml.fetch(read, { cf: { cacheKey: publicHtmlKey(req) } })
        .then(response => conditionalHtmlResponse(req, response));
    }
    return fetchApp(req, env, ctx);
  },
  // The minute tick only warms XML; the 15-minute tick polls due subscriptions.
  // Due-selection and backoff live in importer/schedule.ts.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === '* * * * *') {
      ctx.waitUntil(refreshConfiguredFeed(env, normalizeMount(env.MOUNT), work => ctx.waitUntil(work)).catch(() => {
        console.warn('Scheduled feed rebuild failed');
      }));
      return;
    }
    const daily = () => {
      ctx.waitUntil(repairImportedUrls(env.DB).catch(() => {
        console.warn('Imported URL repair failed');
      }));
      ctx.waitUntil(pruneFailedInbound(env.DB).catch(() => {}));
    };
    if (controller.cron === '0 0 * * *') {
      daily();
      return;
    }
    // A config from before 0.32 lists only "*/15 * * * *" and would never run
    // the daily work, so the quarter-hour tick covering 00:00 UTC runs it too.
    // Both jobs are idempotent: an install with both crons runs them twice.
    const at = new Date(controller.scheduledTime);
    if (at.getUTCHours() === 0 && at.getUTCMinutes() < 15) daily();
    ctx.waitUntil(runScheduledPoll(env.DB, platformFetchFor(env)));
    // Outbound mentions retry here (§2.3.4): the publish path tries once
    // immediately, and a receiver that was down gets it on a later tick.
    ctx.waitUntil(drainOutbound(env.DB, mentionFetchFor(env)).catch(() => {}));
  },
};
