/*
 * An item as plain text, for pasting into another app (⧉ copy + link, share…).
 * Pure: the caller supplies what it knows about other items through `resolve`.
 *
 *  - markdown syntax goes: the text is rendered and read back, so emphasis,
 *    links, headings and escapes come out as their words;
 *  - a quote — `![[id]]`, with or without its `>` passage, or an ordinary
 *    markdown blockquote — becomes “…”;
 *  - generated text stays (TK output and `impyrt` text alike); a scope with
 *    no output yet contributes nothing;
 *  - `[[id]]` becomes the linked item's text, or its id when unknown.
 */
import { DIRECTIVE_LINE, label, linkInline } from '../grammar.ts';
import { renderMarkdown, selectionText } from '../markdown.ts';
import { codeRanges, inRanges, lineOffsets } from '../code-ranges.ts';
import { parseScopes } from '../tk.ts';
import { withoutComments } from '../comments.ts';
import { leadingHeading, previewFromHtml } from '../preview.ts';
import { attachedQuote, extractDirectives } from '../directives.ts';

/** What the caller knows of item `id`: its text for a quote, its name for a link. */
export type Resolve = (id: string, form: 'quote' | 'link') => string | undefined;

const LINK = linkInline();

/** Every TK scope replaced by its output (nothing, if it has none yet). */
function withOutputs(source: string) {
  // A clean row's working copy stands in for its published words (publishedOf),
  // so this is the guard that keeps a note out of what gets copied and shared.
  const md = withoutComments(source);
  let text = '';
  let last = 0;
  for (const scope of parseScopes(md).scopes) {
    text += md.slice(last, scope.start) + (scope.output ?? '');
    last = scope.end;
  }
  return text + md.slice(last);
}

const curly = (text: string) => `“${text.replace(/\s*\n\s*/g, ' ').trim()}”`;

/** Paragraphs of rendered prose, blockquotes as “…”. */
function prose(md: string, resolve: Resolve): string[] {
  // A link reads as its author's label when it has one (§10.1, #70), as it does on the page.
  const linked = md.replace(LINK, (_, id: string, raw?: string) => label(raw) || resolve(id, 'link') || id);
  const html = renderMarkdown(linked).replace(
    /<blockquote>([\s\S]*?)<\/blockquote>/g,
    (_, inner: string) => `<p>${curly(selectionText(inner))}</p>`,
  );
  return selectionText(html).split('\n').filter((line) => line.trim());
}

export function plainText(md: string, resolve: Resolve = () => undefined): string {
  const text = withOutputs(md);
  const lines = text.split('\n');
  const starts = lineOffsets(lines);
  const code = codeRanges(text);
  const out: string[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.join('').trim()) out.push(...prose(pending.join('\n'), resolve));
    pending = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const directive = inRanges(code, starts[i]) ? null : DIRECTIVE_LINE.exec(lines[i]);
    if (!directive) {
      pending.push(lines[i]);
      continue;
    }
    flush();
    // The passage publish would select (§10.1: CommonMark's extent, lazy lines included).
    const { quoteMd, next } = attachedQuote(lines, i);
    i = next - 1;
    const quoted = quoteMd !== null
      ? selectionText(renderMarkdown(quoteMd))
      : (resolve(directive[1], 'quote') ?? '');
    if (quoted.trim()) out.push(curly(quoted));
  }
  flush();
  return out.join('\n\n');
}

/** A one-line name for an item: its heading, else the start of its text. */
export function itemTitle(md: string): string {
  const html = renderMarkdown(withOutputs(extractDirectives(withoutComments(md)).withoutDirectives));
  const { title } = leadingHeading(html);
  return title || previewFromHtml(html, 80).body;
}

/** Text, a blank line, then the permalink: what ⧉ copy + link puts on the clipboard. */
export function textWithLink(text: string, url: string) {
  return text ? `${text}\n\n${url}` : url;
}

/** The public address of an item, from the blyg's base URL (ending in "/"). */
export function permalink(base: string, kind: string, id: string) {
  const root = base.endsWith('/') ? base : `${base}/`;
  return `${root}${kind === 'thread' ? 't' : 'f'}/${id}/`;
}
