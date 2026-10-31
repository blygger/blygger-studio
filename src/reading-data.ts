import { authoredItemKindSql, authoredVersionKind } from './version-state.ts';
import { listSubscriptions } from "./importer/store.ts";
import { buildReadingFeed, clampDisplayAt, type OwnEntryInput, type ImportedEntryInput } from "./importer/reading.ts";
import { sourceTitleAndUrl } from "./importer/util.ts";
import { sanitizeHtml } from "./importer/sanitize.ts";
import type { ImportedItemRow } from "./types.ts";

/** Sort small identity/date rows first; load and sanitize bodies only for the selected page. */
/**
 * `kind` is the reading lens (0.25.0): "thread" or "fragment" narrows every
 * source, and the counts with it, so the sources list and a timeline agree
 * under the same lens. A withdrawn own item counts as the kind it was authored.
 *
 * Withdrawn items (own endcaps and imported tombstones) are background: every
 * lens but the Background one leaves them out, and Background shows only them,
 * so a retraction stays findable without crowding what is being read.
 */
export async function readingData(db: D1Database, requestedOffset: number, limit: number, source: string | undefined, kind?: "thread" | "fragment", background = false) {
  const [ownAll, importedAll, subs] = await Promise.all([
    db.prepare(`SELECT i.id, i.updated, ${authoredItemKindSql('p')} AS kind, i.kind = 'withdrawn' AS withdrawn
      FROM items i LEFT JOIN versions p ON i.kind = 'withdrawn' AND p.item_id = i.id AND p.version = i.version - 1
      WHERE i.status IN ('public','withdrawn') ORDER BY i.updated DESC, i.rowid DESC`).all<{ id: string; updated: string; kind: string; withdrawn: number }>(),
    db.prepare("SELECT subscription_id, remote_id, updated, observed_at, kind, state FROM imported_items ORDER BY observed_at DESC").all<{ subscription_id: string; remote_id: string; updated: string | null; observed_at: string; kind: string; state: string }>(),
    listSubscriptions(db),
  ]);
  const own = { results: ownAll.results.filter((r) => (r.withdrawn === 1) === background && (!kind || r.kind === kind)) };
  const imported = { results: importedAll.results.filter((r) => (r.state === "tombstone") === background && (!kind || r.kind === kind)) };
  const selected = source === "own" || subs.some((s) => s.id === source) ? source! : "all";
  const counts = { all: own.results.length + imported.results.length, own: own.results.length, subscriptions: Object.fromEntries(subs.map((s) => [s.id, 0])) };
  for (const row of imported.results) counts.subscriptions[row.subscription_id] = (counts.subscriptions[row.subscription_id] ?? 0) + 1;
  const identities = [
    ...own.results.map((r) => ({ source: "own" as const, id: r.id, sub: "", at: r.updated })),
    ...imported.results.map((r) => ({ source: "imported" as const, id: r.remote_id, sub: r.subscription_id, at: clampDisplayAt(r.updated, r.observed_at) })),
  ].filter((r) => selected === "all" || (selected === "own" ? r.source === "own" : r.sub === selected));
  identities.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const total = identities.length, offset = requestedOffset;
  const selectedRows = identities.slice(offset, offset + limit);
  const ownIds = selectedRows.filter((r) => r.source === "own").map((r) => r.id);
  const importedIds = selectedRows.filter((r) => r.source === "imported");
  // At most 50 ids (100 bindings for imported pairs), within D1's 100-bind limit.
  const [ownBodies, importedBodies] = await Promise.all([
    ownIds.length ? db.prepare(`SELECT i.id, i.kind, i.updated, v.content_html, previous.transclusions AS previous_transclusions, previous.kind AS previous_kind
      FROM items i LEFT JOIN versions v ON v.item_id = i.id AND v.version = i.version
      LEFT JOIN versions previous ON previous.item_id = i.id AND previous.version = i.version - 1
      WHERE i.id IN (${ownIds.map(() => "?").join(",")})`).bind(...ownIds).all<{ id: string; kind: string; updated: string; content_html: string | null; previous_transclusions: string | null; previous_kind: 'fragment' | 'thread' | 'withdrawn' | null }>() : { results: [] },
    // read_state is the owner's own (migration 0026); null means unread.
    importedIds.length ? db.prepare(`SELECT i.*, rs.read_version FROM imported_items i
      LEFT JOIN read_state rs ON rs.subscription_id = i.subscription_id AND rs.remote_id = i.remote_id
      WHERE ${importedIds.map(() => "(i.subscription_id = ? AND i.remote_id = ?)").join(" OR ")}`)
      .bind(...importedIds.flatMap((r) => [r.sub, r.id])).all<ImportedItemRow & { read_version: number | null }>() : { results: [] },
  ]);
  const ownById = new Map(ownBodies.results.map((r) => [r.id, r]));
  const importedById = new Map(importedBodies.results.map((r) => [JSON.stringify([r.subscription_id, r.remote_id]), r]));
  const entries = await Promise.all(selectedRows.map(async (identity) => {
    if (identity.source === "own") {
      const item = ownById.get(identity.id);
      if (!item) return null;
      const withdrawn = item.kind === "withdrawn";
      const kind = withdrawn ? authoredVersionKind({ kind: item.previous_kind, transclusions: item.previous_transclusions }, Boolean(item.previous_transclusions)) : item.kind === 'thread' ? 'thread' : 'fragment';
      const input: OwnEntryInput = { id: item.id, kind, withdrawn, updated: item.updated, contentHtml: withdrawn ? "" : await sanitizeHtml(item.content_html ?? "") };
      return { ...buildReadingFeed([input], [])[0], key: `own:${item.id}` };
    }
    const row = importedById.get(JSON.stringify([identity.sub, identity.id]));
    if (!row) return null;
    const sub = subs.find((s) => s.id === row.subscription_id);
    const input: ImportedEntryInput = { subscriptionId: row.subscription_id, subscriptionTitle: sub?.title || sub?.origin || row.subscription_id, remoteId: row.remote_id, sourceUrl: sub ? sourceTitleAndUrl(row, sub.origin).url : null, kind: row.kind, withdrawn: row.state === "tombstone", l0: row.l0 === 1, updated: row.updated, observedAt: row.observed_at, contentHtml: await sanitizeHtml(row.content_html), pinnedVersionRetained: row.pinned_version_retained, version: row.version, readVersion: row.read_version ?? null };
    return { ...buildReadingFeed([], [input])[0], key: `imported:${JSON.stringify([row.subscription_id, row.remote_id])}` };
  }));
  return { items: entries.filter((e) => e !== null), counts, selected, total, offset, limit };
}
