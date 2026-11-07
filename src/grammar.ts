// The bracket grammar, defined once (0.4 §10.1). Locked protocol surface: do
// not modify without Fable + Venkat.
//
// Two forms, one `!` apart: an own-line directive `![[id]]` that transcludes,
// and an inline link `[[id]]` that does not. From 0.4 either may carry a
// **label** after the id (decision #70): `[[id | text]]`, `![[id | text]]`.
// The id is positional — the 26 characters right after the brackets — so the
// first pipe after it separates, and everything from there to `]]` is the
// label, pipes included. Whitespace around the pipe is optional and trimmed; an
// empty label is no label; there is no escape, so a label cannot contain `]]`.
// Resolution ignores the label: on a link it is the anchor text, on a
// directive the author's name for the quoted item, baked as `data-blyg-label`
// (decision #81) and used only as an attribution anchor, never as a title.
//
// Every site that reads the grammar builds its pattern from here, so the label
// cannot be honoured in one place and silently missed in another.

import { ID_ALPHABET } from "./identity.ts";

/** A 26-character item id, uncaptured. */
export const ID = `[${ID_ALPHABET}]{26}`;

/** The optional label after an id, captured without its pipe: anything on the line up to `]]`. */
const LABEL = `(?:[ \\t]*\\|((?:(?!\\]\\])[^\\n])*))?`;

/** `[[id]]` or `[[id | label]]`'s inside: id in group 1, raw label in group 2. */
const BODY = `(${ID})${LABEL}\\]\\]`;

/** A whole line that is a transclusion directive: id in group 1, raw label in group 2. */
export const DIRECTIVE_LINE = new RegExp(`^\\s*!\\[\\[${BODY}\\s*$`);

/** `![[id@vN]]`, reserved (§10.1): rejected at publish, tolerated on read. */
export const RESERVED_LINE = new RegExp(`^\\s*!\\[\\[(${ID})@v\\d+\\]\\]\\s*$`);

/**
 * An inline plain link. The negative lookbehind is what keeps it apart from
 * the directive. Global: callers use `matchAll`/`replace`; a fresh copy from
 * `linkInline()` avoids sharing `lastIndex` between callers that use `exec`.
 */
export const LINK_INLINE = new RegExp(`(?<!!)\\[\\[${BODY}`, "g");
export const linkInline = () => new RegExp(LINK_INLINE.source, "g");

/** A directive anywhere in a line (TK source refs): id in group 1, raw label in group 2. */
export const directiveInline = () => new RegExp(`!\\[\\[${BODY}`, "g");

/**
 * A directive alone on its line, multiline (TK output): id in group 1, raw label in group 2.
 * `[^\S\n]` is `DIRECTIVE_LINE`'s `\s` less the newline that ends a line, so
 * every line publish transcludes is one this finds (decision #60).
 */
export const directiveOwnLine = () => new RegExp(`^[^\\S\\n]*!\\[\\[${BODY}[^\\S\\n]*$`, "gm");

/** The label a match carries, trimmed; undefined when absent or empty. */
export function label(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  return text ? text : undefined;
}

/**
 * Text made safe to write as a label: one line, no `]]` (the grammar has no
 * escape, so §10.1 says a label that would contain one is rewritten). Every
 * `]` followed by another, or by the `]]` that will close the link, takes a
 * space after it; one pass over `]]` would leave `a]]]b` reading `a] ]]`.
 */
export function labelText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\](?=\]|$)/g, "] ");
}

/**
 * Generated text with the bracket grammar taken out (ROADMAP row 67; v0.4-plan
 * §11.4): generated output is not grammar (studio#5), so a model that echoes
 * `[[id]]` or an inline `![[id]]` from its context would publish literal
 * brackets. Each inline form becomes its label, or nothing. A directive alone
 * on its own line stays: decision #60 makes that a real quote, which publish
 * warns about when the instruction did not ask for it.
 */
export function stripGeneratedGrammar(text: string): string {
  const inline = new RegExp(`!?\\[\\[${BODY}`, "g");
  return text
    .split("\n")
    .map((line) => {
      if (DIRECTIVE_LINE.test(line)) return line;
      const stripped = line.replace(inline, (_whole, _id: string, raw?: string) => label(raw) ?? "");
      if (stripped === line) return line;
      return stripped.replace(/[ \t]{2,}/g, " ").replace(/ +([.,;:!?)])/g, "$1").replace(/\( +/g, "(").trimEnd();
    })
    .join("\n");
}

/** `[[id]]` or `[[id | label]]`, the form an author types. */
export function linkSource(id: string, text?: string): string {
  const l = text === undefined ? "" : labelText(text);
  return l ? `[[${id} | ${l}]]` : `[[${id}]]`;
}
