import { deploymentPaths } from '../util.ts';
import { success, created, failure, type OperationContext, type OperationInput } from '../operation-types.ts';
import { feedUrl as surfaceFeedUrl, surfaceFromManifest } from "../surface.ts";
import { platformFetchFor } from "./http.ts";
import type { SubscriptionRow, HopperRow } from "../types.ts";
import { subscriptionResource, hopperResource } from "../contract/resources.ts";
// Subscribe-side owner API (cookie auth, JSON) — v0.2-plan.md §4.2. Mounted
// alongside ../api.ts under /api.



import { pollSubscription, reconcileIndex } from "./poll.ts";
import { pollAll } from "./schedule.ts";
import { listSubscriptions } from "./store.ts";
import { markRead, markReadBatch, markUnread, markUnreadBatch, READ_ID_MAX, type ReadMark, type UnreadMark } from "./read-state.ts";
import { resolve } from "./resolve.ts";
import {
  addHopperItem,
  createHopper,
  createSubscription,
  findSubscription,
  deleteHopper,
  deleteSignal,
  deleteSubscription,
  getHopper,
  getHopperBySlug,
  getSubscription,
  OWN_SUBSCRIPTION,
  removeHopperItem,
  setSignal,
} from "./store.ts";
import { getItem } from "../model.ts";


function titleFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Two-phase add-by-URL (§2.1/§4.2): without `confirm`, resolves and returns
 * the identity for the owner to confirm (surfacing any site-vs-origin
 * mismatch); with `confirm: true`, actually creates the subscription and
 * starts an initial backfill so the first read isn't empty. The backfill runs
 * after the response: it fetches the whole archive item by item, which held
 * the confirm button for many seconds on a large blyg.
 */
const createSubscriptionOperation = async (context: OperationContext, input: OperationInput) => {
  const body = (input.body as { url: string; confirm?: boolean; title?: string; backfill?: boolean });
  if (!body.url.trim()) return failure('invalid-input', { error: "url required" });

  const result = await resolve(body.url.trim(), platformFetchFor(context.env));
  if (result.kind === "failure") {
    return failure('unprocessable', { error: "could not resolve this URL to a blyg or a feed", tried: result.tried });
  }

  // One subscription per source: a second one imports every item twice, and
  // then any reference to those ids is ambiguous between the two (stub refuses).
  // §6.1: the manifest says where the surface lives; absent keys are the defaults.
  const surface = result.kind === "blyg" ? surfaceFromManifest(result.origin, result.manifestUrl, result.manifest) : null;
  const feedUrl = result.kind === "blyg" ? surfaceFeedUrl(result.origin, surface) : result.feedUrl;
  const identity = result.kind === "blyg" ? result.origin : result.feedUrl;
  const existing = await findSubscription(context.env.DB, identity, feedUrl);
  if (existing) return failure('conflict', { error: `already subscribed to ${existing.title || existing.origin}` });

  if (!body.confirm) {
    if (result.kind === "blyg") {
      return success({
        needsConfirm: true,
        kind: "blyg",
        origin: result.origin,
        title: typeof result.manifest.title === "string" ? result.manifest.title : titleFromUrl(result.origin),
        siteMismatch: result.siteMismatch,
      });
    }
    return success({ needsConfirm: true, kind: "rss", feedUrl: result.feedUrl, title: titleFromUrl(result.feedUrl) });
  }

  const title = body.title?.trim() || undefined;
  // The confirm dialog offers the source's own name; sending it back unchanged
  // keeps the subscription following the source. Anything else is the owner's.
  const sourceTitle = result.kind === "blyg" ? (typeof result.manifest.title === "string" ? result.manifest.title : titleFromUrl(result.origin)) : titleFromUrl(result.feedUrl);
  const titleAuto = title === undefined || title === sourceTitle.trim();
  const sub =
    result.kind === "blyg"
      ? await createSubscription(context.env.DB, { kind: "blyg", origin: result.origin, feedUrl, title: title ?? sourceTitle, titleAuto, surface })
      : await createSubscription(context.env.DB, { kind: "rss", origin: result.feedUrl, feedUrl: result.feedUrl, title: title ?? sourceTitle, titleAuto });
  // Initial backfill (§3.2 step 4 / plan §7 open decision #2: import the full
  // archive on first subscribe) — a fresh subscription's null
  // last_index_sync_at makes the very first pollSubscription() call reconcile
  // unconditionally, which also bootstraps newest_guid/etag for future gap
  // detection (§3.2) in one pass, for both kinds uniformly. If waitUntil cuts
  // it short, the null last_poll_at and last_index_sync_at make the next
  // scheduled poll due and reconcile again, so the backfill completes there.
  // `backfill: false` (bulk imports, e.g. OPML) skips it: isDue() treats a
  // null last_poll_at as due, so the next quarter-hour tick imports it instead.
  if (body.backfill !== false) context.defer(pollSubscription(context.env.DB, sub, platformFetchFor(context.env)).catch(() => {}));
  return created(subscriptionResource(sub), `${deploymentPaths(context.env.MOUNT).api}/subscriptions/${sub.id}`);
};

const updateSubscriptionOperation = async (context: OperationContext, input: OperationInput) => {
  const sub = await getSubscription(context.env.DB, input.path.id);
  if (!sub) return failure('not-found', { error: "not found" });
  const body = (input.body as { inBlogroll?: boolean; title?: string | null; paused?: boolean });
  const assignments: string[] = [], values: (string | number)[] = [];
  // A name of the owner's own stops the refresh; null hands it back to the source.
  if (typeof body.title === "string") { assignments.push("title = ?", "title_auto = 0"); values.push(body.title); }
  if (body.title === null) assignments.push("title_auto = 1", "last_index_sync_at = NULL");
  if (body.inBlogroll !== undefined) { assignments.push("in_blogroll = ?"); values.push(body.inBlogroll ? 1 : 0); }
  if (body.paused !== undefined) { assignments.push("status = ?"); values.push(body.paused ? "paused" : "active"); }
  if (!assignments.length) return success(subscriptionResource(sub));
  const fresh = await context.env.DB.prepare(`UPDATE subscriptions SET ${assignments.join(", ")} WHERE id = ? RETURNING *`).bind(...values, sub.id).first<SubscriptionRow>();
  return fresh ? success(subscriptionResource(fresh)) : failure('not-found', { error: "subscription no longer exists" });
};

/** Poll every subscription that is not paused, in the background; answers at once with how many. */
const pollAllSubscriptionsOperation = async (context: OperationContext, input: OperationInput) => {
  const polling = (await listSubscriptions(context.env.DB)).filter((s) => s.status !== "paused").length;
  context.defer(pollAll(context.env.DB, platformFetchFor(context.env)).catch(() => {}));
  return success({ polling });
};

/** Force an index reconciliation right now, regardless of the periodic schedule. */
const resyncSubscriptionOperation = async (context: OperationContext, input: OperationInput) => {
  const sub = await getSubscription(context.env.DB, input.path.id);
  if (!sub) return failure('not-found', { error: "not found" });
  if (sub.kind !== "blyg") return failure('conflict', { error: "resync only applies to blyg subscriptions" });
  const result = await reconcileIndex(context.env.DB, sub, platformFetchFor(context.env));
  return success({ ok: result.ok, changed: result.changed });
};

const deleteSubscriptionOperation = async (context: OperationContext, input: OperationInput) => {
  const sub = await getSubscription(context.env.DB, input.path.id);
  if (!sub) return failure('not-found', { error: "not found" });
  await deleteSubscription(context.env.DB, sub.id);
  return success({ ok: true });
};

// --- Hoppers + signals (task 10, §3.4/§4.2) ---

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "hopper"
  );
}

/** Slugify, then disambiguate against every other hopper's slug (`exceptId` lets a rename keep its own). */
async function uniqueSlug(db: D1Database, name: string, exceptId?: string): Promise<string> {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; ; i++) {
    const clash = await getHopperBySlug(db, slug);
    if (!clash || clash.id === exceptId) return slug;
    slug = `${base}-${i}`;
  }
}

const createHopperOperation = async (context: OperationContext, input: OperationInput) => {
  const body = (input.body as { name: string });
  if (!body.name.trim()) return failure('invalid-input', { error: "name required" });
  const hopper = await createHopper(context.env.DB, body.name.trim(), await uniqueSlug(context.env.DB, body.name.trim()));
  return created(hopperResource(hopper), `${deploymentPaths(context.env.MOUNT).api}/hoppers/${hopper.id}`);
};

const updateHopperOperation = async (context: OperationContext, input: OperationInput) => {
  const hopper = await getHopper(context.env.DB, input.path.id);
  if (!hopper) return failure('not-found', { error: "not found" });
  const body = (input.body as { public?: boolean; name?: string; description?: string });
  // An empty description clears it; an absent one leaves it alone.
  const description = body.description === undefined ? undefined : body.description.trim() || null;

  // Compute the rename before freezing the public URL. Apply both in one SQL update.
  const slug = body.name === undefined || hopper.slug_frozen ? hopper.slug : await uniqueSlug(context.env.DB, body.name, hopper.id);
  const fresh = await context.env.DB.prepare("UPDATE hoppers SET name = COALESCE(?, name), slug = ?, public = COALESCE(?, public), slug_frozen = MAX(slug_frozen, ?), description = CASE WHEN ? THEN ? ELSE description END WHERE id = ? AND slug_frozen = ? AND slug IS ? RETURNING *")
    .bind(body.name ?? null, slug, body.public === undefined ? null : Number(body.public), Number(body.public === true), description === undefined ? 0 : 1, description ?? null, hopper.id, hopper.slug_frozen, hopper.slug).first<HopperRow>();
  return fresh ? success(hopperResource(fresh)) : failure('conflict', { error: "hopper changed while applying the patch; reload and try again" });
};

const deleteHopperOperation = async (context: OperationContext, input: OperationInput) => {
  const hopper = await getHopper(context.env.DB, input.path.id);
  if (!hopper) return failure('not-found', { error: "not found" });
  await deleteHopper(context.env.DB, hopper.id);
  return success({ ok: true });
};

const addHopperItemOperation = async (context: OperationContext, input: OperationInput) => {
  const hopper = await getHopper(context.env.DB, input.path.id);
  if (!hopper) return failure('not-found', { error: "hopper not found" });
  // One of the owner's own items: any that exists; the public page shows only published ones.
  if (input.path.sub === OWN_SUBSCRIPTION) {
    if (!(await getItem(context.env.DB, input.path.remoteId))) return failure('not-found', { error: "item not found" });
    await addHopperItem(context.env.DB, hopper.id, OWN_SUBSCRIPTION, input.path.remoteId);
    return success({ ok: true });
  }
  const sub = await getSubscription(context.env.DB, input.path.sub);
  if (!sub) return failure('not-found', { error: "subscription not found" });
  await addHopperItem(context.env.DB, hopper.id, sub.id, input.path.remoteId);
  return success({ ok: true });
};

const removeHopperItemOperation = async (context: OperationContext, input: OperationInput) => {
  const hopper = await getHopper(context.env.DB, input.path.id);
  if (!hopper) return failure('not-found', { error: "hopper not found" });
  await removeHopperItem(context.env.DB, hopper.id, input.path.sub, input.path.remoteId);
  return success({ ok: true });
};

const setSignalOperation = async (context: OperationContext, input: OperationInput) => {
  const sub = await getSubscription(context.env.DB, input.path.sub);
  if (!sub) return failure('not-found', { error: "subscription not found" });
  const body = (input.body as { thumb: 1 | -1 });
  await setSignal(context.env.DB, sub.id, input.path.remoteId, body.thumb);
  return success({ ok: true });
};

const deleteSignalOperation = async (context: OperationContext, input: OperationInput) => {
  await deleteSignal(context.env.DB, input.path.sub, input.path.remoteId);
  return success({ ok: true });
};

// Read state (read-state.ts). An unknown subscription or item is 200 with
// `stored: false`, never 404: clients take a 404 here to mean the server
// keeps no read state, and turn sync off.
const markReadOperation = async (context: OperationContext, input: OperationInput) => {
  const sub = input.path.sub, remoteId = input.path.remoteId;
  if (sub.length > READ_ID_MAX || remoteId.length > READ_ID_MAX) return failure('invalid-input', { error: "id too long" });
  const { version, readAt } = (input.body as { version: number; readAt?: string });
  const result = await markRead(context.env.DB, sub, remoteId, version, readAt);
  return success({ ok: true, stored: result.stored, readVersion: result.read_version });
};

// The whole list is validated before anything is written, and the writes are
// one batch: one request, one transaction, one unit of the write budget.
const markReadBatchOperation = async (context: OperationContext, input: OperationInput) => {
  const { items: entries } = input.body as { items: { sub: string; remoteId: string; version: number; readAt?: string }[] };
  const items: ReadMark[] = entries.map(row => ({ sub: row.sub, remote_id: row.remoteId, version: row.version, read_at: row.readAt }));
  await markReadBatch(context.env.DB, items);
  return success({ ok: true, received: items.length });
};

// Clearing leaves a tombstone (unread_at) and always answers the same body:
// whether or not a row was held, nothing is read now. Idempotent, never 404.
const markUnreadOperation = async (context: OperationContext, input: OperationInput) => {
  const sub = input.path.sub, remoteId = input.path.remoteId;
  if (sub.length > READ_ID_MAX || remoteId.length > READ_ID_MAX) return failure('invalid-input', { error: "id too long" });
  await markUnread(context.env.DB, sub, remoteId);
  return success({ ok: true, stored: false as const, readVersion: null });
};

// Same validation and budget shape as the read batch.
const markUnreadBatchOperation = async (context: OperationContext, input: OperationInput) => {
  const { items: entries } = input.body as { items: { sub: string; remoteId: string }[] };
  const items: UnreadMark[] = entries.map(row => ({ sub: row.sub, remote_id: row.remoteId }));
  await markUnreadBatch(context.env.DB, items);
  return success({ ok: true, received: items.length });
};

export const importOperations = {
  createSubscription: createSubscriptionOperation,
  updateSubscription: updateSubscriptionOperation,
  pollAllSubscriptions: pollAllSubscriptionsOperation,
  resyncSubscription: resyncSubscriptionOperation,
  deleteSubscription: deleteSubscriptionOperation,
  createHopper: createHopperOperation,
  updateHopper: updateHopperOperation,
  deleteHopper: deleteHopperOperation,
  addHopperItem: addHopperItemOperation,
  removeHopperItem: removeHopperItemOperation,
  setSignal: setSignalOperation,
  deleteSignal: deleteSignalOperation,
  markRead: markReadOperation,
  markReadBatch: markReadBatchOperation,
  markUnread: markUnreadOperation,
  markUnreadBatch: markUnreadBatchOperation,
};
