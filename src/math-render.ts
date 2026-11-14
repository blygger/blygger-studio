// The Worker's formula renderer: temml, MathML Core only (decision #105). No
// stylesheet, script or font goes with it, because `content_html` travels
// without them (§5.2). `annotate` keeps the author's TeX inside the formula for
// readers that will not draw it; `trust: false` refuses \href, \class, \htmlId
// and the rest of what could put a link or an attribute in published HTML.
//
// One function for both paths (#105 as amended, v0.4-plan §23.4): publish draws
// a formula from what the author typed, and the sanitizer redraws one from the
// TeX annotation of a `math` element it found, so a formula reads the same in a
// fragment, which is not sanitized, and in a thread, which is. Its output never
// carries `style`, and is checked against an allowlist before anyone sees it,
// so a temml upgrade cannot widen what reaches a page without a test failing.
//
// The browser bundle gets math-render.browser.ts in this module's place.
import temml from "temml";
import { AsyncLocalStorage } from "node:async_hooks";

/** A formula publish refuses, as the author wrote it, and why. */
export interface MathFailure { formula: string; reason: string }
/**
 * The formulas that failed while one publish rendered (Fable's review of
 * studio#149, R1). Recorded by the markdown render rule as it draws, so publish
 * judges what was actually rendered, after links, mentions and generated spans
 * went in, and never the HTML it produced, which can carry other origins' bytes.
 * Scoped per request: two publishes in one isolate never see each other's.
 */
const failures = new AsyncLocalStorage<MathFailure[]>();
export const withMathFailures = <T>(fn: () => Promise<T>): Promise<T> => failures.run([], fn);
export const noteMathFailure = (failure: MathFailure) => { failures.getStore()?.push(failure); };
export const mathFailures = (): MathFailure[] => failures.getStore() ?? [];

// Escaped here, not imported: this module is in both the Worker and the UI
// typecheck, and util.ts is Worker-only.
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The longest TeX drawn as a formula; longer is shown as written. */
export const TEX_MAX = 4000;

/** What a formula may be made of (opus-brief, session 69, invariant 4). */
export const MATH_ELEMENTS = new Set(
  "math semantics annotation mrow mi mn mo ms mtext mspace mfrac msqrt mroot mstyle merror mpadded mphantom msub msup msubsup munder mover munderover mmultiscripts mprescripts mtable mtr mtd".split(" "),
);
export const MATH_ATTRIBUTES = new Set(
  "display displaystyle scriptlevel mathvariant stretchy fence separator lspace rspace movablelimits accent accentunder form largeop symmetric minsize maxsize linethickness columnalign rowalign columnspan rowspan width height depth voffset encoding class".split(" "),
);

/**
 * Lengths a formula may set (Fable's review of studio#149, R2). Without a bound,
 * `\\raisebox{-30em}` lays a quoted formula's text over someone else's paragraph
 * and `\\hspace{9999em}` blows out the page: what stripping `style` was for. In
 * em: at most 20, at least -2. Other units by rough equivalence.
 */
const LENGTHS = new Set("width height depth voffset lspace rspace minsize maxsize linethickness".split(" "));
const EM: Record<string, number> = { em: 1, ex: 0.5, px: 1 / 16, pt: 1 / 12, "%": 0.2 };
export function allowedLength(value: string): boolean {
  if (value === "-1width") return true; // temml's \llap: back by its own width, never more
  const m = /^(-?\d*\.?\d+)(em|ex|px|pt|%)?$/.exec(value.trim());
  if (!m) return false;
  const em = Number(m[1]) * (m[2] ? EM[m[2]] : 1);
  return em <= 20 && em >= -2;
}

/** Whether rendered MathML uses only allowed element and attribute names, and bounded lengths. */
export function allowedMath(html: string): boolean {
  for (const tag of html.matchAll(/<\/?([^\s/>]+)([^>]*)>/g)) {
    if (!MATH_ELEMENTS.has(tag[1].toLowerCase())) return false;
    for (const attribute of tag[2].matchAll(/([^\s=/]+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      const name = attribute[1].toLowerCase();
      if (!MATH_ATTRIBUTES.has(name)) return false;
      if (LENGTHS.has(name) && !allowedLength((attribute[2] ?? "").replace(/^["']|["']$/g, ""))) return false;
    }
  }
  return true;
}

/** Where the element opening at `start` closes: the index just past its end tag, or -1. */
function closeOf(html: string, start: number, name: string): number {
  const tag = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, 'g');
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    if (m[2]) { if (depth === 0) return tag.lastIndex; continue; }
    depth += m[1] ? -1 : 1;
    if (depth === 0) return tag.lastIndex;
  }
  return -1;
}

/**
 * The commands temml draws with `menclose`, which is not MathML Core: Chromium draws
 * nothing for it, and temml relies on a stylesheet we never ship (§5.2). The rule
 * (v0.4-plan §23.5): if Core can draw it, draw it in Core; if losing it changes only
 * emphasis, draw it plain; if losing it changes what the formula says, refuse it.
 */
const REFUSED_NOTATIONS: Record<string, string> = {
  updiagonalstrike: '\\cancel',
  downdiagonalstrike: '\\bcancel',
  'updiagonalstrike downdiagonalstrike': '\\xcancel',
  horizontalstrike: '\\sout',
  actuarial: '\\angl',
  phasorangle: '\\phase',
  longdiv: '\\longdiv',
};
export class UndrawableCommand extends Error {}

function withoutMenclose(html: string): string {
  for (let at = html.lastIndexOf('<menclose'); at >= 0; at = html.lastIndexOf('<menclose')) {
    const end = closeOf(html, at, 'menclose');
    const open = /^<menclose\b([^>]*)>/.exec(html.slice(at));
    if (end < 0 || !open) throw new UndrawableCommand('this formula could not be drawn');
    const notation = /\snotation="([^"]*)"/.exec(open[1])?.[1] ?? '';
    const inner = html.slice(at + open[0].length, end - '</menclose>'.length);
    let replacement: string;
    if (notation === 'top') replacement = `<mover accent="true"><mrow>${inner}</mrow><mo stretchy="true">\u203E</mo></mover>`;
    else if (notation === 'bottom') replacement = `<munder accentunder="true"><mrow>${inner}</mrow><mo stretchy="true">_</mo></munder>`;
    else if (notation === 'box') replacement = inner;
    else {
      const command = REFUSED_NOTATIONS[notation];
      throw new UndrawableCommand(`${command ?? 'this command'} needs a stylesheet most readers will not have, so the Studio does not publish it`);
    }
    html = html.slice(0, at) + replacement + html.slice(end);
  }
  return html;
}

/**
 * temml marks an accent's operator `math-depth:0` in a style, which is stripped; the
 * Core way to keep it full size is `accent` on the `mover` (and `accentunder`).
 */
function accentsKept(html: string): string {
  for (const [name, attribute] of [['mover', 'accent'], ['munder', 'accentunder']] as const) {
    let out = '';
    let from = 0;
    const open = new RegExp(`<${name}>`, 'g');
    for (let m = open.exec(html); m; m = open.exec(html)) {
      const end = closeOf(html, m.index, name);
      if (end < 0) break;
      const body = html.slice(m.index, end);
      const last = body.lastIndexOf('<mo ');
      const accent = last >= 0 && /^<mo [^>]*style="math-depth:0;?"/.test(body.slice(last)) && body.endsWith(`</mo></${name}>`);
      if (accent) {
        out += html.slice(from, m.index) + `<${name} ${attribute}="true">`;
        from = m.index + m[0].length;
      }
    }
    html = out + html.slice(from);
  }
  return html;
}

const written = (tex: string, display: boolean) => (display ? `$$${tex}$$` : `$${tex}$`);

// Every display of a thread redraws its formulas, so the same few are drawn
// again and again in one isolate. Bounded, and cleared whole when full.
const drawn = new Map<string, { html: string; error?: string }>();
const DRAWN_MAX = 500;

export function renderTex(tex: string, display: boolean, draw: (tex: string, display: boolean) => string = temmlDraw): { html: string; error?: string } {
  const key = `${display ? "D" : "I"}${tex}`;
  const memo = draw === temmlDraw ? drawn.get(key) : undefined;
  if (memo) return memo;
  const result = drawChecked(tex, display, draw);
  if (draw === temmlDraw) {
    if (drawn.size >= DRAWN_MAX) drawn.clear();
    drawn.set(key, result);
  }
  return result;
}

function temmlDraw(tex: string, display: boolean): string {
  return temml.renderToString(tex, { displayMode: display, annotate: true, trust: false, throwOnError: true });
}

function drawChecked(tex: string, display: boolean, draw: (tex: string, display: boolean) => string): { html: string; error?: string } {
  const failed = (reason: string) => ({
    // Shown in preview; publish refuses before it would be baked.
    html: `<code class="math-error" title="${escapeHtml(reason)}">${escapeHtml(written(tex, display))}</code>`,
    error: reason,
  });
  if (tex.length > TEX_MAX) return failed(`a formula is limited to ${TEX_MAX} characters`);
  let html: string;
  try {
    html = withoutMenclose(accentsKept(draw(tex, display)));
  } catch (e) {
    return failed(e instanceof Error ? e.message.replace(/^\s*ParseError:\s*/, "").trim() : String(e));
  }
  // No formula restyles the page it lands on (§23.4): the display flag alone
  // makes a displayed formula a block.
  html = html.replace(/\sstyle="[^"]*"/g, "");
  if (!allowedMath(html)) return failed("this formula uses MathML the Studio does not publish yet, or moves its text further than a formula may");
  return { html };
}

/** A formula that could not be drawn, shown as written. For a reader, not an author. */
export function texAsText(tex: string, display: boolean): string {
  return `<code class="math-source">${escapeHtml(written(tex, display))}</code>`;
}
