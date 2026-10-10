// Transclusion grammar & publish-time resolution — v0.1-plan §2.9. Grammar is
// locked protocol surface: do not modify without Fable + Venkat.

import { attachedQuote } from "./directives.ts";
import { codeRanges, htmlCodeRanges, inRanges, lineOffsets, type Range } from "./code-ranges.ts";
import { sanitizeHtml } from "./importer/sanitize.ts";
import { blygItemUrl } from "./importer/util.ts";
import { excerptFromHtml, renderMarkdown, selectionText } from "./markdown.ts";
import type { ImportedItemRow, ItemRow, TextQuoteSelector, Transclusion, VersionRow } from "./types.ts";
import { absolutizeHtml, escapeHtml, ID_ALPHABET } from "./util.ts";

const DIRECTIVE_LINE = new RegExp(`^\\s*!\\[\\[([${ID_ALPHABET}]{26})\\]\\]\\s*$`);
const RESERVED_LINE = new RegExp(`^\\s*!\\[\\[([${ID_ALPHABET}]{26})@v\\d+\\]\\]\\s*$`);

/**
 * `[[id]]` — a plain internal link (0.3 §16.2, decision #32). Deliberately in
 * this file and directly under the two regexes above: it is the same bracket
 * grammar one `!` apart, and the **negative lookbehind is what keeps them
 * apart**. A directive is a whole line and bakes a snapshot; a link is inline,
 * bakes nothing, and is silent on the wire — no `transclusions[]` entry, no
 * mention, no wire class.
 *
 * Inside code spans and code blocks both forms are inert text (§10.1,
 * decision #54; studio#4), found by `codeRanges` with the renderer's own
 * parser. Inside another anchor a link renders as text only (studio#13) —
 * see `applyInternalLinks`.
 */
const LINK_INLINE = new RegExp(`(?<!!)\\[\\[([${ID_ALPHABET}]{26})\\]\\]`, "g");

/**
 * A markdown blockquote line. A directive immediately followed — **no blank
 * line** — by a run of these is a *partial* transclusion, and the run's text is
 * the selection (spec §16.4, decision #49).
 *
 * A blank line detaches, which is the whole reason the grammar is adjacency
 * rather than a new sigil: a whole transclusion followed by the author's own
 * block quotation has always been writable, and must stay writable. The run
 * ends at the first line that is not a quote line; a line that is empty after
 * its marker is a paragraph break *inside* the selection.
 */


/** How much context either side of the match to record — §16.4 says short. */
const SELECTOR_CONTEXT = 32;

/**
 * The run of `>` lines attached to the directive at `i`, and where the caller
 * should resume. `lines[i]` is the directive itself.
 */


/**
 * The selection a quote run denotes: its markdown rendered, then normalized by
 * the one normalizer (§7.3 P2). Rendering first is what makes the two sides
 * comparable — the target is stored as HTML, so the quote has to become HTML
 * by the same route before either is flattened.
 */
export function selectionFromQuote(quoteMd: string): string {
  return selectionText(renderMarkdown(quoteMd));
}

/**
 * Locate the selection in the target's text and describe where it was found.
 * `null` when it is not there, which is a publish error exactly as an
 * unresolvable directive is (§16.4 Faithfulness).
 *
 * Context comes from the **first** match. A passage that occurs twice gets the
 * first one's neighbours, which is arbitrary but deterministic — and `prefix`/
 * `suffix` are a relocation hint for readers, never part of the check.
 */
export function locateSelection(targetHtml: string, selection: string): TextQuoteSelector | null {
  const hay = selectionText(targetHtml);
  const at = hay.indexOf(selection);
  if (at < 0) return null;
  const prefix = hay.slice(Math.max(0, at - SELECTOR_CONTEXT), at);
  const suffix = hay.slice(at + selection.length, at + selection.length + SELECTOR_CONTEXT);
  return {
    exact: selection,
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
  };
}

/**
 * U+E003 — the next Private Use Area sentinel after tk.ts's E000–E002, and used
 * the same way: substitute before rendering, splice after. A link's anchor text
 * is arbitrary prose, so emitting markdown (`[label](url)`) instead would mean
 * escaping label and URL into two different grammars and hoping.
 */
const LINK_SENTINEL = String.fromCharCode(0xe003);

/**
 * Never reset, so that the maps from two resolver calls over one document — the
 * body, and each independently-rendered generated block — can be merged without
 * a token from one shadowing a token from the other.
 */
let linkTokenSeq = 0;

export interface TransclusionRefError {
  directive: string;
  reason: string;
}

/**
 * Count and remove own-line `![[id]]` directives from a working copy —
 * for studio previews of unpublished drafts, which have no rendered HTML to
 * derive from yet. Lives here so the directive grammar has exactly one
 * regex: a private copy in preview.ts would be the same duplicated-detector
 * drift that bit resolve.ts vs feed.ts in session 16.
 */
export { extractDirectives } from "./directives.ts";

export interface ResolveResult {
  html: string;
  transclusions: Transclusion[];
  errors: TransclusionRefError[];
}

/** Thrown by publish() when one or more `![[id]]` directives don't resolve. */
export class TransclusionResolveError extends Error {
  constructor(public readonly errors: TransclusionRefError[]) {
    super("transclusion resolution failed");
  }
}

/** A resolved transclusion target: the bytes to bake plus the provenance to record. */
export interface ResolvedTarget {
  id: string;
  version: number;
  contentHtml: string;
  /**
   * The target's markdown as held here: our own version's, or the imported
   * row's (empty when the origin's feed carried none). A TK scope feeds a
   * generator from this (decision #44); baking never reads it.
   */
  contentMd: string;
  /** Identity origin for a remote (imported) source; omitted for own-origin — decision #26. */
  origin?: string;
  /** Authored kind, for callers that need the target's page URL rather than its bytes. */
  kind: string;
  /** A remote target's own declared `page`, when it gave one (§16.2: origin + page). */
  page?: string | null;
}

/**
 * Every local thread id reachable from `startId` by walking stored
 * `transclusions[]`, following **local** entries only (a remote entry's
 * closure is unknowable in general, and harmless: it is static bytes we
 * already hold). Bounded by the visited set, so a pre-existing cycle in
 * stored data can't spin here.
 */
async function localClosure(db: D1Database, startId: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = await db
      .prepare("SELECT v.transclusions AS t FROM items i JOIN versions v ON v.item_id = i.id AND v.version = i.version WHERE i.id = ?")
      .bind(id)
      .first<{ t: string | null }>();
    if (!row?.t) continue;
    for (const entry of JSON.parse(row.t) as Transclusion[]) {
      if (entry.origin) continue; // remote: not walked (decision #26)
      if (!seen.has(entry.id)) queue.push(entry.id);
    }
  }
  return seen;
}

/**
 * Resolve an own-line `![[id]]` directive to the snapshot that gets baked —
 * v0.3-plan §2.1, decision #26. Order: local published item of **any** kind
 * (nesting arrives here), then an imported non-L0 blyg item by `remote_id`,
 * then an error. The directive names an *identity*, not an origin, which is
 * why more than one imported match is a publish error rather than a guess.
 *
 * What gets baked is always the **local snapshot** — never a live fetch. That
 * is what makes publish network-independent and network cycles harmless: a
 * snapshot is static bytes, so no resolution recurses through it.
 *
 * `selfId` is the publishing thread, for the local DAG check: a thread may not
 * transclude itself, or a local thread whose transitive local closure contains
 * it. Remote closures are not walked.
 */
export async function resolveTarget(
  db: D1Database,
  id: string,
  selfId?: string,
): Promise<{ ok: true; target: ResolvedTarget } | { ok: false; reason: string }> {
  const item = await db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<ItemRow>();
  if (item) {
    if (item.status === "draft") return { ok: false, reason: "item is a draft, not published" };
    if (item.kind === "withdrawn") return { ok: false, reason: "item is withdrawn" };
    const version = await db
      .prepare("SELECT * FROM versions WHERE item_id = ? AND version = ?")
      .bind(item.id, item.version)
      .first<VersionRow>();
    if (!version) return { ok: false, reason: "unknown item" };
    if (selfId && item.kind === "thread") {
      if (item.id === selfId) return { ok: false, reason: "a thread cannot transclude itself" };
      if ((await localClosure(db, item.id)).has(selfId)) {
        return { ok: false, reason: "circular transclusion: that thread already quotes this one" };
      }
    }
    return { ok: true, target: { id: item.id, version: version.version, contentHtml: version.content_html, contentMd: version.content_md, kind: item.kind } };
  }

  // Imported: identity is the subscription's own origin (0.2 §12.2 — the
  // post-redirect fetch origin), never the manifest's self-asserted `site`.
  const rows = await db
    .prepare(
      `SELECT ii.*, s.origin AS sub_origin
       FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id
       WHERE ii.remote_id = ?`,
    )
    .bind(id)
    .all<ImportedItemRow & { sub_origin: string }>();
  const candidates = rows.results.filter((r) => r.l0 !== 1);
  const usable = candidates.filter((r) => r.state === "current" || r.pinned_version_retained !== null);
  if (usable.length > 1) return { ok: false, reason: "ambiguous id: imported from more than one origin" };
  if (usable.length === 1) {
    const row = usable[0];
    // A retained tombstone's bytes are the *pinned* version's — 0.2 §13.4's
    // retention rule — so that, not the withdrawal version, is the provenance.
    const version = row.state === "tombstone" ? (row.pinned_version_retained as number) : row.version;
    // Resolved against the *source's* origin before baking, so the publisher's
    // own absolutizing pass (publish(), session 30) finds nothing relative to
    // re-point at us. Covers rows imported before the importer did this itself.
    const contentHtml = absolutizeHtml(row.content_html, row.sub_origin);
    return { ok: true, target: { id, version, contentHtml, contentMd: row.content_md, origin: row.sub_origin, kind: row.kind, page: row.page } };
  }
  if (candidates.length) return { ok: false, reason: "source withdrawn by origin" };
  if (rows.results.length) return { ok: false, reason: "source is a plain RSS (L0) item, not a blyg item" };
  return { ok: false, reason: "unknown item" };
}

/**
 * Shared line-walker for both publish-time resolution and studio preview.
 * `onError` decides what (if anything) renders in place of a directive that
 * fails to resolve — the strict resolver omits it (publish aborts anyway);
 * the preview variant renders a visible placeholder.
 */
async function walk(
  db: D1Database,
  contentMd: string,
  onError: (err: TransclusionRefError) => string | null,
  selfId?: string,
): Promise<ResolveResult> {
  const errors: TransclusionRefError[] = [];
  const transclusions: Transclusion[] = [];
  const htmlParts: string[] = [];
  let prose: string[] = [];

  const flushProse = () => {
    if (prose.length) {
      htmlParts.push(renderMarkdown(prose.join("\n")));
      prose = [];
    }
  };
  const fail = (err: TransclusionRefError) => {
    errors.push(err);
    const placeholder = onError(err);
    if (placeholder) htmlParts.push(placeholder);
  };

  const lines = contentMd.split("\n");
  // Lines inside code are prose (§10.1, #54; studio#4). A directive left on
  // its own line in TK *output* is, provisionally, a real transclusion: Venkat
  // took the session-33 Fable reading (v0.4-plan §9.2) over studio#5's, pending
  // Fable reconciling it with decision #20.
  const inert = codeRanges(contentMd);
  const starts = lineOffsets(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inRanges(inert, starts[i])) {
      prose.push(line);
      continue;
    }
    const reserved = RESERVED_LINE.exec(line);
    if (reserved) {
      flushProse();
      fail({ directive: line.trim(), reason: "explicit-version references (@vN) are reserved, not supported in v0.1" });
      continue;
    }
    const m = DIRECTIVE_LINE.exec(line);
    if (!m) {
      prose.push(line);
      continue;
    }
    flushProse();
    const id = m[1];
    // Look ahead before resolving: the quote is part of the directive whether
    // or not the target turns out to exist, so a failed resolve must still
    // consume it rather than leave it to render as the author's own quotation.
    const { quoteMd, next } = attachedQuote(lines, i);
    i = next - 1;
    const resolved = await resolveTarget(db, id, selfId);
    if (!resolved.ok) {
      fail({ directive: line.trim(), reason: resolved.reason });
      continue;
    }
    const { target } = resolved;

    // ── Partial (§16.4): the quote must actually be in the target ──────────
    let selector: TextQuoteSelector | null = null;
    if (quoteMd !== null) {
      const selection = selectionFromQuote(quoteMd);
      if (!selection) {
        fail({ directive: line.trim(), reason: "the attached blockquote is empty" });
        continue;
      }
      selector = locateSelection(target.contentHtml, selection);
      if (!selector) {
        fail({
          directive: line.trim(),
          reason: `quoted passage not found in the target's version ${target.version}`,
        });
        continue;
      }
    }

    transclusions.push({
      id: target.id,
      version: target.version,
      ...(target.origin ? { origin: target.origin } : {}),
      ...(selector ? { selector } : {}),
    });
    // data-blyg-origin appears only for remote sources, so a baked own-origin
    // blockquote is byte-identical to the 0.2 shape (decision #26).
    const originAttr = target.origin ? ` data-blyg-origin="${escapeHtml(target.origin)}"` : "";
    if (selector) {
      // P4, a build call recorded in v0.4-plan §7.3 in advance: the bake is the
      // selection's **plain text** in paragraphs, not a carved sub-range of the
      // source's inline HTML. The selection is defined on text, and cutting an
      // HTML range faithfully — reopening the tags a cut crosses — is a second
      // project with its own failure modes. The class pair is what discloses
      // that this is a part rather than the whole.
      const body = selector.exact
        .split("\n")
        .map((para) => `<p>${escapeHtml(para)}</p>`)
        .join("\n");
      htmlParts.push(
        `<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="${target.id}" data-blyg-version="${target.version}"${originAttr}>\n${body}\n</blockquote>`,
      );
    } else {
      htmlParts.push(
        `<blockquote class="blyg-transclusion" data-blyg-id="${target.id}" data-blyg-version="${target.version}"${originAttr}>\n${target.contentHtml}\n</blockquote>`,
      );
    }
  }
  flushProse();
  return { html: htmlParts.join("\n"), transclusions, errors };
}

/**
 * Resolve every `![[id]]` directive in a thread's markdown against the local
 * snapshots currently available — published local items of either kind, or
 * imported blyg items (v0.3 §2.1) — baking each target's HTML into a
 * `blockquote.blyg-transclusion` snapshot (§2.9). Readers never resolve
 * anything — this runs only at publish time, called from model.publish().
 * `selfId` is the publishing thread's own id, for the local DAG check.
 */
export async function resolveTransclusions(db: D1Database, contentMd: string, selfId?: string): Promise<ResolveResult> {
  return walk(db, contentMd, () => null, selfId);
}

/**
 * Studio-only preview variant — never aborts; an unresolvable directive
 * renders as a visible red placeholder so the editor can show exactly what
 * publish will reject, before the author hits publish. Not used at publish
 * time (see resolveTransclusions above); not a protocol surface.
 */
export async function previewTransclusions(db: D1Database, contentMd: string, selfId?: string): Promise<ResolveResult> {
  const result = await walk(
    db,
    contentMd,
    (err) => `<blockquote class="blyg-transclusion unresolved"><p>⚠ unresolvable: ${escapeHtml(err.reason)}</p></blockquote>`,
    selfId,
  );
  // Publish bakes the target's HTML verbatim (§5.2, §10.2), so the walk does
  // not sanitize. The preview is displayed in the owner's studio, and every
  // display sanitizes at render, as the public pages do with the baked thread.
  return { ...result, html: await sanitizeHtml(result.html) };
}

// --- `[[id]]` plain internal links (§16.2, decision #32) ---

export interface InternalLinkDocument {
  /** Markdown with each `[[id]]` replaced by a sentinel token, ready to render. */
  text: string;
  /** Token -> the anchor HTML that replaces it after rendering. */
  replacements: Map<string, string>;
  /**
   * Token -> what it becomes where an anchor cannot go (studio#13): `text` (the
   * anchor's label, escaped) inside another link's text; `literal` (the
   * author's `[[id]]`) inside a tag, a URL or code.
   */
  labels: Map<string, { text: string; literal: string }>;
  errors: TransclusionRefError[];
}

/**
 * The anchor's text. Items are titleless by design (§5.3), so an id would be
 * the one label guaranteed to mean nothing to a reader. When the target opens
 * with a heading (a thread's markdown H1 is its title by convention) that
 * heading is the label, as plain text; otherwise this uses a short excerpt of
 * the target in quotes, which reads as a citation inside running prose.
 * Presentation, and ours to choose (§16.2); it is frozen into `content_html`
 * at publish like every other rendered thing.
 */
function anchorText(target: ResolvedTarget): string {
  const heading = /^\s*<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(target.contentHtml);
  const title = heading ? excerptFromHtml(heading[1], 80) : "";
  if (title) return title;
  const excerpt = excerptFromHtml(target.contentHtml, 60);
  return excerpt ? `“${excerpt}”` : `${target.kind === "thread" ? "a thread" : "a fragment"}`;
}

/**
 * Resolve every inline `[[id]]` in `contentMd`.
 *
 * Resolution is **literally the directive's** — `resolveTarget`, the #26 order:
 * a published local item of either kind, then an imported non-L0 blyg item,
 * then an error. One implementation on purpose; §16.2 says "by the same order",
 * and a second copy of that rule would be free to drift from it.
 *
 * Two deliberate differences from a directive, both because a link bakes
 * nothing:
 *  - **no `selfId`**, so no DAG check — the cycle rules exist to stop a
 *    snapshot from containing itself, and a link cannot.
 *  - **no `transclusions[]` entry and no mention.** Mentions are derived from
 *    references, and a link is not one: it asserts nothing on the target's
 *    behalf, so the target has nothing to verify (§16.2).
 *
 * `ourOrigin` must be absolute: `content_html` travels to subscribers, where a
 * relative href would resolve against *their* origin and point at nothing.
 */
export async function resolveInternalLinks(
  db: D1Database,
  contentMd: string,
  ourOrigin: string,
  onError: (err: TransclusionRefError) => string | null = () => null,
  inert: (text: string) => Range[] = codeRanges,
): Promise<InternalLinkDocument> {
  const errors: TransclusionRefError[] = [];
  const replacements = new Map<string, string>();
  const labels = new Map<string, { text: string; literal: string }>();
  let out = "";
  let last = 0;

  const code = inert(contentMd);
  for (const m of contentMd.matchAll(LINK_INLINE)) {
    const at = m.index ?? 0;
    if (inRanges(code, at)) continue; // inert inside code (§10.1, #54)
    out += contentMd.slice(last, at);
    last = at + m[0].length;
    const id = m[1];
    const resolved = await resolveTarget(db, id);
    if (!resolved.ok) {
      const err = { directive: m[0], reason: resolved.reason };
      errors.push(err);
      const placeholder = onError(err);
      if (placeholder !== null) {
        const token = `${LINK_SENTINEL}${linkTokenSeq++}${LINK_SENTINEL}`;
        replacements.set(token, placeholder);
        labels.set(token, { text: escapeHtml(m[0]), literal: m[0] });
        out += token;
      }
      continue;
    }
    const { target } = resolved;
    const href = target.origin
      ? blygItemUrl(target.origin, target.kind, target.id, target.page)
      : blygItemUrl(ourOrigin, target.kind, target.id, null);
    const token = `${LINK_SENTINEL}${linkTokenSeq++}${LINK_SENTINEL}`;
    replacements.set(token, `<a href="${escapeHtml(href)}">${escapeHtml(anchorText(target))}</a>`);
    labels.set(token, { text: escapeHtml(anchorText(target)), literal: m[0] });
    out += token;
  }
  out += contentMd.slice(last);
  return { text: out, replacements, labels, errors };
}

const ENCODED_SENTINEL = encodeURIComponent(LINK_SENTINEL);
const ENCODED_TOKEN = new RegExp(`${ENCODED_SENTINEL}(\\d+)${ENCODED_SENTINEL}`, "g");

/**
 * Splice resolved anchors into already-rendered HTML — the tk.ts mechanism —
 * but only where an anchor is valid (studio#13). Markdown can put a token in
 * places an `<a>` must not go:
 *
 * - **inside another link's text** (`[see [[id]]](url)`): nesting anchors is
 *   invalid HTML that browsers split, so the label goes in as text;
 * - **inside a URL** (`<https://x/[[id]]>`, or a bare URL that linkify takes):
 *   the renderer percent-encodes the sentinel into the href, so the author's
 *   `[[id]]` goes back, and the visible URL text keeps it literally too;
 * - **inside a tag** (an image's alt text) or **inside `<code>`**: literal.
 *
 * No sentinel character survives in any case.
 */
export function applyInternalLinks(html: string, doc: InternalLinkDocument): string {
  const label = (seq: string) => doc.labels.get(`${LINK_SENTINEL}${seq}${LINK_SENTINEL}`);
  // 1. Tokens percent-encoded into attribute values: the author's literal, encoded the way the URL around it was.
  let out = html.replace(ENCODED_TOKEN, (whole, seq: string) => {
    const l = label(seq);
    return l ? encodeURI(l.literal) : whole;
  });
  // 2. Walk tags and text, tracking whether we are inside an anchor or code.
  const parts = out.split(/(<[^>]*>)/);
  let inAnchor = 0, inCode = 0, anchorTag = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.includes(LINK_SENTINEL)) {
      if (/^<a[\s>]/i.test(part)) { inAnchor++; anchorTag = part; }
      else if (/^<\/a>/i.test(part)) inAnchor = Math.max(0, inAnchor - 1);
      else if (/^<code[\s>]/i.test(part)) inCode++;
      else if (/^<\/code>/i.test(part)) inCode = Math.max(0, inCode - 1);
      continue;
    }
    const isTag = part.startsWith("<");
    parts[i] = part.replace(new RegExp(`${LINK_SENTINEL}(\\d+)${LINK_SENTINEL}`, "g"), (whole, seq: string) => {
      const token = `${LINK_SENTINEL}${seq}${LINK_SENTINEL}`;
      const l = label(seq);
      if (!l) return whole;
      if (isTag) return escapeHtml(l.literal);
      if (inCode) return escapeHtml(l.literal);
      // An autolink's text is its URL: keep it reading as the URL it links to.
      if (inAnchor) return anchorTag.includes(encodeURI(l.literal)) ? escapeHtml(l.literal) : l.text;
      return doc.replacements.get(token) ?? whole;
    });
    if (isTag && /^<a[\s>]/i.test(part)) { inAnchor++; anchorTag = parts[i]; }
  }
  return parts.join("");
}

/**
 * Resolve `[[id]]` inside each independently rendered generated block (a TK
 * block span is lifted out of the body and rendered on its own, so the body's
 * pass never sees it). Publish and preview both call this, so the preview shows
 * the links readers will get, and an unresolvable one is an error in both
 * places (studio#14). The input is rendered HTML, so code is `<code>`.
 */
export async function resolveBlockLinks(
  blocks: Map<string, string>,
  resolve: (html: string) => Promise<InternalLinkDocument>,
): Promise<{ docs: InternalLinkDocument[]; errors: TransclusionRefError[] }> {
  const docs: InternalLinkDocument[] = [];
  const errors: TransclusionRefError[] = [];
  for (const [token, blockHtml] of blocks) {
    const doc = await resolve(blockHtml);
    if (doc.replacements.size || doc.errors.length) {
      blocks.set(token, doc.text);
      errors.push(...doc.errors);
      docs.push(doc);
    }
  }
  return { docs, errors };
}

/**
 * Preview variant: an unresolvable link renders visibly instead of aborting, so
 * the composer shows what publish will reject before the author hits publish —
 * the same contract as `previewTransclusions`.
 */
export async function previewInternalLinks(db: D1Database, contentMd: string, ourOrigin: string, html = false): Promise<InternalLinkDocument> {
  return resolveInternalLinks(
    db,
    contentMd,
    ourOrigin,
    (err) => `<span class="blyg-link-unresolved" style="color:#b3412b">⚠ ${escapeHtml(err.reason)}</span>`,
    html ? htmlCodeRanges : codeRanges,
  );
}
