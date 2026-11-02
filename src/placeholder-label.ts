import { labelText } from "./grammar.ts";

/** The longest label a placeholder is created with; a placeholder names an item, it is not one. */
export const PLACEHOLDER_LABEL_MAX = 200;

/**
 * A placeholder's label made safe for both places it goes: a link label (one
 * line, no `]]`, via the grammar's own `labelText`) and the item's marker.
 * Empty when nothing usable is left, which callers refuse. Shared by the
 * Worker and the editor, so the label the editor writes into `[[id | …]]` is
 * exactly the one stored.
 */
export function placeholderLabel(text: string): string {
  return labelText(text).slice(0, PLACEHOLDER_LABEL_MAX).trim();
}
