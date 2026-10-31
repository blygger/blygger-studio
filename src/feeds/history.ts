import type { Transclusion } from "../types.ts";
import type { FeedHistory, FeedHistoryItem } from "./types.ts";
import { authoredItemKindSql } from '../version-state.ts';

/**
 * A blyg's own publishing history, in the shape a subscriber would assemble
 * from its public files: every published version (endcaps excluded) with its
 * time, note, pin flag and own-origin quotes. Two queries regardless of size.
 */
export async function loadFeedHistory(db: D1Database): Promise<FeedHistory> {
  const [items, versions] = await db.batch([
    db.prepare(`SELECT i.id, ${authoredItemKindSql('p')} AS kind, i.status FROM items i
      LEFT JOIN versions p ON p.item_id = i.id AND p.version = i.version - 1
      WHERE i.status IN ('public','withdrawn') ORDER BY i.rowid`),
    db.prepare(`SELECT v.item_id, v.version, v.published_at, v.note, v.pinned, v.transclusions FROM versions v
      JOIN items i ON i.id = v.item_id WHERE i.status IN ('public','withdrawn') AND (v.kind IN ('fragment','thread') OR (v.kind IS NULL AND v.content_md != '')) ORDER BY v.item_id, v.version`),
  ]);
  const byId = new Map<string, FeedHistoryItem>();
  for (const row of items.results as { id: string; kind: string; status: string }[]) {
    byId.set(row.id, { id: row.id, kind: row.kind === "thread" ? "thread" : "fragment", withdrawn: row.status === "withdrawn", versions: [] });
  }
  for (const row of versions.results as { item_id: string; version: number; published_at: string; note: string | null; pinned: number; transclusions: string | null }[]) {
    byId.get(row.item_id)?.versions.push({ version: row.version, at: row.published_at, note: row.note, pinned: row.pinned === 1, quotes: ownQuotes(row.transclusions) });
  }
  return { items: [...byId.values()] };
}

function ownQuotes(json: string | null): string[] {
  if (!json) return [];
  try {
    const entries = JSON.parse(json) as Transclusion[];
    return [...new Set(entries.filter((t) => !t.origin).map((t) => t.id))];
  } catch {
    return [];
  }
}
