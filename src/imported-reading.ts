// Every imported item, keyset-paged, with authoring-grade fields (studio#11
// item 2): the feed a non-browser reader (Blygger Desktop) syncs from. GET
// /reading is the Studio's merged timeline: own and imported entries,
// sanitized HTML only, offset-paged. This is the other shape: imported only,
// newest observed first, with the markdown, author, signal, hopper membership,
// lineage and the origin's transclusions per row, so a client needs no
// per-row GET /imports/{sub}/{id}.
//
// The order is (observed_at, subscription_id, remote_id) descending. One poll
// run stamps one observed_at on everything it imports, so a backfill is one
// large tie and an offset or a bare timestamp cannot resume inside it. The
// cursor names the last row returned and the next page starts strictly after
// it, so rows observed later (a poll between two page requests) land ahead of
// the walk and never shift it: no drops, no repeats.
import { sanitizeHtml } from "./importer/sanitize.ts";
import { sourceTitleAndUrl } from "./importer/util.ts";
import type { ImportedItemRow } from "./types.ts";

export const IMPORTED_READING_DEFAULT = 50;
export const IMPORTED_READING_MAX = 100;
/** A cursor longer than this is not one we issued. */
export const READING_CURSOR_MAX = 2048;

export interface ReadingCursor { observedAt: string; sub: string; remoteId: string }

/** Opaque to clients: base64url of JSON [observed_at, subscription_id, remote_id]. */
export function encodeReadingCursor(c: ReadingCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify([c.observedAt, c.sub, c.remoteId]));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** null for anything this server did not issue: wrong alphabet, bad base64, bad JSON, wrong shape. */
export function decodeReadingCursor(raw: string): ReadingCursor | null {
  if (!raw || raw.length > READING_CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (raw.length % 4)) % 4));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))) as unknown;
    if (!Array.isArray(value) || value.length !== 3 || !value.every((part) => typeof part === "string" && part.length > 0)) return null;
    const [observedAt, sub, remoteId] = value as string[];
    return { observedAt, sub, remoteId };
  } catch {
    return null;
  }
}

type Row = ImportedItemRow & { subscription_title: string; origin: string; thumb: number | null; hoppers_json: string; read_version: number | null };

// Hopper ids sorted so the array is stable between polls. read_state is the
// owner's own (migration 0026); a cleared row holds NULL, which reads as unread.
const SELECT = `
  SELECT i.*, s.title AS subscription_title, s.origin, g.thumb, rs.read_version,
         (SELECT json_group_array(hopper_id) FROM (SELECT hi.hopper_id FROM hopper_items hi
           WHERE hi.subscription_id = i.subscription_id AND hi.remote_id = i.remote_id ORDER BY hi.hopper_id)) AS hoppers_json
  FROM imported_items i
  JOIN subscriptions s ON s.id = i.subscription_id
  LEFT JOIN signals g ON g.subscription_id = i.subscription_id AND g.remote_id = i.remote_id
  LEFT JOIN read_state rs ON rs.subscription_id = i.subscription_id AND rs.remote_id = i.remote_id`;
const ORDER = "ORDER BY i.observed_at DESC, i.subscription_id DESC, i.remote_id DESC";

/** Stored remote JSON, verbatim; null when absent, malformed or not of the expected kind. */
function parsed<T>(raw: string | null, accept: (value: unknown) => value is T): T | null {
  if (!raw) return null;
  try { const value = JSON.parse(raw) as unknown; return accept(value) ? value : null; }
  catch { return null; }
}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

function author(raw: string | null) {
  const value = parsed(raw, isObject);
  if (!value) return null;
  return { name: typeof value.name === "string" ? value.name : null, url: typeof value.url === "string" ? value.url : null };
}

async function entry(row: Row) {
  return {
    subscriptionId: row.subscription_id,
    subscriptionTitle: row.subscription_title || row.origin || row.subscription_id,
    origin: row.origin,
    remoteId: row.remote_id,
    kind: row.kind,
    withdrawn: row.state === "tombstone",
    l0: row.l0 === 1,
    version: row.version,
    readVersion: typeof row.read_version === "number" ? row.read_version : null,
    created: row.created,
    updated: row.updated,
    observedAt: row.observed_at,
    contentMd: row.content_md,
    contentHtml: await sanitizeHtml(row.content_html),
    author: author(row.author_json),
    page: row.page,
    sourceUrl: sourceTitleAndUrl(row, row.origin).url,
    pinnedVersionRetained: row.pinned_version_retained,
    thumb: row.thumb === 1 || row.thumb === -1 ? row.thumb : null,
    hoppers: (parsed(row.hoppers_json, isArray) ?? []).filter((id): id is string => typeof id === "string"),
    transclusions: parsed(row.transclusions_json, isArray),
    stubOf: parsed(row.stub_of_json, isObject),
    forkedFrom: parsed(row.forked_from_json, isObject),
  };
}

/** One page after `cursor` (or from the newest). The cursor was validated by the contract. */
export async function importedReading(db: D1Database, cursor: string | undefined, limit: number) {
  const after = cursor ? decodeReadingCursor(cursor) : null;
  const stmt = after
    ? db.prepare(`${SELECT} WHERE (i.observed_at, i.subscription_id, i.remote_id) < (?, ?, ?) ${ORDER} LIMIT ?`).bind(after.observedAt, after.sub, after.remoteId, limit + 1)
    : db.prepare(`${SELECT} ${ORDER} LIMIT ?`).bind(limit + 1);
  const rows = (await stmt.all<Row>()).results;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: await Promise.all(page.map(entry)),
    next: rows.length > limit && last ? encodeReadingCursor({ observedAt: last.observed_at, sub: last.subscription_id, remoteId: last.remote_id }) : null,
    limit,
  };
}
