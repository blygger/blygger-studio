// Speculative authoring: placeholders (studio-only; no wire change).
//
// Writing top-down, the author types `[[some text]]` for an item they mean to
// write later. The studio creates that item at once, as an unpublished
// fragment draft marked with the text it was named by (migration 0039,
// `items.placeholder_label`), and rewrites the brackets in place to
// `[[id | some text]]` — the label grammar of decision #70 — so the author
// always sees the id. Minting happens only for contents that are not
// id-shaped: under the label grammar a mistyped id would otherwise quietly
// mint an item.
//
// An item is an **open** placeholder while it carries a label and has never
// been published (`version = 0`). The label stays on the row after publish, so
// the studio can still say where an item came from, but nothing treats a
// published item as a placeholder. No public surface reads the column.
//
// Publish handles a link to an open placeholder by writing its label as plain
// text (`placeholderLinksToText` in transclusion.ts); any other link to an
// unpublished or unknown id stays a publish error (decision #32).

import { placeholderLabel } from "./placeholder-label.ts";
import type { ItemRow } from "./types.ts";
import { newId, nowIso } from "./util.ts";

export { PLACEHOLDER_LABEL_MAX, placeholderLabel } from "./placeholder-label.ts";

/**
 * Create a placeholder: an empty fragment draft carrying its label. Empty on
 * purpose: the item is *not yet written*, and an empty draft says so honestly
 * everywhere it appears, whereas the label as its text would publish as a
 * one-line fragment repeating the link that names it if the author published
 * it untouched. The label lives in the marker, which every studio view shows.
 */
export async function createPlaceholder(db: D1Database, text: string): Promise<ItemRow> {
  const label = placeholderLabel(text);
  if (!label) throw new Error("a placeholder needs a label");
  const id = newId();
  const now = nowIso();
  await db
    .prepare("INSERT INTO items (id, kind, status, created, updated, version, content_md, dirty, placeholder_label) VALUES (?, 'fragment', 'draft', ?, ?, 0, '', 1, ?)")
    .bind(id, now, now, label)
    .run();
  return (await db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<ItemRow>())!;
}

/** The label of `id` if it is one of our open placeholders, else null. */
export async function openPlaceholderLabel(db: D1Database, id: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT placeholder_label FROM items WHERE id = ? AND version = 0 AND placeholder_label IS NOT NULL")
    .bind(id)
    .first<{ placeholder_label: string }>();
  return row?.placeholder_label ?? null;
}

/**
 * A label as markdown that renders to exactly its text: every character
 * markdown could read as syntax is backslash-escaped (CommonMark lets any
 * ASCII punctuation be escaped), and a label at the start of a line cannot
 * open a list or a heading.
 */
export function markdownLiteral(text: string): string {
  return text.replace(/[\\`*_[\]<>~|&!#]/g, "\\$&").replace(/^([-+=]|\d+(?=[.)]))/, (m) => (/\d/.test(m) ? `${m}\\` : `\\${m}`));
}
