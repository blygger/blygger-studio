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
import { renderTex } from "./math-render.ts";

export interface MathSpan {
  /** The TeX between the delimiters, as written. */
  tex: string;
  display: boolean;
  /** Offsets of the whole formula, delimiters included, in the inline source. */
  start: number;
  end: number;
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

/** The formula opening at `pos` in `src`, if one does. */
export function mathAt(src: string, pos: number): MathSpan | null {
  if (src[pos] !== "$") return null;
  if (src[pos + 1] === "$") {
    for (let j = pos + 2; j < src.length - 1; j++) {
      if (src[j] === "\\") { j++; continue; }
      if (src[j] === "$" && src[j + 1] === "$") {
        const tex = src.slice(pos + 2, j);
        return tex.trim() ? { tex, display: true, start: pos, end: j + 2 } : null;
      }
    }
    return null;
  }
  if (isSpace(src[pos + 1])) return null;
  for (let j = pos + 1; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] !== "$") continue;
    if (isSpace(src[j - 1]) || /\d/.test(src[j + 1] ?? "")) continue;
    return { tex: src.slice(pos + 1, j), display: false, start: pos, end: j + 1 };
  }
  return null;
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
    return renderTex(token.content, Boolean(token.meta?.display)).html;
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
