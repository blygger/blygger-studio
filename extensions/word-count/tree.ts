// An item's document tree, and its words rolled up over it. Studio furniture:
// nothing here reaches the wire.
//
// The tree follows **outline links** only: a list item that is nothing but a
// `[[id]]` or `[[id | label]]` link, as a table of contents is written. Inline
// links are never followed. They are how navigation ("← Previous · Contents ·
// Next →") and citations are written, and a graph that includes them joins
// every section of a book to every other, so it has no shape to roll up.
// Transclusions are not followed either: their snapshot is already in the
// published HTML, so it is already in the item's own count.
//
// The roll-up is conservative. It is given only when the outline links from the
// root form a strict tree of our own published items. A cycle, an item listed
// twice (under one parent or two), a link to anything not held here as one of
// our published items, or a tree past the size limit, and there is no total.
// Each item counts its current published version, as the reading view shows it.

import { codeRanges, inRanges } from "../../src/code-ranges.ts";
import { LINK_INLINE } from "../../src/grammar.ts";
import { countWords, type Count } from "./count.ts";

/** Items in one tree before the roll-up gives up. A book is far smaller. */
export const MAX_TREE_ITEMS = 500;

/** A list item, bullet or numbered, holding one internal link and nothing else: id in group 1. */
const OUTLINE_LINK = new RegExp(`^[ \\t]*(?:[-*+]|\\d{1,9}[.)])[ \\t]+${LINK_INLINE.source}[ \\t]*$`, "gm");

/** The ids an item's markdown lists as outline links, in order, repeats kept. Inert inside code (§10.1). */
export function outlineLinks(contentMd: string): string[] {
  const code = codeRanges(contentMd);
  const ids: string[] = [];
  for (const m of contentMd.matchAll(OUTLINE_LINK)) {
    if (!inRanges(code, (m.index ?? 0) + m[0].indexOf("[["))) ids.push(m[1]);
  }
  return ids;
}

/** One of our own published items, as the roll-up needs it. */
export interface CountedItem {
  count: Count;
  children: string[];
}

/** Why there is no total. */
export type NoTotal = "cycle" | "repeated" | "unavailable" | "too-large";

export interface DocumentCount extends Count {
  /** Items in the tree, the root included. */
  items: number;
}

export type Rollup = { document: DocumentCount } | { document: null; reason: NoTotal };

/**
 * The roll-up over `root`'s outline tree. `load` fetches items by id (one call
 * per tree level); an id it leaves out is not one of our published items.
 * Items already loaded are kept in `cache`, so one request can share them.
 */
export async function rollup(rootId: string, load: (ids: string[]) => Promise<Map<string, CountedItem>>, cache = new Map<string, CountedItem | null>()): Promise<Rollup> {
  const fetch = async (ids: string[]) => {
    const missing = [...new Set(ids.filter((id) => !cache.has(id)))];
    if (missing.length) {
      const got = await load(missing);
      for (const id of missing) cache.set(id, got.get(id) ?? null);
    }
  };
  await fetch([rootId]);
  const root = cache.get(rootId);
  if (!root) return { document: null, reason: "unavailable" };

  // Breadth first, carrying each item's ancestors so a cycle is told apart
  // from an item that is merely listed twice.
  const placed = new Set([rootId]);
  const total = { ...root.count, items: 1 };
  let level: { id: string; ancestors: Set<string> }[] = [{ id: rootId, ancestors: new Set() }];
  while (level.length) {
    const edges = level.flatMap(({ id, ancestors }) => {
      const path = new Set(ancestors).add(id);
      return cache.get(id)!.children.map((child) => ({ id: child, ancestors: path }));
    });
    for (const edge of edges) {
      if (edge.ancestors.has(edge.id)) return { document: null, reason: "cycle" };
      if (placed.has(edge.id)) return { document: null, reason: "repeated" };
      placed.add(edge.id);
    }
    if (placed.size > MAX_TREE_ITEMS) return { document: null, reason: "too-large" };
    await fetch(edges.map((edge) => edge.id));
    for (const edge of edges) {
      const item = cache.get(edge.id);
      if (!item) return { document: null, reason: "unavailable" };
      total.words += item.count.words;
      total.cjk += item.count.cjk;
      total.items += 1;
    }
    level = edges;
  }
  return { document: total };
}

/** D1 binds at most 100 parameters per statement. */
const CHUNK = 90;

/** Our own published, not withdrawn, items by id: each one's current version, counted and outlined. */
export async function loadItems(db: D1Database, ids: string[]): Promise<Map<string, CountedItem>> {
  const out = new Map<string, CountedItem>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(
        `SELECT i.id, v.content_md, v.content_html FROM items i JOIN versions v ON v.item_id = i.id AND v.version = i.version
         WHERE i.id IN (${chunk.map(() => "?").join(",")}) AND i.version > 0 AND i.kind != 'withdrawn' AND (v.kind IS NULL OR v.kind != 'withdrawn')`,
      )
      .bind(...chunk)
      .all<{ id: string; content_md: string; content_html: string }>();
    for (const row of results) out.set(row.id, { count: countWords(row.content_html), children: outlineLinks(row.content_md) });
  }
  return out;
}
