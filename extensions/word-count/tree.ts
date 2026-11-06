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
// The roll-up is conservative about shape, not about state. It is given only
// when the outline links from the root form a strict tree of our own items. A
// cycle, an item listed twice (under one parent or two), a link to anything
// that is not one of our items (remote, withdrawn, gone), or a tree past the
// size limit, and there is no total.
//
// Every item has two sides, counted and rolled up separately:
//   published  its current published version, as readers and the reading view
//              see it; none for an item never published.
//   draft      its working copy, rendered as the Studio's preview renders it,
//              so quotes count as publish would bake them now. A working copy
//              identical to the published version is that version.
// Each side's tree follows that side's outline, so a contents thread being
// reorganised in draft rolls up its draft outline.

import { codeRanges, inRanges } from "../../src/code-ranges.ts";
import { annotateTkPreview } from "../../src/authoring.ts";
import { withoutComments } from "../../src/comments.ts";
import { LINK_INLINE } from "../../src/grammar.ts";
import { applyInternalLinks, previewInternalLinks, previewTransclusions, resolveBlockLinks } from "../../src/transclusion.ts";
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

/** One of our own items, as the roll-up needs it. */
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
 * per tree level); an id it leaves out is not one of our items.
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

/** The placeholder a preview shows for a quote it cannot resolve: not the author's words. */
const UNRESOLVED = /<blockquote class="blyg-transclusion unresolved">[\s\S]*?<\/blockquote>/g;

/**
 * A working copy as the HTML publish would bake from it now: the same steps
 * as the Studio's thread preview (read-api.ts threadPreview), so a draft's
 * count is the count it would publish with.
 */
export async function draftHtml(db: D1Database, ourOrigin: string, id: string, contentMd: string): Promise<string> {
  const tk = annotateTkPreview(contentMd);
  const links = await previewInternalLinks(db, tk.text, ourOrigin);
  const blocks = await resolveBlockLinks(tk, (md) => previewInternalLinks(db, md, ourOrigin));
  const resolved = await previewTransclusions(db, links.text, id, tk);
  return [links, ...blocks.docs].reduce((acc, doc) => applyInternalLinks(acc, doc), tk.finish(resolved.html)).replace(UNRESOLVED, " ");
}

/** Both sides of one of our items. */
export interface ItemSides {
  published: CountedItem | null;
  draft: CountedItem;
}

/** D1 binds at most 100 parameters per statement. */
const CHUNK = 90;

/** Our own items by id, published or draft, not withdrawn, with both sides counted and outlined. */
export async function loadItems(db: D1Database, ourOrigin: string, ids: string[]): Promise<Map<string, ItemSides>> {
  const out = new Map<string, ItemSides>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(
        `SELECT i.id, i.content_md AS working_md, v.content_md, v.content_html FROM items i LEFT JOIN versions v ON v.item_id = i.id AND v.version = i.version
         WHERE i.id IN (${chunk.map(() => "?").join(",")}) AND i.kind != 'withdrawn' AND (v.kind IS NULL OR v.kind != 'withdrawn')`,
      )
      .bind(...chunk)
      .all<{ id: string; working_md: string; content_md: string | null; content_html: string | null }>();
    for (const row of results) {
      const published = row.content_md === null ? null : { count: countWords(row.content_html ?? ""), children: outlineLinks(row.content_md) };
      const draft = published && row.working_md === row.content_md ? published : { count: countWords(await draftHtml(db, ourOrigin, row.id, row.working_md)), children: outlineLinks(withoutComments(row.working_md)) };
      out.set(row.id, { published, draft });
    }
  }
  return out;
}
