// Outbound Webmention — v0.3-plan §2.3.3/§2.3.4, decision #28. Publishing
// enqueues; the cron drains. Delivery is fire-and-forget from the author's
// point of view: publish never blocks on it and never fails because of it.

import type { FetchLike } from "../importer/http.ts";
import { blygItemUrl } from "../importer/util.ts";
import { isBlygStub, parseStoredFork, parseStoredStub } from "../stub.ts";
import type { ScopeProvenance, Transclusion, VersionRow } from "../types.ts";
import { itemUrl, manifestUrl, parseSurface, surfaceFromManifest, type Surface } from "../surface.ts";
import { discoverEndpoint } from "./discover.ts";
import { boundedText } from "./http.ts";
import { dueOutbound, enqueueOutbound, markOutbound, RETRY_SCHEDULE_MS } from "./store.ts";

/** One reference worth telling someone about: where it points, and (for a blyg) whose origin that is. */
export interface RemoteRef {
  target: string;
  origin?: string;
  /**
   * The target's own version, which is what §15.2's re-send test compares.
   * Null for a `{url}` stub: a plain web page has no version, so such a
   * reference can never be "changed" and is therefore sent exactly once.
   */
  targetVersion?: number | null;
  /** A webmention endpoint learnt while building the target (an unsubscribed origin's manifest), recorded so delivery need not rediscover it. */
  endpoint?: string;
}

/**
 * What we know about a target origin's surface, for building mention targets:
 * where its item documents live and, for an origin we only just read, where it
 * takes mentions.
 */
interface OriginSurface {
  surface: Surface | null;
  /**
   * The manifest's `webmention` endpoint, carried only when the manifest was
   * fetched here. A subscribed origin's endpoint is found at delivery from its
   * subscription; an unsubscribed one has no row for that lookup to find, and
   * its item document is JSON with no `rel="webmention"` for W3C discovery.
   */
  endpoint?: string;
}

type SurfaceCache = Map<string, Promise<OriginSurface>>;

/**
 * The target origin's surface, read once per origin per call: a subscription's
 * stored surface when we hold one (no network), otherwise `{origin}blyg.json`
 * fetched with the caller's bounded fetch. Absent, unreadable or without
 * `item`, the defaults apply — `items/{id}.json` is served by every blyg (§4).
 */
function originSurface(db: D1Database, origin: string, fetchFn: FetchLike | undefined, cache: SurfaceCache): Promise<OriginSurface> {
  let hit = cache.get(origin);
  if (!hit) {
    hit = (async () => {
      const sub = await db
        .prepare("SELECT surface FROM subscriptions WHERE kind = 'blyg' AND origin = ? LIMIT 1")
        .bind(origin)
        .first<{ surface: string | null }>();
      if (sub) return { surface: parseSurface(sub.surface) };
      return fetchFn ? fetchOriginManifest(origin, fetchFn) : { surface: null };
    })();
    cache.set(origin, hit);
  }
  return hit;
}

async function fetchOriginManifest(origin: string, fetchFn: FetchLike): Promise<OriginSurface> {
  const url = manifestUrl(origin, null);
  try {
    const res = await fetchFn(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return { surface: null };
    const body = await boundedText(res);
    const manifest: unknown = body ? JSON.parse(body) : null;
    if (!manifest || typeof manifest !== "object") return { surface: null };
    const m = manifest as Record<string, unknown>;
    const at = res.url || url;
    const endpoint = typeof m.webmention === "string" && m.webmention ? new URL(m.webmention, at).toString() : undefined;
    return { surface: surfaceFromManifest(origin, at, m), endpoint };
  } catch {
    // Unreachable is not proof of a template: the default address stands.
    return { surface: null };
  }
}

/**
 * A remote item's mention target (§15.2, sixth revision; decision #85): its
 * own declared `page` when we hold it, otherwise its **item document** at the
 * address the origin's `item` template names (default `items/{id}.json`).
 * Never the `f/`·`t/` convention — that is presentation (§4), and guessing the
 * kind wrong (a thread taken for a fragment) names a page that does not exist.
 */
async function remoteTarget(
  db: D1Database,
  origin: string,
  id: string,
  fetchFn: FetchLike | undefined,
  cache: SurfaceCache,
): Promise<{ target: string; endpoint?: string }> {
  const row = await db
    .prepare(
      `SELECT ii.kind AS kind, ii.page AS page FROM imported_items ii
       JOIN subscriptions s ON s.id = ii.subscription_id
       WHERE ii.remote_id = ? AND s.origin = ? AND s.hopper_feed IS NULL`,
    )
    .bind(id, origin)
    .first<{ kind: string; page: string | null }>();
  if (row?.page) return { target: blygItemUrl(origin, row.kind, id, row.page) };
  const { surface, endpoint } = await originSurface(db, origin, fetchFn, cache);
  return { target: itemUrl(origin, surface, id), endpoint };
}

function parseGenerated(json: string | null): ScopeProvenance[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ScopeProvenance[]) : [];
  } catch {
    return [];
  }
}

/**
 * Every **remote-origin** reference in one published version: the `stub_of`
 * citation (either shape), every transclusion carrying an `origin`, and every
 * generation source carrying one.
 * Same-origin references never generate a mention — telling ourselves
 * something we already know is noise, not notification.
 */
export async function remoteReferences(
  db: D1Database,
  itemId: string,
  row: VersionRow,
  ourOrigin: string,
  fetchFn?: FetchLike,
): Promise<RemoteRef[]> {
  const refs: RemoteRef[] = [];
  const cache: SurfaceCache = new Map();
  const stub = parseStoredStub(row.stub_of);
  if (stub) {
    if (isBlygStub(stub)) {
      if (stub.origin !== ourOrigin) {
        refs.push({ ...(await remoteTarget(db, stub.origin, stub.id, fetchFn, cache)), origin: stub.origin, targetVersion: stub.version });
      }
    } else {
      refs.push({ target: stub.url, targetVersion: null });
    }
  }
  for (const t of (JSON.parse(row.transclusions ?? "[]") as Transclusion[])) {
    if (!t.origin || t.origin === ourOrigin) continue;
    refs.push({ ...(await remoteTarget(db, t.origin, t.id, fetchFn, cache)), origin: t.origin, targetVersion: t.version });
  }
  // A remote generation source is a remote reference too (§5.7,
  // decision #44): a model at this origin used those words, so their origin
  // is told, with relation `source`. Same target as a quote of the same item
  // is one mention; the receiver decides the relation.
  for (const g of parseGenerated(row.generated_json)) {
    for (const src of g.sources ?? []) {
      if (!src.origin || src.origin === ourOrigin) continue;
      refs.push({ ...(await remoteTarget(db, src.origin, src.id, fetchFn, cache)), origin: src.origin, targetVersion: src.version });
    }
  }
  // §2.3.3: lineage is a remote reference like any other. It lives on the
  // item rather than the version (§2.4), so it is read from there — and it
  // targets the *live* item (its page, else its item document), not the
  // pinned version, because the receiver records a mention against the item.
  const fork = parseStoredFork(
    (await db.prepare("SELECT forked_from FROM items WHERE id = ?").bind(itemId).first<{ forked_from: string | null }>())?.forked_from ?? null,
  );
  if (fork && fork.origin !== ourOrigin) {
    refs.push({ ...(await remoteTarget(db, fork.origin, fork.id, fetchFn, cache)), origin: fork.origin, targetVersion: fork.version });
  }
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.target) ? false : (seen.add(r.target), true)));
}

/**
 * Queue the mentions for a version that was just published (or withdrawn —
 * §2.3.6 re-sends once, so the receiver can see the source no longer
 * verifies and mark it gone).
 */
export async function enqueueForVersion(
  db: D1Database,
  itemId: string,
  version: number,
  row: VersionRow,
  ourOrigin: string,
  opts: { force?: boolean; fetchFn?: FetchLike } = {},
): Promise<RemoteRef[]> {
  const refs = await remoteReferences(db, itemId, row, ourOrigin, opts.fetchFn);
  for (const ref of refs) {
    await enqueueOutbound(db, itemId, version, ref.target, ref.targetVersion ?? null, { force: opts.force, endpoint: ref.endpoint });
  }
  return refs;
}

/** Which blyg origin, if any, a target URL belongs to — the manifest-first discovery hint (§2.3.4 step 1). */
async function blygOriginFor(db: D1Database, target: string): Promise<string | undefined> {
  // Origins are literal prefixes. D1 caps LIKE patterns at 50 bytes, so one
  // long subscription used to abort delivery for every pending mention.
  const row = await db
    .prepare("SELECT origin FROM subscriptions WHERE kind = 'blyg' AND substr(?, 1, length(origin)) = origin ORDER BY length(origin) DESC LIMIT 1")
    .bind(target)
    .first<{ origin: string }>();
  return row?.origin;
}

export interface DrainResult {
  attempted: number;
  sent: number;
}

/**
 * One delivery pass over the due queue. Called from the publish path (so a
 * stub arrives while the author is still looking at the screen) and from the
 * cron tick (so a receiver that was down gets it later anyway).
 *
 * Classification follows §2.3.4: 2xx is `sent`; 4xx is terminal except 429;
 * network failures and 5xx retry on 15m → 1h → 4h → 12h → 24h and then give
 * up; no endpoint is not a failure and never retries.
 */
export async function drainOutbound(
  db: D1Database,
  fetchFn: FetchLike,
  opts: { now?: number; origin?: string } = {},
): Promise<DrainResult> {
  const now = opts.now ?? Date.now();
  // The publish path knows the request origin; the cron has only `site_url`.
  const origin = opts.origin ?? (await originSetting(db));
  const due = await dueOutbound(db, new Date(now).toISOString());
  let sent = 0;
  for (const row of due) {
    const source = origin ? await sourceUrlFor(db, row.item_id, origin) : null;
    if (!source) {
      await markOutbound(db, row.id, {
        status: "failed",
        error: origin ? "source item is no longer published" : "no canonical origin: set site_url in settings before sending mentions",
      });
      continue;
    }
    let endpoint = row.endpoint;
    if (!endpoint) {
      const found = await discoverEndpoint(row.target, fetchFn, await blygOriginFor(db, row.target));
      if (!found.endpoint) {
        await markOutbound(db, row.id, { status: "no_endpoint", error: found.reason });
        continue;
      }
      endpoint = found.endpoint;
    }

    const attempts = row.attempts + 1;
    try {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ source, target: row.target }).toString(),
      });
      if (res.status >= 200 && res.status < 300) {
        await markOutbound(db, row.id, { status: "sent", endpoint, attempts, nextAttemptAt: null, error: null });
        sent++;
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500;
      await scheduleRetry(db, row.id, endpoint, attempts, retryable, `endpoint returned ${res.status}`, now);
    } catch (e) {
      await scheduleRetry(db, row.id, endpoint, attempts, true, `delivery failed: ${(e as Error).message}`, now);
    }
  }
  return { attempted: due.length, sent };
}

async function scheduleRetry(
  db: D1Database,
  id: string,
  endpoint: string,
  attempts: number,
  retryable: boolean,
  error: string,
  now: number,
): Promise<void> {
  const delay = RETRY_SCHEDULE_MS[attempts - 1];
  if (!retryable || delay === undefined) {
    await markOutbound(db, id, { status: "failed", endpoint, attempts, nextAttemptAt: null, error });
    return;
  }
  await markOutbound(db, id, {
    status: "pending",
    endpoint,
    attempts,
    nextAttemptAt: new Date(now + delay).toISOString(),
    error,
  });
}

/** Our own permalink for the referencing item — the `source` a receiver will fetch and verify. */
async function sourceUrlFor(db: D1Database, itemId: string, origin: string): Promise<string | null> {
  const item = await db.prepare("SELECT id, kind, status, version FROM items WHERE id = ?").bind(itemId).first<{
    id: string;
    kind: string;
    status: string;
    version: number;
  }>();
  if (!item) return null;
  let kind = item.kind;
  if (kind === "withdrawn") {
    const prev = await db
      .prepare("SELECT transclusions FROM versions WHERE item_id = ? AND version = ?")
      .bind(itemId, item.version - 1)
      .first<{ transclusions: string | null }>();
    kind = prev?.transclusions ? "thread" : "fragment";
  }
  return `${origin}${kind === "thread" ? "t" : "f"}/${item.id}/`;
}

/**
 * The origin to speak as when no request is in hand (the cron tick). Only
 * `site_url` can answer that — a scheduled worker has no request to derive an
 * origin from — so a deployment that never set it cannot send, and says so
 * rather than inventing a URL that resolves to nothing.
 */
export async function originSetting(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'site_url'").first<{ value: string }>();
  if (!row?.value) return null;
  return row.value.endsWith("/") ? row.value : row.value + "/";
}

