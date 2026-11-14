// Imported authoring feed, with bounded generation-bound keyset pages.
import { readSyndication } from "./syndication.ts";
import { cursorPage } from "./cursor-page.ts";
import { sanitizeHtml } from "./importer/sanitize.ts";
import { sourceTitleAndUrl } from "./importer/util.ts";
import type { ImportedItemRow } from "./types.ts";

export const IMPORTED_READING_DEFAULT = 50;
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
    generated: parsed(row.generated_json, isArray),
    syndication: readSyndication(parsed(row.syndication_json ?? null, isArray)),
  };
}

/** Projection stays inside the cursor's generation guard, including remote metadata joins. */
export async function importedReading(db: D1Database, cursor: string | undefined, limit: number) {
  return cursorPage<Row, Awaited<ReturnType<typeof entry>>>(db, { cursor, limit }, {
    name: 'reading-imported', domains: ['reading', 'subscriptions', 'signals', 'hoppers'], sql: SELECT,
    order: [{ column: 'observed_at', direction: 'desc' }, { column: 'subscription_id', direction: 'desc' }, { column: 'remote_id', direction: 'desc' }],
    project: rows => Promise.all(rows.map(entry)),
  });
}
