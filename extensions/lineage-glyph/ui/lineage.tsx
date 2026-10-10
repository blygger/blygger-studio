/*
 * Lineage — the reading view's way of explaining what each action does by
 * showing it. Three surfaces over one map:
 *
 *   glyph   a sparkline-sized fan in an entry's byline: strokes in from what
 *           the post draws on, strokes out to what draws on it (known here).
 *   hex     the glyph opens the post as a hexagon with its ancestors above and
 *           descendants below. Each vertex is an action; previewing one drops a
 *           dashed ghost of what it would make into the graph.
 *   ring    pressing the hexagon opens a radial menu in the same positions,
 *           whose panel animates the result and lists the same four facts for
 *           every action.
 *
 * The compass is the rule that makes the positions teach: bottom = respond
 * (stub ↗ whole, quote a passage), sides = make your own thing (fork
 * their words, link post ↗ your words), top = only look (history, open ↗).
 * Arrows follow derivation: ancestor → post → descendant (from what a post
 * draws on into it, and out of it to what draws on it), so "up" always means
 * "towards origins".
 *
 * Nothing here touches the wire; descendants are what this node knows.
 * Ported from #35 into the lineage-glyph extension: it reaches the Studio only
 * through extension-api.ts, and its data only through the extension's routes.
 */
import type { ReactNode } from 'react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  BlyggerClient,
  LineageGlyphLineage as Lineage,
  LineageGlyphNode as LineageNode,
  LineageGlyphSummary as LineageSummary,
} from '../../../sdk/dist/browser.js';
import { BlyggerApi, Button, Sheet, unwrap } from '../../../src/ui/extension-api.ts';
import './lineage.css';

export type ActionKey = 'fork' | 'stub' | 'quote' | 'link' | 'history' | 'open';
type Rel = 'stub' | 'quote' | 'fork' | 'link' | 'read';
interface Point {
  key: ActionKey;
  label: string;
  angle: number;
  rel: Rel;
  ghost: [string, string];
  one: string;
  long: string;
  facts: [string, string, boolean][];
}
const FACTS = ['a response?', 'the author is told?', 'their words in yours', 'shows under their post?'];
const facts = (...values: [string, boolean][]) =>
  values.map(([value, yes], i) => [FACTS[i], value, yes] as [string, string, boolean]);

/** The action compass. Labels are the studio's own words, verbatim. */
export const COMPASS: Point[] = [
  {
    key: 'fork', label: 'fork', angle: 0, rel: 'fork', ghost: ['your fork', 'draft · yours to edit'],
    one: 'Start your own copy of this post.',
    long: "Opens a draft that begins as the author's last pinned version, flattened to text you can rewrite freely. The result is yours, and records that it was forked from theirs.",
    facts: facts(['no — a line of its own', false], ['yes, as a fork', true], ['all of them, editable', true], ['listed as a fork', true]),
  },
  {
    key: 'stub', label: 'stub ↗', angle: 60, rel: 'stub', ghost: ['your response', 'new thread'],
    one: 'Respond to this post.',
    long: "Opens a thread that starts with the whole post quoted as a frozen snapshot, with your reply beneath it. It declares itself a response: the author's blyg is told, and can list it under their post.",
    facts: facts(['yes', true], ['yes, as a stub', true], ['the whole post, frozen', true], ['yes, as a response', true]),
  },
  {
    key: 'quote', label: 'quote a passage', angle: 120, rel: 'quote', ghost: ['your response', 'quoting a passage'],
    one: 'Respond, quoting only the passage you choose.',
    long: "Like stub ↗ this opens a response, in the stub editor, where you select the passage in the post as it will be quoted; publish checks it against their text. Use it to answer one sentence rather than the whole post.",
    facts: facts(['yes', true], ['yes, as a stub', true], ['just the passage', true], ['yes, as a response', true]),
  },
  {
    key: 'link', label: 'link post ↗', angle: 180, rel: 'link', ghost: ['your fragment', '…links here…'],
    one: 'Write something of your own that links to this.',
    long: 'Opens a fragment that starts with [[id]], which publishes as an ordinary link to the post. No text is copied and nothing is sent: the author is not told.',
    facts: facts(['no', false], ['no — links are silent', false], ['none', false], ['no', false]),
  },
  {
    key: 'history', label: 'history', angle: 240, rel: 'read', ghost: ['versions', 'change notes'],
    one: 'See how this post has changed.',
    long: "The author's change notes for each version, read from their site. Between pinned versions you can see the change word by word. Nothing is created.",
    facts: facts(['n/a — reading only', false], ['no', false], ['none', false], ['n/a', false]),
  },
  {
    key: 'open', label: 'open ↗', angle: 300, rel: 'read', ghost: ['their page', 'new tab'],
    one: "Read it on the author's own site.",
    long: "Opens the post's public page in a new tab. Unsaved writing in the studio stays where it is.",
    facts: facts(['n/a — reading only', false], ['no', false], ['none', false], ['n/a', false]),
  },
];
const point = (key: ActionKey) => COMPASS.find((p) => p.key === key)!;

/** What a reference looks like on the map: a partial stub is "quote a passage". */
export function relOf(relation: LineageNode['relation'], partial: boolean): Rel {
  if (relation === 'fork') return 'fork';
  if (relation === 'stub' && !partial) return 'stub';
  return 'quote';
}

/* ---------------- handlers ---------------- */

export interface Handler {
  run?: () => void;
  /** Why the action is not available for this node. */
  unavailable?: string;
}
export type Handlers = Partial<Record<ActionKey, Handler>>;

/* ---------------- glyph ---------------- */

const SIDE = 3;
const counts = (c: LineageSummary['up']): Rel[] => [
  ...Array<Rel>(c.fork).fill('fork'),
  ...Array<Rel>(c.stub).fill('stub'),
  ...Array<Rel>(c.transclusion).fill('quote'),
];
const hexPoints = (cx: number, cy: number, r: number) =>
  [0, 60, 120, 180, 240, 300]
    .map((a) => `${cx + r * Math.cos((a * Math.PI) / 180)},${cy + r * Math.sin((a * Math.PI) / 180)}`)
    .join(' ');

/**
 * The byline glyph: what the post draws on comes in from the left, what draws
 * on it goes out to the right, one stroke per reference (three a side, then
 * the count says the rest). `ghost` draws a dashed stroke for the action being
 * pointed at — option C's strip.
 */
export function LineageGlyph({ summary, ghost }: { summary: LineageSummary; ghost?: ActionKey | null }) {
  const up = counts(summary.up), down = counts(summary.down);
  const cx = 36, cy = 10;
  const ys = (n: number) => (n <= 1 ? [cy] : n === 2 ? [5, 15] : [3, 10, 17]);
  const ghostRel = ghost && ghost !== 'history' && ghost !== 'open' ? point(ghost).rel : null;
  return (
    <svg className="lg-glyph" viewBox="0 0 74 20" width="74" height="20" aria-hidden="true">
      {up.slice(0, SIDE).map((rel, i, all) => {
        const y = ys(all.length)[i];
        return (
          <g key={`u${i}`}>
            <path className={`lg-edge s-${rel}`} d={`M4 ${y} C 18 ${y}, 22 ${cy}, ${cx - 6} ${cy}`} />
            <circle className={`f-${rel}`} cx="4" cy={y} r="2.2" />
          </g>
        );
      })}
      {down.slice(0, SIDE).map((rel, i, all) => {
        const y = ys(all.length + (ghostRel ? 1 : 0))[i];
        return (
          <g key={`d${i}`}>
            <path className={`lg-edge s-${rel}`} d={`M${cx + 6} ${cy} C 50 ${cy}, 54 ${y}, 68 ${y}`} />
            <circle className={`f-${rel}`} cx="68" cy={y} r="2.2" />
          </g>
        );
      })}
      {ghostRel ? (
        <g className="lg-ghost" data-ghost={ghost}>
          <path className={`lg-edge s-${ghostRel}`} strokeDasharray="2 2" d={`M${cx + 6} ${cy} C 50 ${cy}, 54 17, 68 17`} />
          <circle className={`s-${ghostRel}`} cx="68" cy="17" r="2.6" fill="none" strokeDasharray="1.5 1.5" />
        </g>
      ) : null}
      <polygon className="lg-hex" points={hexPoints(cx, cy, 6)} />
    </svg>
  );
}
export function glyphLabel(summary: LineageSummary) {
  const n = (c: LineageSummary['up']) => c.stub + c.transclusion + c.fork;
  return `lineage: draws on ${n(summary.up)}, ${n(summary.down)} known to draw on it`;
}
export function glyphCounts(summary: LineageSummary) {
  const n = (c: LineageSummary['up']) => c.stub + c.transclusion + c.fork;
  return `${n(summary.up)} · ${n(summary.down)}`;
}

/* ---------------- the explainer panel (shared by hex and ring) ---------------- */

function short(text: string | null | undefined, n: number) {
  const t = (text ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** An animated sketch of the result: their post, and what the action makes of it. */
export function Sketch({ action, title }: { action: ActionKey; title: string }) {
  const t = short(title || 'their post', 20);
  const theirs = (x = 20, y = 20) => (
    <g>
      <rect className="sk-box" x={x} y={y} width="130" height="52" rx="6" />
      <text className="sk-t" x={x + 10} y={y + 21}>{t}</text>
      <text className="sk-w" x={x + 10} y={y + 37}>theirs</text>
    </g>
  );
  const lines = (x: number, y: number, n: number, w = 110) =>
    Array.from({ length: n }, (_, i) => (
      <rect key={i} className="sk-line" x={x} y={y + i * 9} width={w - (i % 2) * 24} height="4" rx="2" />
    ));
  const arrow = (x1: number, y1: number, x2: number, y2: number, rel: Rel, label = '') => (
    <g className="late">
      <path className={`lg-edge s-${rel}`} d={`M${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`} markerEnd={`url(#sk-${rel})`} />
      {label ? <text className={`sk-w c-${rel}`} x={(x1 + x2) / 2 + 6} y={(y1 + y2) / 2}>{label}</text> : null}
    </g>
  );
  let body: ReactNode = null;
  if (action === 'stub')
    body = (
      <>
        {theirs()}
        <g className="pop">
          <rect className="sk-box s-stub" x="150" y="118" width="160" height="92" rx="6" />
          <rect className="sk-quote s-stub" x="160" y="128" width="140" height="34" rx="3" />
          <text className="sk-w" x="166" y="141">{t} · all of it</text>
          {lines(166, 148, 2, 110)}
          {lines(160, 172, 3, 130)}
          <text className="sk-t c-stub" x="160" y="206">you · your response</text>
        </g>
        {arrow(85, 72, 200, 118, 'stub', 'answered by')}
      </>
    );
  if (action === 'quote')
    body = (
      <>
        {theirs()}
        <rect className="f-quote sk-mark" x="30" y="62" width="80" height="5" rx="2" />
        <rect className="sk-box s-quote" x="150" y="118" width="160" height="92" rx="6" />
        {lines(160, 176, 3, 130)}
        <text className="sk-t c-quote" x="160" y="206">you · your response</text>
        <g className="fly">
          <rect className="sk-quote s-quote" x="12" y="10" width="80" height="20" rx="3" />
          <text className="sk-w" x="18" y="24">“the passage…”</text>
        </g>
        {arrow(85, 72, 200, 118, 'quote', 'one passage')}
      </>
    );
  if (action === 'fork')
    body = (
      <>
        {theirs()}
        <g className="slide">{theirs()}</g>
        <g className="late">
          <rect className="s-fork sk-thick" x="190" y="20" width="130" height="52" rx="6" fill="none" />
          <text className="sk-t c-fork" x="196" y="90">yours now — edit freely</text>
          <path className="lg-edge s-fork" strokeDasharray="2 3" d="M85 72 C 85 140, 255 140, 255 76" />
          <text className="sk-w c-fork" x="110" y="150">forked from their pinned version</text>
        </g>
      </>
    );
  if (action === 'link')
    body = (
      <>
        {theirs()}
        <g className="pop">
          <rect className="sk-box s-link" x="150" y="118" width="160" height="80" rx="6" />
          {lines(160, 130, 2, 130)}
          <text className="sk-w" x="160" y="160">…as <tspan className="sk-a">{short(title || 'they', 14)}</tspan> says…</text>
          {lines(160, 170, 2, 130)}
        </g>
        <path className="lg-edge s-link late" d="M200 118 C 200 95, 85 95, 85 72" />
        <text className="sk-w c-link late" x="20" y="120">nothing is sent</text>
        <text className="sk-w c-link late" x="20" y="134">the author isn’t told</text>
      </>
    );
  if (action === 'history')
    body = (
      <>
        <g className="fan1"><rect className="sk-box" x="40" y="40" width="130" height="52" rx="6" /></g>
        <g className="fan2"><rect className="sk-box" x="40" y="40" width="130" height="52" rx="6" /></g>
        {theirs(40, 40)}
        <g className="late">
          <text className="sk-t" x="190" y="54">v3 · latest note</text>
          <text className="sk-w" x="190" y="70">v2 · pinned</text>
          <text className="sk-w" x="190" y="86">v1 · pinned</text>
          <text className="sk-w c-read" x="190" y="108">see the change: v1 → v2</text>
        </g>
      </>
    );
  if (action === 'open')
    body = (
      <>
        {theirs()}
        <g className="pop">
          <rect className="sk-box s-read" x="160" y="110" width="150" height="90" rx="6" />
          <rect className="sk-quote" x="160" y="110" width="150" height="16" rx="6" />
          <text className="sk-w" x="168" y="122">their site ↗</text>
          {lines(170, 136, 5, 128)}
        </g>
        <path className="lg-edge s-read late" d="M150 72 L170 106" markerEnd="url(#sk-read)" />
        <text className="sk-w c-read late" x="20" y="140">new tab — your drafts stay put</text>
      </>
    );
  return (
    // Keyed by action so switching replays the animation.
    <svg key={action} className="lg-sketch" viewBox="0 0 330 220" role="img" aria-label={`sketch: what ${point(action).label} makes`}>
      <defs>
        {(['stub', 'quote', 'fork', 'link', 'read'] as Rel[]).map((rel) => (
          <marker key={rel} id={`sk-${rel}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" className={`f-${rel}`} />
          </marker>
        ))}
      </defs>
      {body}
    </svg>
  );
}

/** True beside the graph (≥900px, where the sheet is two columns), false on a phone. */
function useWide() {
  const query = '(min-width: 900px)';
  return useSyncExternalStore(
    (listener) => {
      const media = matchMedia(query);
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    },
    () => matchMedia(query).matches,
  );
}

function Explain({
  action,
  handler,
  title,
  onDo,
}: {
  action: ActionKey | null;
  handler?: Handler;
  title: string;
  onDo: () => void;
}) {
  const wide = useWide();
  if (!action)
    return (
      <div className="lg-explain" aria-live="polite">
        <p className="lg-hint">
          Point at a corner of the hexagon — or press the hexagon for the ring — to see what each action makes. The
          bottom corners respond, the sides make something of your own, the top ones only look.
        </p>
      </div>
    );
  const p = point(action);
  return (
    <div className="lg-explain" aria-live="polite" data-action={action} key={action}>
      <div className={`lg-act c-${p.rel}`}>{p.label}</div>
      <p className="lg-one">{p.one}</p>
      <Sketch action={action} title={title} />
      {/* Always open beside the graph; folded on a phone, where the card is pinned over it. */}
      <details className="lg-more" open={wide}>
        <summary>what exactly happens</summary>
        <p className="lg-long">{p.long}</p>
        <dl className="lg-facts">
          {p.facts.map(([k, v, yes]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className={yes ? '' : 'no'}>{v}</dd>
            </div>
          ))}
        </dl>
      </details>
      {handler?.unavailable ? <p className="lg-hint lg-unavailable">{handler.unavailable}</p> : null}
      <Button className="btn btn-primary lg-do" disabled={!handler?.run} onClick={onDo} data-action={`lineage-${action}`}>
        {p.label}
      </Button>
    </div>
  );
}

/* ---------------- the hex graph ---------------- */

const W = 420, H = 500, CX = 210, CY = 250, R = 54, NW = 120, NH = 40, D = 150;
const rad = (a: number) => (a * Math.PI) / 180;
const vpos = (a: number): [number, number] => [CX + R * Math.cos(rad(a)), CY + R * Math.sin(rad(a))];
const rowXs = (n: number) => (n === 1 ? [CX] : n === 2 ? [130, 290] : [72, 210, 348]);
const ROW = 3;
/** How a neighbour relates, in words: a partial stub is a response to a passage, not a quote. */
function relationWord(node: Pick<LineageNode, 'relation' | 'partial' | 'via'>, up: boolean) {
  if (node.via === 'mention') return up ? 'mention' : 'verified mention';
  if (node.relation === 'fork') return up ? 'forked from it' : 'fork';
  if (node.relation === 'stub') return node.partial ? (up ? 'responds to a passage' : 'response to a passage') : up ? 'responds to it' : 'response';
  return up ? 'quotes it' : 'quotes this';
}

function nodeTitle(node: Pick<LineageNode, 'title' | 'excerpt' | 'source' | 'url' | 'id'>) {
  if (node.title) return node.title;
  if (node.excerpt) return node.excerpt;
  if (node.url) {
    try {
      return new URL(node.url).host;
    } catch {
      /* fall through */
    }
  }
  return node.id ?? 'unknown';
}

function GraphNode({
  x,
  y,
  node,
  up,
  onOpen,
}: {
  x: number;
  y: number;
  node: LineageNode;
  up: boolean;
  onOpen: (node: LineageNode) => void;
}) {
  const rel = relOf(node.relation, node.partial);
  // The relation first: when the line is cut short, the blyg's name gives way.
  const sub = [relationWord(node, up), node.held === 'own' ? 'you' : node.source].filter(Boolean).join(' · ');
  const canOpen = !!(node.id && node.origin);
  return (
    <g
      className={`lg-node${canOpen ? ' lg-node-open' : ''}`}
      transform={`translate(${x - NW / 2},${y - NH / 2})`}
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      aria-label={canOpen ? `centre on ${nodeTitle(node)}` : undefined}
      onClick={() => canOpen && onOpen(node)}
      onKeyDown={(event) => {
        if (canOpen && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpen(node);
        }
      }}
    >
      <rect className="lg-box" width={NW} height={NH} rx="6" />
      <rect className={`f-${rel}`} width="4" height={NH} rx="2" />
      <text className="lg-t" x="11" y="17">{short(nodeTitle(node), 18)}</text>
      <text className="lg-w" x="11" y="31">{short(sub, 22)}</text>
    </g>
  );
}

function curve(x1: number, y1: number, x2: number, y2: number) {
  return `M${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
}

function wedge(a: number, r1: number, r2: number, span = 58) {
  const p = (ang: number, r: number) => [CX + r * Math.cos(rad(ang)), CY + r * Math.sin(rad(ang))];
  const [x1, y1] = p(a - span / 2, r2), [x2, y2] = p(a + span / 2, r2), [x3, y3] = p(a + span / 2, r1), [x4, y4] = p(a - span / 2, r1);
  return `M${x1} ${y1} A${r2} ${r2} 0 0 1 ${x2} ${y2} L${x3} ${y3} A${r1} ${r1} 0 0 0 ${x4} ${y4} Z`;
}

function HexGraph({
  lineage,
  preview,
  ring,
  labels,
  handlers,
  onPreview,
  onCommit,
  onRing,
  onOpen,
}: {
  lineage: Lineage;
  preview: ActionKey | null;
  ring: boolean;
  labels: boolean;
  handlers: Handlers;
  onPreview: (key: ActionKey) => void;
  onCommit: (key: ActionKey) => void;
  onRing: () => void;
  onOpen: (node: LineageNode) => void;
}) {
  const { node, ancestors, descendants } = lineage;
  const ups = ancestors.slice(0, ROW), downs = descendants.slice(0, ROW);
  const p = preview ? point(preview) : null;
  // Hover (a mouse) previews; a press commits only what was already previewed
  // before it began, so a tap — whose compatibility hover and focus land in the
  // same gesture — previews first and commits on the second tap.
  const armed = useRef<ActionKey | null>(null);
  const down = (key: ActionKey) => {
    armed.current = preview === key ? key : null;
  };
  const press = (key: ActionKey) => (armed.current === key ? onCommit(key) : onPreview(key));
  const hover = (key: ActionKey) => (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse') onPreview(key);
  };
  const keyed = (key: ActionKey) => (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onCommit(key);
    }
  };
  let ghost: ReactNode = null;
  if (p && !ring) {
    const [vx, vy] = vpos(p.angle);
    // The sideways actions sit off their corner's level so the ghost clears the
    // corner labels: fork below (it joins what came from it), link post above
    // (it joins nothing — the author is never told).
    const lift = p.angle === 0 ? 78 : p.angle === 180 ? -78 : 0;
    const gx = CX + D * Math.cos(rad(p.angle)), gy = lift ? CY + lift : CY + D * Math.sin(rad(p.angle));
    const dx = vx - gx, dy = vy - gy, len = Math.hypot(dx, dy);
    const ex = vx - (dx / len) * 14, ey = vy - (dy / len) * 14;
    // The arrow runs from the post to the ghost (derivation flows out), so its
    // head sits at the ghost end: start just outside the ghost box's edge.
    const ux = dx / len, uy = dy / len;
    const clear = Math.min(Math.abs(ux) > 0.01 ? 56 / Math.abs(ux) : Infinity, NH / 2 / Math.abs(uy)) + 3;
    const sx = gx + ux * clear, sy = gy + uy * clear;
    ghost = (
      <g className="lg-ghost" data-ghost={p.key}>
        <path className={`lg-edge lg-ghost-edge s-${p.rel}`} d={`M${sx} ${sy} L${ex} ${ey}`} markerStart={p.rel === 'read' ? undefined : `url(#lg-${p.rel})`} />
        <g transform={`translate(${gx - 56},${gy - NH / 2})`}>
          <rect className={`lg-box lg-ghost-box s-${p.rel}`} width="112" height={NH} rx="6" />
          <rect className={`f-${p.rel}`} width="4" height={NH} rx="2" />
          <text className="lg-t" x="11" y="17">{p.ghost[0]}</text>
          <text className="lg-w" x="11" y="31">{p.ghost[1]}</text>
        </g>
        {p.key === 'link' ? <text className="lg-w c-link" x={(sx + ex) / 2 + 10} y={(sy + ey) / 2 + 2} textAnchor="start">not sent</text> : null}
        {p.key === 'stub' || p.key === 'quote' || p.key === 'fork' ? (
          <text className={`lg-w c-${p.rel}`} x={gx} y={gy + NH / 2 + 14} textAnchor="middle">joins what came from it</text>
        ) : null}
      </g>
    );
  }
  return (
    <svg className={`lg-graph${preview && !ring ? ' dim' : ''}`} viewBox={`0 0 ${W} ${H}`} role="group" aria-label="lineage">
      <defs>
        {(['stub', 'quote', 'fork', 'link', 'read'] as Rel[]).map((rel) => (
          <marker key={rel} id={`lg-${rel}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className={`f-${rel}`} />
          </marker>
        ))}
      </defs>
      <text className="lg-w lg-row" x="8" y="12">{ancestors.length ? 'where it came from' : 'draws on nothing'}</text>
      <text className="lg-w lg-row" x="8" y={H - 4}>
        {descendants.length ? 'what came from it — known here' : 'nothing known here draws on it yet'}
      </text>
      <g className="lg-base">
        {ups.map((a, i) => {
          const x = rowXs(ups.length)[i];
          return <path key={`ue${i}`} className={`lg-edge s-${relOf(a.relation, a.partial)}`} d={curve(CX - 16 + i * 16, CY - R * 0.866, x, 40 + NH / 2)} markerStart={`url(#lg-${relOf(a.relation, a.partial)})`} />;
        })}
        {downs.map((d, i) => {
          const x = rowXs(downs.length)[i];
          return <path key={`de${i}`} className={`lg-edge s-${relOf(d.relation, d.partial)}`} d={curve(x, H - 40 - NH / 2, CX - 16 + i * 16, CY + R * 0.866 + 2)} markerStart={`url(#lg-${relOf(d.relation, d.partial)})`} />;
        })}
      </g>
      {ups.map((a, i) => <GraphNode key={`u${i}`} x={rowXs(ups.length)[i]} y={40} node={a} up onOpen={onOpen} />)}
      {downs.map((d, i) => <GraphNode key={`d${i}`} x={rowXs(downs.length)[i]} y={H - 40} node={d} up={false} onOpen={onOpen} />)}
      {ancestors.length > ROW ? <text className="lg-w" x={W - 8} y="12" textAnchor="end">+{ancestors.length - ROW} more below</text> : null}
      {descendants.length > ROW ? <text className="lg-w" x={W - 8} y={H - 4} textAnchor="end">+{descendants.length - ROW} more below</text> : null}
      {ghost}
      <g
        className="lg-centre"
        role="button"
        tabIndex={0}
        aria-label={ring ? 'close the action ring' : 'open the action ring'}
        aria-expanded={ring}
        onClick={onRing}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onRing();
          }
        }}
      >
        <polygon className="lg-hexbody" points={hexPoints(CX, CY, R)} />
        <text className="lg-t lg-ct" x={CX} y={CY - 4} textAnchor="middle">{short(nodeTitle(node), 16)}</text>
        <text className="lg-w" x={CX} y={CY + 12} textAnchor="middle">{ring ? 'press to close' : node.version ? `v${node.version} · press` : 'press'}</text>
      </g>
      <g className={`lg-ring${ring ? ' open' : ''}`} aria-hidden={!ring}>
        {COMPASS.map((c) => {
          const lx = CX + 104 * Math.cos(rad(c.angle)), ly = CY + 104 * Math.sin(rad(c.angle));
          return (
            <g
              key={c.key}
              className={`lg-wedge${preview === c.key ? ' on' : ''}${handlers[c.key]?.run ? '' : ' off'}`}
              role="button"
              tabIndex={ring ? 0 : -1}
              aria-label={c.label}
              data-wedge={c.key}
              onPointerEnter={hover(c.key)}
              onPointerDown={() => down(c.key)}
              onFocus={() => onPreview(c.key)}
              onClick={() => press(c.key)}
              onKeyDown={keyed(c.key)}
            >
              <path className={`f-${c.rel}`} d={wedge(c.angle, R + 8, 152)} />
              <text x={lx} y={ly + 4} textAnchor="middle">{c.label}</text>
            </g>
          );
        })}
      </g>
      {!ring
        ? COMPASS.map((c) => {
            const [x, y] = vpos(c.angle);
            const lx = CX + (R + 16) * Math.cos(rad(c.angle)), ly = CY + (R + 16) * Math.sin(rad(c.angle));
            const cos = Math.cos(rad(c.angle));
            const anchor = Math.abs(cos) < 0.1 ? 'middle' : cos > 0 ? 'start' : 'end';
            // The label is part of the target: a tap on the words counts.
            const lw = c.label.length * 6.2 + 6;
            const hx = anchor === 'start' ? lx - 4 : anchor === 'end' ? lx - lw + 2 : lx - lw / 2;
            return (
              <g
                key={c.key}
                className={`lg-vtx${preview === c.key ? ' on' : ''}${handlers[c.key]?.run ? '' : ' off'}`}
                role="button"
                tabIndex={0}
                aria-label={c.label}
                data-vertex={c.key}
              onPointerEnter={hover(c.key)}
              onPointerDown={() => down(c.key)}
              onFocus={() => onPreview(c.key)}
              onClick={() => press(c.key)}
              onKeyDown={keyed(c.key)}
              >
                {labels ? (
                  // One target box over the dot and its words, so the whole box is hittable.
                  <rect
                    x={Math.min(x - 17, hx)}
                    y={Math.min(y - 17, ly - 10)}
                    width={Math.max(x + 17, hx + lw) - Math.min(x - 17, hx)}
                    height={Math.max(y + 17, ly + 10) - Math.min(y - 17, ly - 10)}
                    fill="transparent"
                  />
                ) : (
                  <circle cx={x} cy={y} r="17" fill="transparent" />
                )}
                <circle className={`lg-dot f-${c.rel}`} cx={x} cy={y} r="8" />
                {labels ? (
                  <text className="lg-vlabel" x={lx} y={ly + 4} textAnchor={anchor}>{c.label}</text>
                ) : null}
              </g>
            );
          })
        : null}
    </svg>
  );
}

/* ---------------- the sheet ---------------- */

export interface Centre {
  id: string;
  sub?: string;
  origin?: string;
}

async function loadLineage(client: BlyggerClient, centre: Centre): Promise<Lineage> {
  return unwrap(BlyggerApi.extLineageGlyphGetLineage({ client, query: centre }));
}
function Failure({ error }: { error: unknown }) {
  return error ? (
    <p className="error-banner" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  ) : null;
}

function NodeList({ title, nodes, up, onOpen }: { title: string; nodes: LineageNode[]; up: boolean; onOpen: (n: LineageNode) => void }) {
  if (!nodes.length) return null;
  return (
    <details className="lg-list" open={nodes.length > ROW}>
      <summary>{title} · {nodes.length}</summary>
      <ul>
        {nodes.map((n, i) => {
          const rel = relOf(n.relation, n.partial);
          return (
            <li key={i}>
              <span className={`lg-pip f-${rel}`} aria-hidden="true" />
              {n.id && n.origin ? (
                <button type="button" className="lg-link" onClick={() => onOpen(n)}>{nodeTitle(n)}</button>
              ) : n.url ? (
                <a href={n.url} target="_blank" rel="noreferrer">{nodeTitle(n)}</a>
              ) : (
                <span>{nodeTitle(n)}</span>
              )}
              <span className="lg-meta">
                {' '}· {n.held === 'own' ? 'you' : n.source ?? 'unknown blyg'} · {relationWord(n, up)}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/**
 * The hex view in a sheet. `handlersFor` supplies what each action does for
 * whichever node is centred — the opening entry gets the full set, a node
 * re-centred on gets what its being held here allows.
 */
export function LineageSheet({
  onClose,
  start,
  client,
  handlersFor,
}: {
  onClose: () => void;
  start: Centre;
  client: BlyggerClient;
  handlersFor: (node: Lineage['node'], isStart: boolean) => Handlers;
}) {
  const [trail, setTrail] = useState<Centre[]>([start]);
  const [lineage, setLineage] = useState<Lineage>();
  const [error, setError] = useState<unknown>();
  const [preview, setPreview] = useState<ActionKey | null>(null);
  const [ring, setRing] = useState(false);
  const [labels, setLabels] = useState(true);
  const centre = trail[trail.length - 1];
  const isStart = trail.length === 1;
  useEffect(() => {
    let live = true;
    setLineage(undefined);
    setError(undefined);
    loadLineage(client, centre).then(
      (got) => live && setLineage(got),
      (failure) => live && setError(failure),
    );
    return () => {
      live = false;
    };
  }, [client, centre.id, centre.sub, centre.origin]);
  const handlers = lineage ? handlersFor(lineage.node, isStart) : {};
  const commit = (key: ActionKey) => {
    const run = handlers[key]?.run;
    if (!run) return setPreview(key);
    onClose();
    run();
  };
  const recentre = (node: LineageNode) => {
    if (!node.id || !node.origin) return;
    setPreview(null);
    setRing(false);
    setTrail((t) => [...t, node.sub ? { id: node.id!, sub: node.sub } : { id: node.id!, origin: node.origin! }]);
  };
  const title = lineage ? nodeTitle(lineage.node) : '';
  return (
    <Sheet open onClose={onClose} title="lineage" className="lineage-sheet">
      <div className="lg-top">
        {!isStart ? (
          <Button className="btn btn-ghost btn-mini" onClick={() => setTrail((t) => t.slice(0, -1))}>
            ← back
          </Button>
        ) : null}
        <span className="lg-crumb">{lineage ? `${lineage.node.held === 'own' ? 'you' : lineage.node.source ?? 'unknown blyg'} · ${short(title, 40)}` : 'loading…'}</span>
        <label className="lg-toggle">
          <input type="checkbox" checked={labels} onChange={(event) => setLabels(event.target.checked)} /> labels
        </label>
      </div>
      {error ? <Failure error={error} /> : null}
      {lineage ? (
        <div className="lg-cols">
          <div className="lg-stage">
            <HexGraph
              lineage={lineage}
              preview={preview}
              ring={ring}
              labels={labels}
              handlers={handlers}
              onPreview={setPreview}
              onCommit={commit}
              onRing={() => setRing((r) => !r)}
              onOpen={recentre}
            />
            <NodeList title="where it came from" nodes={lineage.ancestors} up onOpen={recentre} />
            <NodeList title="what came from it — known here" nodes={lineage.descendants} up={false} onOpen={recentre} />
          </div>
          {/* Pinned to the sheet's bottom edge on a phone, so the sketch plays beside the graph. */}
          <div className="lg-explain-wrap">
            <Explain action={preview} handler={preview ? handlers[preview] : undefined} title={title} onDo={() => preview && commit(preview)} />
          </div>
        </div>
      ) : null}
      <div className="lg-foot">
        <Sheet.Close className="btn btn-ghost btn-mini">close</Sheet.Close>
      </div>
    </Sheet>
  );
}
