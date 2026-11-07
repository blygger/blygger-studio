/*
 * The shelf (#135): an owner-ordered list of the owner's own items, such as
 * living threads, kept at the top of the Write list and synced across clients.
 * Studio-private (migration 0044): nothing here reaches an item document, a
 * feed, the manifest, a public page or the static export.
 *
 * Rules, shared by GET and PUT:
 * - Any of this blyg's own items may be shelved: drafts (they have ids) and
 *   published items alike.
 * - A withdrawn item is omitted from GET and dropped by PUT. A discarded draft
 *   is deleted, and its shelf row with it.
 * - PUT replaces the whole list. Ids that name no own item, or a withdrawn one,
 *   are dropped quietly, and a repeated id keeps its first position; the
 *   response is the stored list, so a client sees what was kept.
 * - The list has a revision. A PUT with expectedRevision applies only when it
 *   matches; every successful PUT bumps it.
 */

export const SHELF_MAX = 50;

export interface Shelf { itemIds: string[]; revision: number }

const REVISION = 'COALESCE((SELECT revision FROM shelf_revision WHERE id = 1), 0)';

const readStatements = (db: D1Database) => [
  db.prepare(`SELECT s.item_id FROM shelf s JOIN items i ON i.id = s.item_id
    WHERE i.status != 'withdrawn' ORDER BY s.position, s.item_id`),
  db.prepare(`SELECT ${REVISION} AS revision`),
];
const shelfFrom = (rows: D1Result, revision: D1Result): Shelf => ({
  itemIds: (rows.results as { item_id: string }[]).map(row => row.item_id),
  revision: (revision.results[0] as { revision: number }).revision,
});

export async function readShelf(db: D1Database): Promise<Shelf> {
  const [rows, revision] = await db.batch(readStatements(db));
  return shelfFrom(rows, revision);
}

/** Replace the list in one transaction. Null when expectedRevision is stale. */
export async function replaceShelf(db: D1Database, itemIds: readonly string[], expectedRevision?: number): Promise<Shelf | null> {
  const ids = [...new Set(itemIds)];
  const conditional = expectedRevision !== undefined;
  const guard = conditional ? ` AND ${REVISION} = ?` : '';
  const guardBinds = conditional ? [expectedRevision] : [];
  const statements = [
    db.prepare(`DELETE FROM shelf WHERE 1${guard}`).bind(...guardBinds),
    ...ids.map((id, position) => db.prepare(`INSERT INTO shelf(item_id, position)
      SELECT ?, ? WHERE EXISTS(SELECT 1 FROM items WHERE id = ? AND status != 'withdrawn')${guard}`)
      .bind(id, position, id, ...guardBinds)),
    db.prepare(`INSERT INTO shelf_revision(id, revision) SELECT 1, ${REVISION} + 1 WHERE 1${guard}
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision`).bind(...guardBinds),
  ];
  // The read rides in the same transaction, so it is exactly what was stored.
  const results = await db.batch([...statements, ...readStatements(db)]);
  if (!results[statements.length - 1].meta.changes) return null;
  return shelfFrom(results[statements.length], results[statements.length + 1]);
}
