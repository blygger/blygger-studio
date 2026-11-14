import MarkdownIt from "markdown-it";
import { graphemePrefix } from "./text.ts";
import { mathErrors as findMathErrors, mathPlugin } from "./math.ts";

// Safe mode: raw HTML in markdown is escaped, never passed through (§3).
const md = new MarkdownIt({ html: false, linkify: true, typographer: false }).use(mathPlugin);

// Image alt text from every text-bearing child (studio#6). markdown-it 14
// emits an escape (`\*`) or an entity as a `text_special` token, and the
// default image rule's renderInlineAsText keeps only `text`, so `![a \* b](…)`
// got `alt="a  b"` while the same words outside an image read `a * b`.
type InlineToken = { type: string; content: string; children: InlineToken[] | null };
function altText(children: InlineToken[]): string {
  return children
    .map((t) =>
      t.type === "text" || t.type === "text_special" || t.type === "code_inline"
        ? t.content
        : t.type === "image"
          ? altText(t.children ?? [])
          : t.type === "softbreak" || t.type === "hardbreak"
            ? "\n"
            : "",
    )
    .join("");
}
md.renderer.rules.image = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  token.attrSet("alt", altText((token.children ?? []) as unknown as InlineToken[]));
  return self.renderToken(tokens, idx, options);
};

export function renderMarkdown(contentMd: string): string {
  return md.render(contentMd);
}

/** Formulas in `contentMd` that do not parse (#105): publish refuses them. */
export function mathErrors(contentMd: string) {
  return findMathErrors(md, contentMd);
}

/**
 * A formula as presentation text: its TeX in dollars, from the annotation the
 * renderer keeps (§5.2). For excerpts, titles and labels only, where stripped
 * MathML would be a run of symbols. Never for the §2 text content, which has no
 * exception for a formula: `selectionText` strips tags and nothing else.
 */
function mathAsTex(html: string): string {
  if (!html.includes("<math")) return html;
  return replaceElements(html, ["math"], true, (_, open, inner, whole) => {
    const at = inner.indexOf('<annotation encoding="application/x-tex">');
    const end = at < 0 ? -1 : inner.indexOf("</annotation>", at);
    if (end < 0) return whole;
    const tex = inner.slice(at + '<annotation encoding="application/x-tex">'.length, end);
    const mark = /display="block"/.test(open) ? "$$" : "$";
    return ` ${mark}${tex.trim()}${mark} `;
  });
}

/**
 * Each `<name …>…</name>` in `html`, left to right, handed to `replace`; found
 * with indexOf and never with a lazy regex, which on hostile HTML (an opener
 * repeated with no closer) scans to the end once per opener: 0.7 s at 160 KB,
 * on the import and excerpt paths (Fable's review of studio#149, R3). Matches
 * what `/<(a|b)[^>]*>[\s\S]*?<\/\1>/gi` matched, `\b` after the name if
 * `bounded`: an opener with no closer is left alone, and so is every later
 * opener of that name, which cannot have one either.
 */
function replaceElements(html: string, names: string[], bounded: boolean, replace: (name: string, open: string, inner: string, whole: string) => string): string {
  const lower = html.toLowerCase();
  const live = new Set(names);
  let out = "";
  let from = 0;
  let pos = 0;
  while (live.size) {
    let at = -1;
    let name = "";
    for (const candidate of live) {
      let i = lower.indexOf(`<${candidate}`, pos);
      while (bounded && i >= 0 && /[a-z0-9_]/.test(lower[i + candidate.length + 1] ?? "")) i = lower.indexOf(`<${candidate}`, i + 1);
      if (i < 0) { live.delete(candidate); continue; }
      if (at < 0 || i < at) { at = i; name = candidate; }
    }
    if (at < 0) break;
    const openEnd = lower.indexOf(">", at);
    if (openEnd < 0) break;
    const close = lower.indexOf(`</${name}>`, openEnd + 1);
    if (close < 0) { live.delete(name); pos = at + 1; continue; }
    const end = close + name.length + 3;
    out += html.slice(from, at) + replace(name, html.slice(at, openEnd + 1), html.slice(openEnd + 1, close), html.slice(at, end));
    from = pos = end;
  }
  return out + html.slice(from);
}
const withoutScripts = (html: string) => replaceElements(html, ["script", "style"], false, () => " ");

/** Plain text of rendered markdown, for feed titles and excerpts. */
export function plainText(contentMd: string): string {
  const html = mathAsTex(md.render(contentMd));
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** First ~n chars of plain text, ellipsized. */
export function excerpt(contentMd: string, n = 60): string {
  const text = plainText(contentMd);
  return text.length <= n ? text : graphemePrefix(text, n).trimEnd() + "…";
}

const BLOCK_BOUNDARY = /<\/(?:p|h[1-6]|li|blockquote|pre|div|tr|section|article)>|<br\s*\/?>/gi;

/** Decode the entities our renderer and feed pipeline actually emit. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&"); // last, so "&amp;lt;" survives as the text "&lt;"
}

/**
 * Plain text from already-rendered HTML — used for thread content (which
 * stores baked content_html rather than independently re-renderable
 * markdown), for feed/page excerpts, and for studio list previews.
 *
 * The single implementation on purpose: a private copy in preview.ts is the
 * duplicated-detector drift that bit resolve.ts vs feed.ts in session 16.
 * Block ends become spaces so "…evil.</p><p>Next…" does not weld into
 * "evil.Next" — a real defect in the previous tag-strip-only version.
 */
export function plainTextFromHtml(html: string): string {
  return decodeEntities(
    withoutScripts(mathAsTex(html))
      .replace(BLOCK_BOUNDARY, " ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The **selection normalizer** for partial transclusion (spec §10.1–§10.3, decision
 * #49, plan §7.3 P2). Written once and exported, because the publish-time check
 * and any read-side re-check MUST agree exactly: two normalizers that differ by
 * one space are a construct that verifies on one node and fails on another.
 *
 * Same tag-stripping as `plainTextFromHtml`, one difference: a block boundary
 * becomes a **line break** rather than a space, so the shape of the target's
 * blocks survives into the string being searched. That is what lets a quote
 * spanning two paragraphs match — it is a line break on both sides — while a
 * quote that welds the end of one paragraph to the start of the next does not.
 *
 * Whitespace *within* a block collapses to single spaces, including the raw
 * newlines a markdown renderer leaves inside a `<p>` when the author soft-wrapped
 * their source. That is the subtle half: splitting the HTML on literal newlines
 * would make the match depend on where the *author* happened to press return,
 * which is not a property of the text at all. Hence the sentinel — boundaries
 * are marked before any whitespace collapsing, so only they survive as breaks.
 *
 * Empty segments are dropped, so `<p>a</p><p></p><p>b</p>` normalizes the same
 * as `<p>a</p><p>b</p>`.
 */
const BLOCK_SEP = "\u0000";

/** The line rule, shared by both entry points so they cannot drift apart. */
function normalizeBlocks(segments: string[]): string {
  return segments
    .map((seg) => seg.replace(/\s+/g, " ").trim())
    .filter((seg) => seg !== "")
    .join("\n");
}

export function selectionText(html: string): string {
  return normalizeBlocks(
    decodeEntities(
      withoutScripts(html)
        .replace(BLOCK_BOUNDARY, BLOCK_SEP)
        .replace(/<[^>]+>/g, ""),
    ).split(BLOCK_SEP),
  );
}

/**
 * The same rule applied to text that is already text — a browser selection,
 * where `Selection.toString()` has already put a newline at each block
 * boundary. Studio-side only: it is how the stub editor's passage chooser
 * turns what the author highlighted into the string `selectionText` will later
 * have to match.
 *
 * Separate entry point rather than a second implementation, because the two
 * *must* agree: this produces the quote, that checks it at publish, and a
 * disagreement between them would be an affordance that reliably produces
 * unpublishable drafts.
 */
/**
 * Whether a selection found in `html`'s text content takes in any part of a
 * formula (#105). The §2 text of a formula is what stripping its tags leaves,
 * which no reader would choose as a quote, so the studio refuses one rather
 * than bake it: the selection is in the text, and is not once every formula is
 * cut out.
 */
export function selectionTouchesMath(html: string, selection: string): boolean {
  if (!html.includes("<math")) return false;
  const holed = selectionText(replaceElements(html, ["math"], true, () => "\uFFFC"));
  return selectionText(html).includes(selection) && !holed.includes(selection);
}

export function normalizeSelection(text: string): string {
  return normalizeBlocks(text.split("\n"));
}

/**
 * A normalized selection as an attached markdown blockquote: `>` on every
 * line, a bare `>` between blocks, so it renders back to the same blocks.
 * Shared by the stub API and the stub editor's passage chooser.
 */
export function quoteLines(selection: string): string {
  return selection
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n>\n");
}

/** First ~n chars of already-rendered HTML's plain text, ellipsized. */
export function excerptFromHtml(html: string, n = 60): string {
  const text = plainTextFromHtml(html);
  return text.length <= n ? text : graphemePrefix(text, n).trimEnd() + "…";
}
