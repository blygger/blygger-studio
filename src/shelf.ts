/*
 * The shelf (#135): an owner-ordered list of items, such as living threads and
 * other blygs' posts worth keeping at hand, synced across clients. Studio-private
 * (migration 0044): nothing here reaches an item document, a feed, the manifest,
 * a public page or the static export.
 *
 * An entry names an item the way hopper membership does: { sub, remoteId }, with
 * sub OWN_SUBSCRIPTION ("~own") and remoteId the item id for one of the owner's
 * own items, else a subscription id and the imported item's remote id. A bare
 * id could not tell two origins apart.
 *
 * Rules, shared by GET and PUT:
 * - Any of this blyg's own items may be shelved: drafts (they have ids) and
 *   published items alike. Any imported item held under a subscription may be.
 * - An entry must resolve: an own item that is not withdrawn, or an imported
 *   item that is current or a tombstone with a retained pin (resolveTarget's
 *   rule). One that does not is omitted from GET and dropped by PUT. A discarded
 *   draft, an imported item no longer held, and every entry of a subscription
 *   that is deleted leave the shelf with their rows.
 * - PUT replaces the whole list. Entries that do not resolve, including any
 *   whose sub names no subscription, are dropped quietly, never refused, and a
 *   repeated entry keeps its first position; the response is the stored list,
 *   so a client sees what was kept.
 * - The list has a revision. A PUT must send expectedRevision and applies only
 *   when it matches; every successful PUT bumps it. There is no unconditional
 *   replace: the shelf exists for several clients, where one would undo another.
 * - Private for good: the shelf never gains a public mode. A featured list on
 *   public pages would be its own presentation setting, not a flag here.
 */
import { OWN_SUBSCRIPTION } from './own-subscription.ts';

export const SHELF_MAX = 50;

export interface ShelfEntry { sub: string; remoteId: string }
export interface Shelf { entries: ShelfEntry[]; revision: number }

const REVISION = 'COALESCE((SELECT revision FROM shelf_revision WHERE id = 1), 0)';
// Whether (subscription_id, remote_id) — bound as ?1, ?2 — names an item that resolves.
const RESOLVES = `((?1 = '${OWN_SUBSCRIPTION}' AND EXISTS(SELECT 1 FROM items WHERE id = ?2 AND status != 'withdrawn'))
  OR (?1 != '${OWN_SUBSCRIPTION}' AND EXISTS(SELECT 1 FROM imported_items WHERE subscription_id = ?1 AND remote_id = ?2
    AND (state = 'current' OR pinned_version_retained IS NOT NULL))))`;

const readStatements = (db: D1Database) => [
  db.prepare(`SELECT s.subscription_id, s.remote_id FROM shelf s
    LEFT JOIN items i ON s.subscription_id = '${OWN_SUBSCRIPTION}' AND i.id = s.remote_id
    LEFT JOIN imported_items m ON s.subscription_id != '${OWN_SUBSCRIPTION}' AND m.subscription_id = s.subscription_id AND m.remote_id = s.remote_id
    WHERE (i.id IS NOT NULL AND i.status != 'withdrawn') OR (m.remote_id IS NOT NULL AND (m.state = 'current' OR m.pinned_version_retained IS NOT NULL))
    ORDER BY s.position, s.subscription_id, s.remote_id`),
  db.prepare(`SELECT ${REVISION} AS revision`),
];
const shelfFrom = (rows: D1Result, revision: D1Result): Shelf => ({
  entries: (rows.results as { subscription_id: string; remote_id: string }[]).map(row => ({ sub: row.subscription_id, remoteId: row.remote_id })),
  revision: (revision.results[0] as { revision: number }).revision,
});

export async function readShelf(db: D1Database): Promise<Shelf> {
  const [rows, revision] = await db.batch(readStatements(db));
  return shelfFrom(rows, revision);
}

/** First position wins for a repeated entry. */
function unique(entries: readonly ShelfEntry[]): ShelfEntry[] {
  const seen = new Set<string>();
  return entries.filter(({ sub, remoteId }) => {
    const key = JSON.stringify([sub, remoteId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Replace the list in one transaction. Null when expectedRevision is stale. */
export async function replaceShelf(db: D1Database, entries: readonly ShelfEntry[], expectedRevision: number): Promise<Shelf | null> {
  const guard = ` AND ${REVISION} = ?3`;
  const statements = [
    db.prepare(`DELETE FROM shelf WHERE 1 AND ${REVISION} = ?`).bind(expectedRevision),
    ...unique(entries).map(({ sub, remoteId }, position) => db.prepare(`INSERT INTO shelf(subscription_id, remote_id, position)
      SELECT ?1, ?2, ?4 WHERE ${RESOLVES}${guard}`).bind(sub, remoteId, expectedRevision, position)),
    db.prepare(`INSERT INTO shelf_revision(id, revision) SELECT 1, ${REVISION} + 1 WHERE 1 AND ${REVISION} = ?
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision`).bind(expectedRevision),
  ];
  // The read rides in the same transaction, so it is exactly what was stored.
  const results = await db.batch([...statements, ...readStatements(db)]);
  if (!results[statements.length - 1].meta.changes) return null;
  return shelfFrom(results[statements.length], results[statements.length + 1]);
}
