import { nowIso } from './util.ts';
import type { ItemRow } from './types.ts';

export class ItemRevisionConflict extends Error {
  constructor(readonly itemId: string, readonly expectedRevision: number) {
    super('item revision conflict; reload and try again');
  }
}

export function assertItemRevision(item: Pick<ItemRow, 'id' | 'revision'>, expectedRevision: number) {
  if (item.revision !== expectedRevision) throw new ItemRevisionConflict(item.id, expectedRevision);
}

/** Install text and its positional provenance as one conditional transition. */
export async function installWorkingCopy(db: D1Database, item: ItemRow, text: string, provenance: string | null) {
  const result = await db.prepare(`UPDATE items SET content_md = ?, tk_provenance_json = ?, dirty = 1,
    updated = CASE WHEN version = 0 THEN ? ELSE updated END, revision = revision + 1
    WHERE id = ? AND revision = ?`).bind(text, provenance, nowIso(), item.id, item.revision).run();
  if (!result.meta.changes) throw new ItemRevisionConflict(item.id, item.revision);
  return item.revision + 1;
}

/** Recheck a captured premise after remote work that does not install item state. */
export async function assertCurrentRevision(db: D1Database, item: Pick<ItemRow, 'id' | 'revision'>) {
  const current = await db.prepare('SELECT revision FROM items WHERE id = ?').bind(item.id).first<{ revision: number }>();
  if (!current || current.revision !== item.revision) throw new ItemRevisionConflict(item.id, item.revision);
}
