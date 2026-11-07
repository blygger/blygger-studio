// Snapshot freshness for threads — decision #33's direct check, and the
// detection half of #38 ("detect always, refresh only on a decision, never
// silently").
//
// A thread bakes each quote at the version it held when it published (§10.2).
// That quote is *stale* when a newer version of the same target exists, and
// only the direct relation counts: a quote of B is not stale because B's own
// quote of C moved (§10.4, #45). Two places a newer version can be:
//
//   - **here** — our own item has been republished, or the importer has already
//     pulled the source's new version. A republish re-bakes it now.
//   - **only at the origin** — the source has republished and our import has
//     not caught up. Fetching `{origin}items/{id}.json` and comparing `version`
//     is the whole check (§5.9); a refresh resyncs that subscription first.
//
// "What a republish would bake" is answered by `resolveTarget` itself, not by a
// second lookup written to agree with it, so this report cannot drift from
// what publish actually does.

import { fetchOnSurface, itemUrl } from "./surface.ts";
import type { ItemRow, Transclusion } from "./types.ts";
import { resolveTarget, locateSelection } from "./transclusion.ts";
import type { FetchLike } from "./importer/http.ts";
import { withoutComments } from "./comments.ts";

export type QuoteStatus =
  /** Baked at the newest version anyone knows of. */
  | "current"
  /** A newer version is held locally; a republish re-bakes it. */
  | "refreshable"
  /** The origin has a newer version than our import; a refresh resyncs first. */
  | "behind"
  /** A newer version exists, but the quoted passage is no longer in it, so a republish would fail (§10.2). */
  | "passage-missing"
  /** The target no longer resolves at all, so a republish would fail. */
  | "unresolvable"
  /** The source was withdrawn and a pinned version is retained; a republish bakes that pin. */
  | "retained";

export interface QuoteFreshness {
  id: string;
  /** Present for remote quotes; absent for our own items (§10.3). */
  origin?: string;
  /** The version baked into the published thread. */
  baked: number;
  /** The version a republish would bake now; null when the target no longer resolves. */
  held: number | null;
  /** The version the origin serves right now, when probed; null when the probe failed or was not run. */
  live: number | null;
  /** Partial transclusions (§10.1) re-run the substring check on refresh. */
  partial: boolean;
  status: QuoteStatus;
  reason?: string;
}

export interface ThreadFreshness {
  id: string;
  version: number;
  /**
   * A refresh republishes the working copy, so it is allowed only when that
   * copy would republish the published words unchanged — see `holdsPublishedWords`.
   */
  dirty: boolean;
  quotes: QuoteFreshness[];
  /** Quotes a refresh would change. */
  stale: number;
  /** Quotes that would make a republish fail. */
  blocking: number;
  /**
   * How far behind the thread is: the versions its stale quotes have missed,
   * summed (each quote counts newest-known minus baked). The updates tab sorts
   * by it, so the stalest threads come first and small drift waits for a batch.
   */
  behind: number;
}

/** Statuses a refresh changes. */
export const STALE: ReadonlySet<QuoteStatus> = new Set(["refreshable", "behind"]);
/** Statuses that make any republish fail until the author edits the thread. */
export const BLOCKING: ReadonlySet<QuoteStatus> = new Set(["passage-missing", "unresolvable"]);

const PROBE_TIMEOUT_MS = 5000;

/**
 * The origin's current version of one item, or null when it cannot be read.
 * A failed probe is inconclusive, never evidence (the same stance as
 * `checkForkTarget`): an unreachable origin must not mark a quote stale.
 */
export async function probeVersion(fetchFn: FetchLike, origin: string, id: string, db?: D1Database): Promise<number | null> {
  try {
    const init = { headers: { Accept: "application/json" } };
    const res = await Promise.race([
      db
        ? fetchOnSurface(db, origin, fetchFn, (s) => itemUrl(origin, s, id), init).then((r) => r.res)
        : fetchFn(itemUrl(origin, null, id), init),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS)),
    ]);
    if (!res.ok) return null;
    const doc = JSON.parse(await res.text()) as { version?: unknown; id?: unknown };
    if (doc.id !== id || typeof doc.version !== "number" || !Number.isInteger(doc.version)) return null;
    return doc.version;
  } catch {
    return null;
  }
}

async function quoteFreshness(db: D1Database, entry: Transclusion, threadId: string, fetchFn?: FetchLike): Promise<QuoteFreshness> {
  const base = { id: entry.id, ...(entry.origin ? { origin: entry.origin } : {}), baked: entry.version, partial: !!entry.selector };
  const resolved = await resolveTarget(db, entry.id, threadId);
  if (!resolved.ok) return { ...base, held: null, live: null, status: "unresolvable", reason: resolved.reason };
  const target = resolved.target;
  // The target may now resolve to a different origin than the one baked —
  // a re-subscription, a moved blyg. A republish would follow the new one,
  // so that is what is reported; the probe follows it too.
  const origin = target.origin;
  const live = origin && fetchFn ? await probeVersion(fetchFn, origin, entry.id, db) : null;
  const out = { ...base, ...(origin ? { origin } : {}), held: target.version, live };
  if (live !== null && live > target.version) return { ...out, status: "behind" };
  if (target.version === entry.version) return { ...out, status: "current" };
  if (target.version < entry.version) {
    return { ...out, status: "retained", reason: `source withdrawn; a republish bakes its pinned v${target.version}` };
  }
  if (entry.selector && !locateSelection(target.contentHtml, entry.selector.exact)) {
    return { ...out, status: "passage-missing", reason: `the quoted passage is not in v${target.version}` };
  }
  return { ...out, status: "refreshable" };
}

/**
 * Would publishing the working copy republish exactly the published words?
 * `dirty` alone is too strict: "discard changes" restores the published
 * version and still leaves `dirty = 1`, deliberately (a restored copy has lost
 * its positional TK provenance cache, restore-version.test.ts). That loss is
 * the one real hazard: a version that disclosed generated text would republish
 * *without* `generated[]`. So the copy counts as the published words when it is
 * clean, or when it is byte-equal to the published `content_md` and the
 * published version disclosed no generation.
 */
export function holdsPublishedWords(
  item: Pick<ItemRow, "dirty" | "content_md">,
  published: { content_md: string; generated_json: string | null } | null,
): boolean {
  if (item.dirty !== 1) return true;
  return !!published && withoutComments(item.content_md) === published.content_md && !published.generated_json;
}

/**
 * Freshness of every quote in a thread's **published** version — what readers
 * hold, not the working copy. `fetchFn` turns on the live origin probe; without
 * it the report is database-only and "behind" cannot occur.
 */
export async function threadFreshness(db: D1Database, item: ItemRow, fetchFn?: FetchLike): Promise<ThreadFreshness> {
  const row = await db
    .prepare("SELECT transclusions, content_md, generated_json FROM versions WHERE item_id = ? AND version = ?")
    .bind(item.id, item.version)
    .first<{ transclusions: string | null; content_md: string; generated_json: string | null }>();
  let entries: Transclusion[] = [];
  try {
    entries = row?.transclusions ? (JSON.parse(row.transclusions) as Transclusion[]) : [];
  } catch {
    entries = [];
  }
  // Probes run in parallel: a thread quoting six origins should not take six timeouts.
  const quotes = await Promise.all(entries.map((entry) => quoteFreshness(db, entry, item.id, fetchFn)));
  return {
    id: item.id,
    version: item.version,
    dirty: !holdsPublishedWords(item, row),
    quotes,
    stale: quotes.filter((q) => STALE.has(q.status)).length,
    blocking: quotes.filter((q) => BLOCKING.has(q.status)).length,
    behind: quotes.reduce((n, q) => n + versionsMissed(q), 0),
  };
}

/** Versions a stale quote has missed; zero for every other status. */
export function versionsMissed(q: QuoteFreshness): number {
  if (!STALE.has(q.status)) return 0;
  return Math.max(0, Math.max(q.held ?? q.baked, q.live ?? 0) - q.baked);
}

/**
 * Every published thread with at least one stale or blocking quote, database
 * only — the cross-blyg view behind the updates tab, stalest first (`behind`,
 * then stale quotes, then blocking ones; most recently updated breaks ties). No network: the importer keeps imports current on
 * its own schedule, and probing every origin of every thread on a page load is
 * a cost the per-thread view pays on demand instead.
 */
export async function staleThreads(db: D1Database): Promise<ThreadFreshness[]> {
  const threads = await db
    .prepare("SELECT * FROM items WHERE status = 'public' AND kind = 'thread' ORDER BY updated DESC, rowid DESC")
    .all<ItemRow>();
  const out: ThreadFreshness[] = [];
  for (const item of threads.results) {
    const report = await threadFreshness(db, item);
    if (report.stale || report.blocking) out.push(report);
  }
  // Array.prototype.sort is stable, so the query's recency order breaks ties.
  return out.sort((a, b) => b.behind - a.behind || b.stale - a.stale || b.blocking - a.blocking);
}
