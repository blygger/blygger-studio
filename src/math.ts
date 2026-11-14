// Mathematics in markdown (decision #105, spec 0.4 §5.2): pandoc's
// `tex_math_dollars`, the received convention (#71). `$…$` is inline: the
// opening `$` has a non-space character right after it, the closing `$` a
// non-space character right before it and no digit right after it, so "$5 and
// $10" stays prose. `$$…$$` is displayed. `\$` is a dollar sign, by markdown's
// own escape, which runs first. Inside code spans and blocks nothing here runs:
// markdown-it hands those to its code rules before this one sees a `$`.
//
// This module only finds formulas. Drawing one is `renderTex` in
// math-render.ts, which the Worker resolves to temml and the browser bundle to
// a stub (scripts/build-spa.ts), so the renderer never ships to the page that
// holds the owner's session.
import type MarkdownIt from "markdown-it";
import type { StateInline } from "markdown-it";
import { noteMathFailure, renderTex, TEX_MAX } from "./math-render.ts";

export interface MathSpan {
  /** The TeX between the delimiters, as written. */
  tex: string;
  display: boolean;
  /** Offsets of the whole formula, delimiters included, in the inline source. */
  start: number;
  end: number;
}

// The Private Use Area, where the studio's own placeholders live (studio#3).
const SENTINEL = /[\uE000-\uF8FF]/;
const SENTINELS = /[\uE000-\uF8FF]+[^\uE000-\uF8FF]*?[\uE000-\uF8FF]+|[\uE000-\uF8FF]+/g;

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

/**
 * For each position in one inline source, the next dollar that could close an
 * inline formula and the next `$$`, both unescaped. Computed once per source in
 * one pass, so finding a formula is linear however many lone dollars a paragraph
 * holds (Fable's review of studio#149: per-opener scanning was quadratic).
 */
let closers: { src: string; inline: Int32Array; display: Int32Array } | null = null;
function closersFor(src: string) {
  if (closers?.src === src) return closers;
  const n = src.length;
  const escaped = new Uint8Array(n + 1);
  for (let k = 0; k < n; k++) if (src[k] === "\\" && !escaped[k]) escaped[k + 1] = 1;
  const inline = new Int32Array(n + 1).fill(-1);
  const display = new Int32Array(n + 1).fill(-1);
  let nextInline = -1;
  let nextDisplay = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (src[j] === "$" && !escaped[j]) {
      if (!isSpace(src[j - 1]) && !/\d/.test(src[j + 1] ?? "")) nextInline = j;
      if (src[j + 1] === "$") nextDisplay = j;
    }
    inline[j] = nextInline;
    display[j] = nextDisplay;
  }
  closers = { src, inline, display };
  return closers;
}

/** The formula opening at `pos` in `src`, if one does. */
export function mathAt(src: string, pos: number): MathSpan | null {
  if (src[pos] !== "$") return null;
  const found = closersFor(src);
  // A formula longer than TEX_MAX is not drawn, so a closing dollar further
  // away than that does not close one: those dollars are prose.
  if (src[pos + 1] === "$") {
    const j = pos + 2 <= src.length ? found.display[pos + 2] : -1;
    if (j < 0 || j - (pos + 2) > TEX_MAX) return null;
    const tex = src.slice(pos + 2, j);
    return tex.trim() ? { tex, display: true, start: pos, end: j + 2 } : null;
  }
  if (isSpace(src[pos + 1])) return null;
  const j = found.inline[pos + 1];
  if (j < 0 || j - (pos + 1) > TEX_MAX) return null;
  return { tex: src.slice(pos + 1, j), display: false, start: pos, end: j + 1 };
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const span = mathAt(state.src, state.pos);
  if (!span) return false;
  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.content = span.tex;
    token.markup = span.display ? "$$" : "$";
    token.meta = { display: span.display };
  }
  state.pos = span.end;
  return true;
}

export function mathPlugin(md: MarkdownIt) {
  // After `escape`, so `\$` is already a dollar sign; before `backticks` makes
  // no difference to code, which starts with a backtick and never with `$`.
  md.inline.ruler.after("escape", "math_inline", mathInline);
  md.renderer.rules.math_inline = (tokens, idx) => {
    const token = tokens[idx];
    const display = Boolean(token.meta?.display);
    const { html, error } = renderTex(token.content, display);
    if (error) {
      // By the time a formula renders at publish, a link, a mention or a
      // generated span inside it has become a private sentinel character.
      const inner = SENTINEL.test(token.content);
      noteMathFailure({
        formula: `${token.markup}${token.content.replace(SENTINELS, "…")}${token.markup}`,
        reason: inner ? "a formula cannot contain a link, a mention or a generated span" : error,
      });
    }
    return html;
  };
}

export interface MathError {
  formula: string;
  reason: string;
}

/** Every formula in rendered markdown that does not parse, for publish to refuse. */
export function mathErrors(md: MarkdownIt, contentMd: string): MathError[] {
  const errors: MathError[] = [];
  for (const block of md.parse(contentMd, {})) {
    for (const token of block.children ?? []) {
      if (token.type !== "math_inline") continue;
      const { error } = renderTex(token.content, Boolean(token.meta?.display));
      if (error) errors.push({ formula: `${token.markup}${token.content}${token.markup}`, reason: error });
    }
  }
  return errors;
}

export class MathPublishError extends Error {
  constructor(readonly errors: MathError[]) {
    super("one or more formulas do not parse");
  }
}
