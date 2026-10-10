// Public server-rendered pages — v0.1-plan §3.4. Rewired session 4 to the
// rev-2/rev-3 wireframe conventions reviewed with Venkat (docs/wireframes/):
// embeddable `.blyg`-scoped block with a bare Home+RSS header (the public
// page's header is presumed content, not real navigation — unlike studio's),
// Created/Most-recent timestamp lines, a version-nav scrubber, and a plain
// "Permalink" text link (dropping the ∞ glyph). Task 8 originally shipped
// against the rev-1 mockup; this brings it forward together with threads.

import { listBlogrollSubscriptions, listPublicHoppers } from "./importer/store.ts";
import { listPublicResponses } from "./mentions/store.ts";
import { sanitizeHtml } from "./importer/sanitize.ts";
import { blygItemUrl } from "./importer/util.ts";
import { parseStoredCite, parseStoredFork, parseStoredStub } from "./stub.ts";
import { excerptFromHtml } from "./markdown.ts";
import { clampText, leadingHeading, stripTransclusionQuotes } from "./preview.ts";
import { authoredKind, getMedia, itemShowsResponses, listMediaForItem, publishedVersion } from "./model.ts";
import type { ItemRow, MediaRow, Settings, SubscriptionRow, Transclusion, VersionRow } from "./types.ts";
import { loadFeedData, sourceKey, type FeedCardData, type FeedProvenance, type FeedItem } from "./public-feed.ts";
import { WEBMENTION_PATH } from "./types.ts";
import { escapeHtml, escapeHref, formatDateIn, unplacedMedia, visibleMedia } from "./util.ts";
import { graphemePrefix } from "./text.ts";
import { EMBED_CSS, EMBED_SCRIPT } from "./embeds.ts";


/**
 * Reading themes (session 19). A theme repaints two surfaces: the page behind
 * everything (`--page`, the margins) and the block the writing sits in
 * (`--paper`). When they differ the block reads as a sheet on a desk, which is
 * the point of offering the pair rather than one background colour.
 *
 * These are borrowed, not invented. Solarized and Nord are published palettes
 * with worked-out contrast; the cream is the warm-paper value long-form
 * readers converged on. A palette someone else already balanced beats one I
 * mix here, and each is named so an author can look up what they are choosing.
 *
 * `auto` is the default and is not a theme: it means "follow the reader's
 * system preference", which is the only setting that respects a choice the
 * *reader* made rather than one the author made for them.
 *
 * Public pages only. The studio keeps its own light/dark — it is a tool, and
 * a tool that repaints itself when you change your site's colours is a
 * surprise, not a feature.
 */
import { THEMES } from "./themes.ts";
export { THEMES, type Theme } from "./themes.ts";

export function themeCss(name: string): string {
  const t = THEMES[name];
  if (!t) return "";
  // Padding only when the two surfaces differ: on a theme where they match,
  // padding the block would draw a card edge around nothing.
  const pad = t.page === t.paper ? "0rem" : "2rem";
  const vars = `  color-scheme: ${t.dark ? "dark" : "light"};
  --block-pad: ${pad};
  --page: ${t.page};
  --paper: ${t.paper};
  --paper-sunk: ${t.dark ? t.page : t.rule};
  --ink: ${t.ink};
  --ink-soft: ${t.inkSoft};
  --rule: ${t.rule};
  --pencil: ${t.pencil};
  --gen-bg: ${t.genBg};
  --gen-rule: ${t.genRule};`;
  return `
/* theme: ${t.label} — author-chosen, so it overrides the reader's light/dark
   preference rather than being overridden by it. */
:root {
${vars}
}
@media (prefers-color-scheme: dark) {
  :root {
${vars}
  }
}
`;
}

/** Lucide's "bot" icon (ISC licence), used only as a mask, so its stroke colour is irrelevant. Declared before STYLE_CSS,
 * which calls generatedHighlightRules while the module loads. */
const ROBOT = `url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22black%22 stroke-width=%221.8%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M12 8V4H8%22/%3E%3Crect width=%2216%22 height=%2212%22 x=%224%22 y=%228%22 rx=%222%22/%3E%3Cpath d=%22M2 14h2M20 14h2M15 13v2M9 13v2%22/%3E%3C/svg%3E")`;

export const STYLE_CSS = `/* blyg — one hand-written stylesheet, no build step, no web fonts.
 *
 * The design idea (session 19): **the editorial apparatus is the design.**
 * What distinguishes a blyg from a blog is that every item wears its own
 * revision history in public — "v2 · pinned: v1, v2", Created/Most-recent,
 * the provenance line under a transcluded quote, the endcap where a withdrawn
 * item used to be. All of that used to render as one undifferentiated grey
 * murmur (0.85rem, opacity 0.7). Here it gets its own typeface and its own
 * colour, consistently, so a reader can learn to read it; the prose gets a
 * serif and is otherwise left alone.
 *
 * The colour that carries it is an editor's blue pencil. To "blue-pencil" a
 * manuscript is to edit it — the same copy-desk world [TK] comes from — so
 * every editorial mark on the page is blue: pins, provenance, the rule beside
 * a transclusion, the kind marker. Prose is ink; nothing else competes.
 *
 * NO WEB FONTS, deliberately. A reference client for a decentralised medium
 * should not make every reader's page load phone a third-party font host;
 * self-hosted static files that depend on someone else's CDN are not really
 * self-hosted. System stacks only.
 */
:root {
  color-scheme: light dark;
  /* --page is the margins, --paper the block the writing sits in. They are
     the same colour until a theme separates them (see themeCss). */
  --page: #fafbfb;
  --paper: #fafbfb;
  --paper-sunk: #eef1f3;
  --ink: #1b2426;
  --ink-soft: #5c686b;
  --rule: #dde3e5;
  --pencil: #23608c;
  /* Highlighted generated spans: a tint and a hairline, quiet enough to read through. */
  --gen-bg: #eef3f7;
  --gen-rule: #c9d8e4;
  --block-pad: 0rem;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Charter, Georgia, "Times New Roman", serif;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  /* The apparatus layer: small sans, a little looser than the prose. */
  --apparatus: 0.8125rem/1.5 var(--sans);
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #14191a;
    --paper: #14191a;
    --paper-sunk: #1d2426;
    --ink: #e3e7e7;
    --ink-soft: #95a2a5;
    --rule: #2b3436;
    --pencil: #8cc0e4;
    --gen-bg: #1a2429;
    --gen-rule: #2f4552;
  }
}
* { box-sizing: border-box; }
/* Reserve the scrollbar's width on every page, scrolling or not. A short
   permalink beside a long feed page would otherwise sit ~7px further right,
   which is the same jump the shared masthead exists to remove. */
html { scrollbar-gutter: stable; }
body {
  background: var(--page);
  color: var(--ink);
  font-family: var(--serif);
  font-size: 1.0625rem;
  line-height: 1.65;
  margin: 0 auto;
  padding: 2rem 1.25rem 5rem;
  -webkit-text-size-adjust: 100%;
}
/* Also set on the block itself, so an embedded .blyg keeps its own type
 * inside a host page that never loads this file's body rule. */
/* The block keeps its 65ch measure whether or not a theme pads it away from
 * the page, so switching themes never reflows the text. */
.blyg {
  max-width: calc(65ch + 2 * var(--block-pad));
  margin: 0 auto;
  padding: var(--block-pad);
  background: var(--paper);
  border-radius: 3px;
  font-family: var(--serif);
  color: var(--ink);
}
.blyg a { color: var(--pencil); text-underline-offset: 0.15em; text-decoration-thickness: from-font; }
.blyg :focus-visible { outline: 2px solid var(--pencil); outline-offset: 2px; border-radius: 2px; }
::selection { background: color-mix(in srgb, var(--pencil) 22%, transparent); }

/* ---- header + masthead -------------------------------------------------
 * Two shapes for the same identity. Every page carries the quiet one-line
 * header (the blyg's name, which is also the way back to its index). The
 * feed page — the front door, and the only page not meant to be embedded —
 * carries the name at display size instead, so the header there drops the
 * name and keeps only the feed link. */
.blyg-header { margin-bottom: 1.75rem; display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
.blyg-header a { color: var(--ink-soft); text-decoration: none; font: var(--apparatus); }
.blyg-header a:hover { color: var(--pencil); text-decoration: underline; }
.blyg-header.bare { justify-content: flex-end; margin-bottom: 0.5rem; }

.masthead { display: flex; gap: 1rem; align-items: baseline; margin: 0 0 2.5rem; }
.masthead .avatar { border-radius: 50%; flex: none; object-fit: cover; align-self: flex-start; }
.masthead .masthead-text { min-width: 0; }
.masthead p { margin: 0; }
.masthead .site-name {
  font-family: var(--serif);
  font-size: clamp(1.75rem, 1.3rem + 2vw, 2.4rem);
  line-height: 1.12;
  letter-spacing: -0.015em;
  margin-bottom: 0.4rem;
}
.masthead .site-name a { color: var(--ink); text-decoration: none; }
.masthead .author-name { font: var(--apparatus); color: var(--ink); }
.masthead .author-bio { font: var(--apparatus); color: var(--ink-soft); max-width: 48ch; }
.masthead .author-links { font: var(--apparatus); margin-top: 0.35rem; }
.masthead .author-links a { color: var(--pencil); text-decoration: none; border-bottom: 1px solid var(--rule); }
.masthead .author-links a:hover { border-bottom-color: currentColor; }

/* ---- items -------------------------------------------------------------
 * Space separates items; the rule is a whisper, not a frame. Fragments are
 * atomic, so they get room to be read as separate things rather than rows. */
article.fragment, article.thread { border-top: 1px solid var(--rule); padding: 2rem 0 1.75rem; }
article.fragment:first-of-type, article.thread:first-of-type { border-top: none; padding-top: 0; }
article.fragment img, article.thread img { max-width: 100%; height: auto; border-radius: 2px; }
article.fragment > :first-child, article.thread > :first-child { margin-top: 0; }
/* …and since session 19 that first child is the .item-content wrapper, so the
 * rule has to reach one level further in to actually reach the prose. */
.item-content > :first-child { margin-top: 0; }
.blyg h1, .blyg h2, .blyg h3 { line-height: 1.2; letter-spacing: -0.01em; margin: 1.6em 0 0.5em; }
.blyg h1 { font-size: 1.5rem; }
.blyg h2 { font-size: 1.25rem; }
.blyg h3 { font-size: 1.0625rem; }
.blyg code, .blyg pre { font-size: 0.9em; }
.blyg pre { background: var(--paper-sunk); padding: 0.85rem 1rem; border-radius: 3px; overflow-x: auto; }
.blyg hr { border: none; border-top: 1px solid var(--rule); margin: 2rem 0; }

/* ---- the apparatus -----------------------------------------------------
 * Everything below is metadata about a document rather than the document:
 * one face, one size, one colour, so it reads as a single layer. */
.timestamps, .version-line, .version-note, a.permalink, .provenance, ul.archive .meta, .pinned-banner {
  font: var(--apparatus);
  color: var(--ink-soft);
}
.timestamps { margin-top: 0.3rem; display: flex; flex-direction: column; gap: 0.05rem; }
.version-line { margin-top: 1.3rem; }
.version-line .pins a { color: var(--pencil); text-decoration: none; border-bottom: 1px solid var(--rule); }
.version-line .pins a:hover { border-bottom-color: currentColor; }
.version-note { font-style: italic; margin: 0.4rem 0 0; max-width: 52ch; }
p.permalink, p > a.permalink { margin-top: 0.3rem; }
a.permalink { color: var(--ink-soft); text-decoration: none; border-bottom: 1px solid var(--rule); }
a.permalink:hover { color: var(--pencil); border-bottom-color: currentColor; }
/* A stub's own citation of what it answers. Deliberately *above* the body and
 * in the apparatus voice: it is the header of a response, not a footnote to
 * one. The URL is its own anchor text so a dead link still reads as a
 * citation — which is the whole point of freezing it (see StubCite). */
.stub-cite {
  margin: 0 0 0.9rem;
  padding-left: 0.7rem;
  border-left: 2px solid var(--pencil);
  font-family: var(--sans, inherit);
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--ink-soft);
  max-width: 60ch;
}
.stub-cite .label { text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.75rem; color: var(--pencil); }
.stub-cite.compact { margin: 0 0 0.5rem; padding-left: 0; border-left: 0; }

/* The responses list: a citation trail, not a comment section. Same apparatus
 * voice as the stub's own citation, pointing the other way. No count, ever —
 * a number here would be the one thing on the page a stranger can move. */
.responses { margin: 0.3rem 0 0; padding-top: 0.7rem; border-top: 1px solid var(--rule); font-size: 0.85rem; }
.responses h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--pencil); margin: 0 0 0.4rem; font-weight: 600; }
.responses ul { list-style: none; margin: 0; padding: 0; }
.responses li { margin: 0.25rem 0; line-height: 1.5; }
.responses a { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--rule); }
.responses a:hover { color: var(--pencil); border-bottom-color: currentColor; }
.responses .who { font-style: italic; }
.responses .at-origin, .responses .rel, .responses .when { color: var(--ink-soft); }
.stub-cite cite { font-style: italic; }
.stub-cite a { color: var(--pencil); text-decoration: none; word-break: break-all; }
.stub-cite a:hover { text-decoration: underline; }
.provenance { margin: 0.5rem 0 0; }
.provenance a { color: var(--pencil); text-decoration: none; }
.provenance a:hover { text-decoration: underline; }

/* A pinned page is a frozen artifact; the banner says so plainly, in the
 * apparatus voice, with the blue pencil down its edge. */
.pinned-banner {
  border-left: 2px solid var(--pencil);
  background: var(--paper-sunk);
  padding: 0.7rem 0.9rem;
  margin-bottom: 2rem;
  border-radius: 0 3px 3px 0;
}
.pinned-banner a { color: var(--pencil); text-decoration: none; border-bottom: 1px solid var(--rule); }

/* Kind marker. Was an ALL-CAPS bordered chip — the commonest template tell,
 * and heavier than the thing it labels. A blue lowercase word does the job. */
.kind-chip { font: var(--apparatus); font-style: italic; color: var(--pencil); margin-right: 0.15rem; }
/* A thread card's kind line: its own line, styled like the other apparatus
   labels (.stub-cite .label), so it never runs into the author's first words. */
.card-kind { font-family: var(--sans, inherit); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--pencil); margin: 0 0 0.5rem; }
.card-kind .quote-count { text-transform: none; letter-spacing: 0; color: var(--ink-soft); }
/* The top of the thread's own page, cut at a fixed height. A height clip,
   not a line clamp: the card holds blockquotes, headings and lists, which
   -webkit-line-clamp cannot count. The fade is added only when the content
   overflows (VERSION_NAV_SCRIPT sets .clipped), so a short thread's last line
   is never dimmed; without script the content is still clipped, just unfaded. */
.card-clip { max-height: 24rem; overflow: hidden; position: relative; }
.card-clip.clipped { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 4rem), transparent); mask-image: linear-gradient(to bottom, #000 calc(100% - 4rem), transparent); }
.card-clip h1 { font-size: 1.15rem; line-height: 1.25; margin: 0 0 0.35rem; }
.thread-card .read-more { margin: 0.6rem 0 0; }

/* A transcluded fragment is someone's words held verbatim, so it is set as a
 * quotation with the editorial blue beside it, not as a tinted card. */
blockquote.blyg-transclusion {
  margin: 1.5rem 0;
  padding: 0.25rem 0 0.25rem 1.1rem;
  border-left: 2px solid var(--pencil);
  background: none;
}
blockquote.blyg-transclusion > :first-child { margin-top: 0; }
blockquote.blyg-transclusion p:last-of-type { margin-bottom: 0.25rem; }
/* Quoted material is subordinate to the document quoting it, so a transcluded
 * fragment's own headings step down a rank rather than competing with the
 * thread's prose at full size. */
blockquote.blyg-transclusion h1, blockquote.blyg-transclusion h2 { font-size: 1.125rem; }
blockquote.blyg-transclusion h3 { font-size: 1rem; }
blockquote.blyg-transclusion h1, blockquote.blyg-transclusion h2, blockquote.blyg-transclusion h3 { margin: 1.2em 0 0.4em; }

/* Withdrawn: present, legible, and visibly spent. */
.withdrawn { color: var(--ink-soft); font-style: italic; }

/* --- pinned-version carousel (feed page) ---------------------------------
 * Rendered by the server as a plain version line; the ‹ › controls are added
 * by script, so they only ever exist where they work. */
.version-line .vnav { display: inline-flex; gap: 0.15rem; margin-right: 0.4rem; vertical-align: baseline; }
.version-line .vstep {
  font: var(--apparatus); line-height: 1; color: var(--pencil);
  background: none; border: 1px solid var(--rule); border-radius: 3px;
  padding: 0.05rem 0.35rem; cursor: pointer;
}
.version-line .vstep:hover:not(:disabled) { border-color: var(--pencil); }
.version-line .vstep:disabled { color: var(--ink-soft); opacity: 0.4; cursor: default; }
.version-line .vlatest { margin-left: 0.1rem; }
.version-line .vextra a { color: var(--pencil); text-decoration: none; border-bottom: 1px solid var(--rule); }
/* A frozen version showing in place must never be mistaken for the live one,
 * but the marker must cost nothing in layout: a left rule plus padding
 * indented the text on every step, so cycling versions slid the whole column
 * sideways. A tint extended by box-shadow spread paints the same "this is
 * held, not live" signal *outside* the box — box-shadow is not laid out, so
 * the text does not move by a single pixel when the version changes. */
article.showing-pin .item-content {
  background: var(--paper-sunk);
  border-radius: 2px;
  box-shadow: 0 0 0 0.7rem var(--paper-sunk);
}
article.showing-pin .item-content > :first-child { margin-top: 0; }
article.showing-pin .item-content > :last-child { margin-bottom: 0; }
article.showing-pin .item-content[aria-busy="true"] { opacity: 0.5; }

/* The version label is the only part of the line whose text changes as you
 * step ("v3" → "v12 · frozen"), and it sits before the pin citations — so
 * without a reserved width every step nudged everything after it. Fixed box,
 * left-aligned: the controls and the citations never move. */
.version-line .vlabel { display: inline-block; min-width: 6.5em; }

/* A titled item's heading is its link; it should read as the heading, with the
 * link only showing on hover, rather than as a blue headline. */
.blyg a.item-title { color: inherit; text-decoration: none; }
.blyg a.item-title:hover { color: var(--pencil); }

/* The blogroll is a list of other people, set apart from your own writing. */
.blogroll { margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); }
.blogroll h2 { font: var(--apparatus); font-weight: 600; color: var(--ink-soft); margin: 0 0 0.6rem; letter-spacing: 0; }
.blogroll ul { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; }
.blogroll li { font: var(--apparatus); }
.blogroll a { color: var(--pencil); text-decoration: none; border-bottom: 1px solid var(--rule); }
.blogroll a:hover { border-bottom-color: currentColor; }
.blogroll .blyg-mark { font-style: italic; color: var(--ink-soft); margin-right: 0.1rem; }
.blogroll-foot { font: var(--apparatus); color: var(--ink-soft); margin: 0.8rem 0 0; }
.collections { margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); }
.collections h2 { font: var(--apparatus); font-weight: 600; color: var(--ink-soft); margin: 0 0 0.6rem; letter-spacing: 0; }
.collections ul { list-style: none; padding: 0; margin: 0; }
.collections li { font: var(--apparatus); margin: 0 0 0.45rem; overflow-wrap: anywhere; }
.collections a { color: var(--pencil); text-decoration: none; border-bottom: 1px solid var(--rule); }
.collections a:hover { border-bottom-color: currentColor; }
.collections .meta, .collection-head .meta { color: var(--ink-soft); }
.collection-desc { color: var(--ink-soft); }
.collections .collection-desc { display: block; }
.collection-head { margin: 0 0 2rem; }
.collection-head h2 { margin-bottom: 0.3rem; }
.collection-head p { font: var(--apparatus); margin: 0.2rem 0; overflow-wrap: anywhere; }
.collection-head .collection-desc { font-style: italic; }

ul.archive { list-style: none; padding: 0; margin: 0; }
ul.archive li { padding: 0.55rem 0; border-top: 1px solid var(--rule); display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
ul.archive .row-main a { text-decoration: none; }
/* The body tail after a title. Apparatus type, so the row reads as a title
   with a note under it rather than as one long sentence. */
ul.archive .row-sub { font: var(--apparatus); color: var(--ink-soft); }
ul.archive .row-main a:hover { text-decoration: underline; }
ul.archive .meta { flex: none; white-space: nowrap; }
footer.older { padding: 2rem 0 0; border-top: 1px solid var(--rule); margin-top: 2rem; }
footer.older a { font: var(--apparatus); color: var(--pencil); text-decoration: none; }
footer.older a:hover { text-decoration: underline; }

/* A pasted URL is one unbroken token, and a 65ch measure on a 390px screen is
   narrower than plenty of them. Without this, one link in one item sets the
   page's minimum width and every page on the blyg scrolls sideways. Prose gets
   break-word (breaks only where a word cannot fit); the apparatus, which is
   where bare URLs and origins actually appear, gets anywhere. */
article.fragment, article.thread, .thread-card { overflow-wrap: break-word; }
.provenance, .responses li, .blogroll li, .pinned-banner { overflow-wrap: anywhere; }

@media (max-width: 30rem) {
  body { padding: 1.5rem 1rem 3rem; }
  /* A 2rem inset on a phone eats the measure; the sheet still reads as a
     sheet with half of it. */
  .blyg { padding: calc(var(--block-pad) / 2); max-width: calc(65ch + var(--block-pad)); }
  ul.archive li { flex-direction: column; gap: 0.15rem; }
  /* The masthead is the one row on a public page that pairs a fixed-size
     image with text that has to wrap. */
  .masthead { gap: 0.75rem; }
  /* The version arrows are an apparatus-sized control — about 18px tall,
     which is a fine mouse target and not a thumb target. They are also the
     only buttons on a public page, so this is the whole tap-target problem. */
  .version-line .vnav { gap: 0.3rem; }
  .version-line .vstep { padding: 0.45rem 0.6rem; }
}
/* The robot badge is a button only where highlighting is on (see
   generatedHighlightRules); elsewhere it is not rendered at all. */
.gen-badge { display: none; }
/* The disclosure box the robot opens (GEN_INFO_SCRIPT): one per page, fixed
   to the viewport so a clipped feed card cannot cut it off. */
.gen-pop { position: fixed; z-index: 50; box-sizing: border-box; width: max-content; max-width: min(20rem, calc(100vw - 1rem)); padding: 0.6rem 0.75rem; background: var(--paper); color: var(--ink); border: 1px solid var(--rule); border-radius: 8px; box-shadow: 0 6px 24px rgb(0 0 0 / 0.18); font: var(--apparatus); }
.gen-pop[hidden] { display: none; }
.gen-pop .gen-pop-h { margin: 0 0 0.25rem; font-weight: 600; color: var(--pencil); }
.gen-pop p { margin: 0 0 0.4rem; }
.gen-pop dl { display: grid; grid-template-columns: auto 1fr; gap: 0.1rem 0.6rem; margin: 0; }
.gen-pop dt { color: var(--ink-soft); }
.gen-pop dd { margin: 0; overflow-wrap: anywhere; }
${EMBED_CSS}
${generatedHighlightRules(".gen-on")}`;

/**
 * Generated spans ([TK], §5.7) drawn as a tinted, hairline-outlined box. The
 * markup is the protocol's own `blyg-tk-gen` and is never changed; whether a
 * page highlights it is presentation. `scope` selects the articles it applies
 * to: `.gen-on` (an item's own override) always, and every article not
 * opted out when the blyg's default is on.
 *
 * A generated block wears a small robot badge on its bottom edge, near the
 * left: Brady Dale's convention on bradydale.com, adopted so the mark reads
 * the same across blygs. An inline span, which can wrap, gets the robot
 * before its first word. GEN_INFO_SCRIPT makes the badge a button (hover or
 * tap for the disclosure) and marks the span .gen-ready; until then, or with
 * scripts off, the same robot is drawn by pseudo-elements. Either way the
 * icon is a mask filled with --ink-soft, so it follows the theme.
 */
function generatedHighlightRules(scope: string): string {
  const icon = `background: var(--ink-soft); -webkit-mask: ${ROBOT} center / contain no-repeat; mask: ${ROBOT} center / contain no-repeat;`;
  const square = `box-sizing: border-box; width: 30px; height: 26px; border: 1px solid color-mix(in srgb, var(--ink-soft) 55%, var(--gen-rule)); border-radius: 6px; background: var(--paper);`;
  return `${scope} .blyg-tk-gen { background: var(--gen-bg); box-shadow: inset 0 0 0 1px var(--gen-rule); border-radius: 4px; }
${scope} div.blyg-tk-gen { position: relative; padding: 0.5rem 0.75rem 1.15rem; margin: 0.75rem 0 1.5rem; }
${scope} div.blyg-tk-gen > :first-child:not(.gen-badge), ${scope} div.blyg-tk-gen > .gen-badge + * { margin-top: 0; }
${scope} div.blyg-tk-gen > :last-child { margin-bottom: 0; }
${scope} div.blyg-tk-gen:not(.gen-ready)::before { content: ""; position: absolute; left: 0.65rem; bottom: -13px; ${square} }
${scope} div.blyg-tk-gen:not(.gen-ready)::after { content: ""; position: absolute; left: calc(0.65rem + 6px); bottom: -10px; width: 18px; height: 18px; ${icon} }
/* An inline span that wraps keeps its box on every line it touches. */
${scope} span.blyg-tk-gen { padding: 0.05rem 0.2rem; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
${scope} span.blyg-tk-gen:not(.gen-ready)::before { content: ""; display: inline-block; width: 0.9em; height: 0.9em; margin-right: 0.2em; vertical-align: -0.1em; ${icon} }
${scope} .gen-badge { display: inline-block; position: relative; margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
${scope} .gen-badge::after { content: ""; position: absolute; ${icon} }
${scope} div.blyg-tk-gen > .gen-badge { position: absolute; left: 0.65rem; bottom: -13px; ${square} }
${scope} div.blyg-tk-gen > .gen-badge::after { inset: 3px 5px; }
${scope} span.blyg-tk-gen > .gen-badge { width: 0.9em; height: 0.9em; margin-right: 0.2em; vertical-align: -0.1em; }
${scope} span.blyg-tk-gen > .gen-badge::after { inset: 0; }
${scope} .gen-badge:focus-visible { outline: 2px solid var(--pencil); outline-offset: 2px; }
`;
}

/** Appended to style.css: the blyg-wide default, which an item's gen-off overrides. */
export function generatedHighlightCss(on: boolean): string {
  return on ? `\n/* generated spans highlighted by default */\n${generatedHighlightRules("article:not(.gen-off)")}` : "";
}

/**
 * Per-page head extras. Grouped into one object rather than growing `layout`'s
 * positional tail, which was already at five.
 *
 * `description`/`image`/`url` drive both the plain `<meta name="description">`
 * and the Open Graph + Twitter tags. Purely presentational: a blyg's identity
 * and content are published to machines through `blyg.json`, `feed.xml` and the
 * item JSON, none of which change here — these tags exist so that a *link to*
 * a blyg pasted into a chat or a social post unfurls as something other than a
 * bare URL. `siteName` is the blyg's title; `url` must be absolute (OG requires
 * it), which is why the page builders now take the site origin.
 */
export interface PageMeta {
  hasBlogroll?: boolean;
  canonical?: string;
  description?: string;
  /** Absolute URL of this page — og:url. */
  url?: string;
  /** Absolute URL of a representative image — og:image. */
  image?: string;
  /** og:type — "website" for the feed/archive, "article" for an item page. */
  type?: "website" | "article";
  siteName?: string;
  /** og:title when it should differ from <title> (which carries the site suffix). */
  ogTitle?: string;
  /**
   * Absolute URL of this page's item document — `<link rel="alternate"
   * type="application/json">` (v0.3-plan §2.3.2, decision #29). This is the
   * structural-verification hook: it is how a Webmention receiver gets from
   * the W3C-standard *source page* to the document it actually checks.
   */
  alternateJson?: string;
  /**
   * Absolute URL of this deployment's Webmention endpoint — `<link
   * rel="webmention">` (§2.3.1). W3C discovery is how a *non-blyg* sender
   * finds us; a blyg sender reads the manifest key instead.
   */
  webmention?: string;
  /**
   * Absolute feed URL for RSS autodiscovery — `${origin}feed.xml`.
   * When omitted, layout falls back to the mount-relative `${mount}/feed.xml`
   * so pages without an origin (hopper) still advertise a feed.
   */
  feedUrl?: string;
  /** Feed title for the autodiscovery link — the blyg's title. */
  feedTitle?: string;
}

function metaTags(meta: PageMeta): string {
  const tags: string[] = [];
  const push = (name: string, value: string | undefined, prop = false) => {
    if (!value) return;
    tags.push(`<meta ${prop ? "property" : "name"}="${name}" content="${escapeHtml(value)}">`);
  };
  push("description", meta.description);
  push("og:title", meta.ogTitle, true);
  push("og:description", meta.description, true);
  push("og:type", meta.type ?? "website", true);
  push("og:url", meta.url, true);
  push("og:image", meta.image, true);
  push("og:site_name", meta.siteName, true);
  // summary_large_image only makes sense with an image; without one the
  // "large" card renders as an empty box, so fall back to the text card.
  push("twitter:card", meta.image ? "summary_large_image" : "summary");
  return tags.length ? tags.join("\n") + "\n" : "";
}

/**
 * The robot badge on a generated span opens a small box saying what the
 * author disclosed about it (0.27.0): hover for a peek, tap or click to keep
 * it open, Escape or a click elsewhere to close. Same three properties as
 * VERSION_NAV_SCRIPT: an enhancement (scripts off, the CSS still draws the
 * robot), dumb-host safe (it reads only data-generated, already on the page),
 * and it invents nothing (every line comes from the version's generated[]).
 *
 * The details are version-level, as §5.7 is: a version that generated three
 * passages discloses one array for all three, and the box says so rather than
 * pretending to know which passage came from which model. A span inside a
 * quoted item belongs to that item's disclosure, not this one's, so the box
 * says only that.
 *
 * The wording is "the author marked this", never "this is": generated[] is
 * self-asserted (§5.7 rule 6), and a badge must not read as verification.
 */
export const GEN_INFO_SCRIPT = `
(function () {
  // A page with no generated text yet may gain some when a version swaps in.
  if (!document.querySelector(".blyg-tk-gen, .version-line")) return;
  var pop = null, current = null, pinned = false, timer = 0;

  function decorate(el) {
    if (el.classList.contains("gen-ready")) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "gen-badge";
    b.setAttribute("aria-label", "AI-generated text: what the author disclosed");
    b.setAttribute("aria-expanded", "false");
    el.insertBefore(b, el.firstChild);
    el.classList.add("gen-ready");
  }
  function decorateIn(root) {
    if (root.classList && root.classList.contains("blyg-tk-gen")) decorate(root);
    var found = root.querySelectorAll ? root.querySelectorAll(".blyg-tk-gen") : [];
    for (var i = 0; i < found.length; i++) decorate(found[i]);
  }

  function add(parent, tag, text, cls) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    parent.appendChild(el);
    return el;
  }
  function day(iso) {
    var d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function fill(badge) {
    pop.textContent = "";
    add(pop, "p", "AI-generated", "gen-pop-h");
    var span = badge.parentNode;
    if (span.closest("blockquote.blyg-transclusion")) {
      add(pop, "p", "The quoted author marked this text as machine-generated. Its details are in the quoted item.");
      return;
    }
    add(pop, "p", "The author marked this text as machine-generated. Self-reported, not verified.");
    var holder = span.closest("[data-generated]"), list = [];
    try { list = holder ? JSON.parse(holder.getAttribute("data-generated")) || [] : []; } catch (e) { list = []; }
    var models = [], dates = [], sources = {};
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      if (!g) continue;
      if (g.model && models.indexOf(g.model) === -1) models.push(g.model);
      if (g.at) dates.push(g.at);
      for (var j = 0; g.sources && j < g.sources.length; j++) sources[g.sources[j].id] = true;
    }
    dates.sort();
    var dl = add(pop, "dl");
    add(dl, "dt", models.length > 1 ? "Models" : "Model");
    add(dl, "dd", models.length ? models.join(", ") : "not stated");
    if (dates.length) {
      add(dl, "dt", "Generated");
      var first = day(dates[0]), last = day(dates[dates.length - 1]);
      add(dl, "dd", first === last ? first : first + " to " + last);
    }
    var n = Object.keys(sources).length;
    if (n) {
      add(dl, "dt", "Drew on");
      add(dl, "dd", n + (n === 1 ? " item" : " items") + " from this blyg");
    }
    if (list.length > 1) add(pop, "p", "These details cover all " + list.length + " generated passages in this version.").style.marginTop = "0.4rem";
  }
  function place(badge) {
    var r = badge.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }
  function open(badge, keep) {
    clearTimeout(timer);
    if (!pop) {
      pop = document.createElement("div");
      pop.className = "gen-pop";
      pop.id = "gen-pop";
      pop.setAttribute("role", "tooltip");
      pop.hidden = true;
      document.body.appendChild(pop);
      pop.addEventListener("mouseenter", function () { clearTimeout(timer); });
      pop.addEventListener("mouseleave", function () { if (!pinned) later(); });
    }
    if (current && current !== badge) current.setAttribute("aria-expanded", "false");
    current = badge;
    pinned = keep;
    fill(badge);
    pop.hidden = false;
    place(badge);
    badge.setAttribute("aria-expanded", "true");
    badge.setAttribute("aria-describedby", "gen-pop");
  }
  function close() {
    clearTimeout(timer);
    if (pop) pop.hidden = true;
    if (current) current.setAttribute("aria-expanded", "false");
    current = null;
    pinned = false;
  }
  function later() { clearTimeout(timer); timer = setTimeout(close, 200); }
  function badgeAt(e) { return e.target.closest ? e.target.closest(".gen-badge") : null; }

  document.addEventListener("click", function (e) {
    var b = badgeAt(e);
    if (b) { e.preventDefault(); if (pinned && current === b) close(); else open(b, true); return; }
    if (pop && !pop.hidden && !pop.contains(e.target)) close();
  });
  document.addEventListener("mouseover", function (e) { var b = badgeAt(e); if (b && !pinned) open(b, false); });
  document.addEventListener("mouseout", function (e) { if (badgeAt(e) && !pinned) later(); });
  document.addEventListener("focusin", function (e) { var b = badgeAt(e); if (b && !pinned) open(b, false); });
  document.addEventListener("focusout", function (e) { if (badgeAt(e) && !pinned) later(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  window.addEventListener("scroll", function () { if (current && pop && !pop.hidden) place(current); }, { passive: true });
  window.addEventListener("resize", function () { if (current && pop && !pop.hidden) place(current); });

  decorateIn(document);
  // The version carousel swaps a version's body in place; decorate it too.
  if (window.MutationObserver) {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++)
        for (var j = 0; j < records[i].addedNodes.length; j++)
          if (records[i].addedNodes[j].nodeType === 1) decorateIn(records[i].addedNodes[j]);
      if (current && !document.contains(current)) close();
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
`;

export const VERSION_NAV_SCRIPT = `
/**
 * In-situ pinned-version carousel (session 19; extended to the permalink and
 * thread pages session 21).
 *
 * It runs on every public page that renders an item, because the version line
 * it enhances renders on every one of them. Shipping it on the feed alone gave
 * identical markup two different behaviours depending on which page you were
 * looking at — a pin citation that swapped in place on the feed and navigated
 * away on the permalink — and the permalink is the page a citation actually
 * lands on, so it is where the comparison is most likely to be wanted.
 * Decision #25 settled that this is presentation, and therefore this client's
 * call to make; the conformance argument is unchanged either way.
 *
 * A pin citation used to navigate away to the frozen page. But reading "what
 * did this say before?" is a comparison, and a comparison wants both texts in
 * the same place — so a pin now swaps that version into the item where it
 * sits, and going to the frozen page became a separate, explicit link.
 *
 * Three properties this is built to keep:
 *
 * 1. It is an ENHANCEMENT, never a requirement. The server renders the same
 *    version line it always did, with the pin citations as real links to real
 *    pages. With JavaScript off — or if this script throws — clicking a pin
 *    still lands on the frozen page. Nothing here is load-bearing.
 * 2. It works on a DUMB FILE HOST. The only thing it fetches is
 *    items/{id}/v{n}.json, which §2.8 already publishes and which the static
 *    export already writes, so an exported tree keeps working. That is
 *    invariant 4's whole point.
 * 3. It never INVENTS a version. Positions come from data-pins plus the live
 *    version and nothing else; unpinned history stays unreachable in every
 *    representation (§2.8), which is what keeps withdrawal meaningful.
 *
 * The cycle runs oldest to newest with the live version last — the direction
 * the item was actually written in.
 */
(function () {
  // Feed-page thread cards: fade the bottom edge only when the clip actually
  // cuts something off, so a short thread is never dimmed (session 30). Runs
  // before the version-line early return below, which a feed can trip.
  var clips = document.querySelectorAll(".card-clip");
  for (var c = 0; c < clips.length; c++) {
    if (clips[c].scrollHeight > clips[c].clientHeight + 1) clips[c].classList.add("clipped");
  }

  var lines = document.querySelectorAll(".version-line[data-item]");
  if (!lines.length || !window.fetch) return;

  Array.prototype.forEach.call(lines, function (line) {
    var article = line.closest("article");
    var content = article && article.querySelector(".item-content");
    if (!content) return;

    var live = Number(line.dataset.live);
    var pins = (line.dataset.pins || "").split(",").filter(Boolean).map(Number);
    var mount = line.dataset.mount || "";
    var id = line.dataset.item;
    var kind = line.dataset.kind;

    // Live plus each pin, de-duplicated: a pin OF the live version is the same
    // bytes you are already looking at, so it is one position that happens to
    // be pinned, not two.
    var versions = pins.slice();
    if (versions.indexOf(live) === -1) versions.push(live);
    versions.sort(function (a, b) { return a - b; });
    if (versions.length < 2) return;

    // The version note is apparatus ABOUT a version, so it has to travel with
    // the content. Session 19 left it pinned to the live version while the
    // body swapped underneath it, which put v2's note ("tightened it") under
    // v1's text — the editorial layer describing something other than what is
    // on screen, which is the one thing it must never do. v{n}.json carries
    // each version's own note, and it is already being fetched.
    var noteEl = article.querySelector(".version-note");
    var cache = {};
    // Each version's generated[] travels with its body too: the robot badge's
    // info box reads it from data-generated (GEN_INFO_SCRIPT).
    cache[live] = { html: content.innerHTML, note: noteEl ? noteEl.textContent : "", gen: content.getAttribute("data-generated") };
    function setBody(entry) {
      content.innerHTML = entry.html;
      if (entry.gen) content.setAttribute("data-generated", entry.gen);
      else content.removeAttribute("data-generated");
    }
    var at = versions.indexOf(live);

    function setNote(text) {
      if (!text) { if (noteEl) noteEl.hidden = true; return; }
      if (!noteEl) {
        noteEl = document.createElement("p");
        noteEl.className = "version-note";
        line.parentNode.insertBefore(noteEl, line.nextSibling);
      }
      noteEl.hidden = false;
      noteEl.textContent = text;
    }

    var nav = document.createElement("span");
    nav.className = "vnav";
    nav.innerHTML =
      '<button type="button" class="vstep" data-step="-1" title="older version" aria-label="older version">‹</button>' +
      '<button type="button" class="vstep" data-step="1" title="newer version" aria-label="newer version">›</button>';
    var label = line.querySelector(".vlabel");
    label.parentNode.insertBefore(nav, label);

    var extra = document.createElement("span");
    extra.className = "vextra";
    line.appendChild(extra);

    function render() {
      var v = versions[at];
      var isLive = v === live;
      // Only "frozen" is added here. Saying "pinned" would repeat the pin
      // citations sitting right beside it ("v3 · pinned · pinned: v1, v3").
      label.textContent = "v" + v + (isLive ? "" : " · frozen");
      setNote(cache[v] ? cache[v].note : "");
      article.classList.toggle("showing-pin", !isLive);
      nav.querySelector('[data-step="-1"]').disabled = at === 0;
      nav.querySelector('[data-step="1"]').disabled = at === versions.length - 1;
      // Going to the page is its own action now, rather than something that
      // happens to you when you click a version number.
      extra.innerHTML = isLive
        ? ""
        : ' · <a href="' + mount + "/" + kind + "/" + id + "/v" + v + '/">open this version ↗</a>' +
          ' · <button type="button" class="vstep vlatest">back to latest</button>';
    }

    function show(v) {
      at = versions.indexOf(v);
      if (cache[v] !== undefined) { setBody(cache[v]); render(); return; }
      content.setAttribute("aria-busy", "true");
      // Protocol snapshots stay immutable. Read the server's safe presentation
      // instead of inserting legacy content_html from public JSON into the DOM.
      fetch(mount + "/" + kind + "/" + id + "/v" + v + "/")
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
        .then(function (html) {
          var page = new DOMParser().parseFromString(html, "text/html");
          var body = page.querySelector("article .item-content");
          if (!body) throw new Error("Missing version presentation");
          var note = page.querySelector("article .version-note");
          var holder = page.querySelector("article[data-generated]");
          cache[v] = { html: body.innerHTML, note: note ? note.textContent : "", gen: holder ? holder.getAttribute("data-generated") : null };
          setBody(cache[v]);
          content.removeAttribute("aria-busy");
          render();
        })
        .catch(function () {
          // Fall back to the thing that always works: the frozen page itself.
          content.removeAttribute("aria-busy");
          location.href = mount + "/" + kind + "/" + id + "/v" + v + "/";
        });
    }

    line.addEventListener("click", function (e) {
      var step = e.target.closest(".vstep");
      if (step) {
        e.preventDefault();
        if (step.classList.contains("vlatest")) { show(live); return; }
        var next = at + Number(step.dataset.step);
        if (next >= 0 && next < versions.length) show(versions[next]);
        return;
      }
      // A pin citation opens here instead of navigating. The href stays on the
      // element, so middle-click, cmd-click and no-JS all still reach the
      // page — only a plain left click is intercepted.
      var pin = e.target.closest(".pins a");
      if (!pin || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      var v = Number((pin.textContent || "").replace(/[^0-9]/g, ""));
      if (!v || versions.indexOf(v) === -1) return;
      e.preventDefault();
      show(v);
    });

    render();
  });
})();
`;

export function layout(title: string, body: string, mount: string, meta: PageMeta = {}): string {
  // RSS autodiscovery: absolute URL + title. A relative href without a title
  // is valid HTML but several readers ignore it — pasting `<origin>/blyg/`
  // then fails with "invalid link" while `<origin>/blyg/feed.xml` works.
  const feedHref = meta.feedUrl ?? `${mount}/feed.xml`;
  const feedTitle = meta.feedTitle ? ` title="${escapeHtml(meta.feedTitle)}"` : "";
  // EMBED_SCRIPT (studio#9) goes on every page that renders item HTML in an
  // <article>: the feed, both permalinks, pinned versions, collections. It
  // upgrades the published HTML on screen and never changes the bytes.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${metaTags({ ...meta, ogTitle: meta.ogTitle ?? title })}<link rel="stylesheet" href="${mount}/style.css">
<link rel="alternate" type="application/rss+xml"${feedTitle} href="${escapeHtml(feedHref)}">
${meta.webmention ? `<link rel="webmention" href="${meta.webmention}">\n` : ""}${meta.alternateJson ? `<link rel="alternate" type="application/json" href="${meta.alternateJson}">\n` : ""}${meta.canonical ? `<link rel="canonical" href="${meta.canonical}">\n` : ""}${meta.hasBlogroll ? `<link rel="blogroll" href="${mount}/blogroll.opml">\n` : ""}</head>
<body>
${body}
${body.includes("blyg-tk-gen") || body.includes("version-line") ? `<script>${GEN_INFO_SCRIPT}</script>\n` : ""}${body.includes("<article") ? `<script>${EMBED_SCRIPT}</script>\n` : ""}</body>
</html>
`;
}

/**
 * Bare embeddable header (rev-2 review: "embeddable no-navbar public page").
 * Still one line and still no navbar — an embedding host that supplies its own
 * chrome hides it with `.blyg-header { display: none }` exactly as before.
 *
 * The left slot was a hardcoded `Home` → `/`, which session 19 replaced with
 * the blyg's own title → `{mount}/`. Two things were wrong with the old link.
 * On a **root-mounted** node (`MOUNT=""`, which is how blyg.protocol-institute.org
 * runs) `/` *is* this page, so "Home" was a self-link. On a **path-mounted** node
 * `/` is the host site, which meant a reader who landed on a permalink had no
 * link back to the blyg at all — the one destination the page can actually
 * name. A blyg cannot know what lives at `/`; it does know where it itself is.
 *
 * Linking back to the host site is now an author-configured `author_links`
 * entry rendered in the masthead, which is honest: only the author knows
 * whether `/` is their homepage, someone else's site, or nothing.
 */
function pageHeader(mount: string): string {
  // Always `bare`: the masthead below sets the blyg's name at display size on
  // every page now, and printing it twice in a row is just clutter. The class
  // is still emitted because themes target `.blyg-header.bare` for the layout
  // that pairs a one-line header with a masthead under it.
  return `<header class="blyg-header bare">
<a href="${mount}/feed.xml" title="RSS feed">RSS ⧉</a>
</header>`;
}

/**
 * The top of every public page, identical everywhere: bare header + masthead.
 *
 * Session 25 (Venkat): the feed page set the blyg's name in display type while
 * every other page set it as a one-line link in the header, so moving between
 * them made the top of the page jump. Identity is now rendered the same way in
 * the same place on the feed, permalinks, threads, pinned snapshots, the
 * archive and withdrawal endcaps.
 *
 * This widens session 19's deliberate feed-page-only scope. That scope existed
 * to keep the pages most likely to be *embedded* lean — but a host embedding a
 * feed page already had to hide `.masthead`, so this asks nothing new of it,
 * just the same thing uniformly: hide `.blyg-header` and `.masthead` and every
 * page is a bare block.
 */
export async function pageTop(db: D1Database, settings: Settings, mount: string, avatar?: MediaRow | null): Promise<string> {
  return `${pageHeader(mount)}\n${await masthead(db, settings, mount, avatar)}`;
}

/**
 * Feed-page masthead — avatar, author name, bio, author links.
 *
 * Session 19. This is the one place that departs from the rev-2 note "site
 * identity lives in the manifest, feed channel, and studio settings, not on
 * this page." That note's rationale was embeddability, and it holds for an
 * embedded block: a host page supplies its own identity. But **both live nodes
 * are standalone deployments**, which the same note acknowledged and left
 * unserved — so every identity field the protocol already carries
 * (`title`, `author.name`, `author.bio`, `author.links`, the avatar) was
 * published in `blyg.json` and in the feed channel, and rendered nowhere a
 * human could see it. A reader arriving at the page could not tell whose it was.
 *
 * Session 19 scoped this to the **feed page only**, to keep the pages most
 * likely to be embedded lean. Session 25 widened it to every public page — see
 * `pageTop`, which is now the only caller.
 *
 * Presentation only — reads settings that already exist, writes no new field,
 * and nothing here appears in any wire representation.
 */
async function masthead(db: D1Database, settings: Settings, mount: string, loadedAvatar?: MediaRow | null): Promise<string> {
  const bits: string[] = [];
  // The avatar's URL is its `r2_key` (`media/{id}.{ext}`), not `media/{id}` —
  // the `/media/:file` route matches on the full key including the extension,
  // so an id alone 404s. Same lookup `mediaHtml` does for item images.
  const avatar = loadedAvatar !== undefined ? loadedAvatar : settings.avatar_media_id ? await getMedia(db, settings.avatar_media_id) : null;
  if (avatar) {
    bits.push(`<img class="avatar" src="${mount}/${avatar.r2_key}" alt="" width="48" height="48">`);
  }
  const lines: string[] = [
    `<p class="site-name"><a href="${mount}/">${escapeHtml(settings.site_title)}</a></p>`,
  ];
  if (settings.author_name) lines.push(`<p class="author-name">${escapeHtml(settings.author_name)}</p>`);
  if (settings.author_bio) lines.push(`<p class="author-bio">${escapeHtml(settings.author_bio)}</p>`);
  if (settings.author_links.length) {
    lines.push(
      `<p class="author-links">${settings.author_links
        .map((l) => `<a href="${escapeHref(l.url)}" rel="me">${escapeHtml(l.label)}</a>`)
        .join(" &middot; ")}</p>`,
    );
  }
  bits.push(`<div class="masthead-text">${lines.join("\n")}</div>`);
  return `<div class="masthead">${bits.join("\n")}</div>`;
}

/** Local alias; `timeZone` is required so no call site can silently mean UTC. */
const formatDate = (iso: string, timeZone: string): string => formatDateIn(iso, timeZone);

/**
 * Version line + note + Created/Most-recent lines.
 *
 * This replaces the rev-3 scrubber (`|< < v2 of 2 > >|`, every button
 * hardcoded `disabled`), which promised paging that cannot exist: §2.8's
 * session-5 decision is that **no route ever serves an older version as an
 * HTML page**, so there is nothing for those arrows to navigate to, now or
 * later. §2.8 names the replacement outright — "the public page's version
 * display is an indicator, not navigation ... the right presentation is
 * discrete pin citations (e.g. 'v6 · pinned: v2, v4') linking to the existing
 * v{n}.json files" — because that is what pins are: a sequence of frozen
 * citable artifacts of one identity, not pages of one document.
 *
 * Pins are shown on withdrawn items too. That is the point of a pin: it
 * survives withdrawal of the live stream (§2.8), so the endcap page is
 * exactly where a reader needs to be told what remains citable.
 */
function itemMeta(item: FeedItem, note: string | null, pins: number[], mount: string, isThread: boolean, tz: string): string {
  const created = formatDate(item.created, tz);
  // Citations link the HTML pages (session-18 route); each page links its
  // JSON twin, so the machine-citable file is one hop away, never hidden.
  // isThread comes from the caller, not item.kind — a withdrawn item's kind
  // is 'withdrawn', but its pinned versions live under their authored route.
  const kindSeg = isThread ? "t" : "f";
  const pinPart = pins.length
    ? ` &middot; <span class="pins">pinned: ${pins
        .map((v) => `<a href="${mount}/${kindSeg}/${item.id}/v${v}/" title="frozen snapshot of v${v}">v${v}</a>`)
        .join(", ")}</span>`
    : "";
  // A single-version item with no pins has no version story worth telling.
  if (item.version <= 1 && !pins.length) {
    return `<p class="timestamps"><span>Created: ${created}</span></p>`;
  }
  // The version line carries everything the in-situ carousel needs, as data
  // attributes rather than a parsed-out DOM: which versions are pinned, which
  // one is live, and where the JSON and the pages live. Without JavaScript it
  // is exactly the line it was before — the pin citations are real links to
  // real pages — so the enhancement can fail completely and lose nothing.
  const versionLine =
    `<p class="version-line" data-item="${item.id}" data-kind="${kindSeg}" data-live="${item.version}"` +
    ` data-pins="${pins.join(",")}" data-mount="${mount}">` +
    `<span class="vlabel">v${item.version}</span>${pinPart}</p>`;
  const noteHtml = note ? `<p class="version-note">&ldquo;${escapeHtml(note)}&rdquo;</p>` : "";
  const recent =
    item.version > 1 ? `\n<span>Most recent: ${formatDate(item.updated, tz)}, v${item.version}</span>` : "";
  return `${versionLine}
${noteHtml}
<p class="timestamps">
<span>Created: ${created}</span>${recent}
</p>`;
}

/** Pinned version numbers for an item, ascending — the citations §2.8 says the page should show. */
async function pinnedVersions(db: D1Database, itemId: string): Promise<number[]> {
  return (await db.prepare("SELECT version FROM versions WHERE item_id = ? AND pinned = 1 ORDER BY version ASC").bind(itemId).all<{ version: number }>()).results.map(v => v.version);
}

function permalinkLink(id: string, isThread: boolean, mount: string): string {
  return `<p><a class="permalink" href="${mount}/${isThread ? "t" : "f"}/${id}/">Permalink</a></p>`;
}

function mediaHtml(media: MediaRow[], mount: string, contentHtml: string): string {
  return unplacedMedia(media, contentHtml)
    .map((m) => `<p><img src="${mount}/${m.r2_key}" alt="${escapeHtml(m.alt ?? "")}" loading="lazy"></p>`)
    .join("\n");
}

export function renderFragment(
  item: FeedItem,
  contentHtml: string,
  media: MediaRow[],
  note: string | null,
  mount: string,
  pins: number[] = [],
  // Summary contexts get the short citation, the same split threadCard and
  // threadBlock already make: a feed card is a pointer to an item, and three
  // lines of apparatus over a one-line fragment inverts that.
  compactCitations = false,
  tz: string,
  generatedJson: string | null = null,
): string {
  return `<article class="fragment${highlightClass(item)}">
${forkLineage(item, tz, { compact: compactCitations })}
<div class="item-content"${generatedAttr(generatedJson)}>
${contentHtml}
</div>
${mediaHtml(media, mount, contentHtml)}
${itemMeta(item, note, pins, mount, false, tz)}
${permalinkLink(item.id, false, mount)}
</article>`;
}

/**
 * `titleLink` is set on the feed page and unset on the permalink page: on the
 * item's own page the title would link to the page you are already reading.
 */
async function fragmentBlock(db: D1Database, item: FeedItem, mount: string, tz: string, titleLink = false, loaded?: FeedCardData): Promise<string> {
  const latest = loaded ? loaded.latest : await publishedVersion(db, item);
  const media = loaded ? loaded.media : await listMediaForItem(db, item.id);
  const html = latest?.content_html ?? "";
  return renderFragment(
    item,
    titleLink ? linkLeadingTitle(html, `${mount}/f/${item.id}/`) : html,
    media,
    latest?.note ?? null,
    mount,
    loaded ? loaded.pins : await pinnedVersions(db, item.id),
    titleLink,
    tz,
    latest?.generated_json ?? null,
  );
}

/** Where a baked transclusion's source lives, and how to name it — presentation, resolved locally. */
export interface ProvenanceLink {
  href: string;
  label: string;
}

/**
 * Build the provenance paragraph for each *direct* transclusion of an item, in
 * document order. Local targets link their own permalink by kind (threads are
 * legal targets from v0.3, so the old hardcoded `f/` would have pointed at a
 * 404); remote targets link the source's own page at its origin — its declared
 * `page` when we have one, the f/·t/ convention otherwise — and name the blyg
 * they came from, which is the byline §2.1 asks for.
 */
export async function transclusionProvenance(db: D1Database, transclusions: Transclusion[], mount: string, loaded?: FeedProvenance): Promise<string[]> {
  const out: string[] = [];
  for (const t of transclusions) {
    let link: ProvenanceLink;
    if (t.origin && t.cited) {
      // The frozen citation, when the published entry carries one (§16.1,
      // decision #30). This is the whole stale-byline fix: the branch below
      // renders a *published* document's byline from a live join, so renaming
      // or deleting a subscription silently rewrote what an already-published
      // document said about its source. A citation that changes after
      // publication was never a citation.
      link = { href: t.cited.url, label: `from <em>${escapeHtml(clampForeign(t.cited.source))}</em> ↗` };
    } else if (t.origin) {
      const row = loaded ? loaded.remoteSources.get(sourceKey(t.origin, t.id)) : await db
        .prepare(
          `SELECT ii.kind AS kind, ii.page AS page, s.title AS title
           FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id
           WHERE ii.remote_id = ? AND s.origin = ?`,
        )
        .bind(t.id, t.origin)
        .first<{ kind: string; page: string | null; title: string }>();
      // No row means the subscription is gone since publish. The snapshot is
      // still ours to show (§10.4), so the link degrades to the convention and
      // the label to the host — never to a claim we can no longer support.
      const href = blygItemUrl(t.origin, row?.kind ?? "fragment", t.id, row?.page ?? null);
      const label = row?.title ? `from <em>${escapeHtml(row.title)}</em> ↗` : `from ${escapeHtml(new URL(t.origin).host)} ↗`;
      link = { href, label };
    } else {
      const row = loaded ? null : await db.prepare("SELECT * FROM items WHERE id = ?").bind(t.id).first<ItemRow>();
      // A withdrawn target keeps its permalink (the endcap is 200 forever), so
      // the link stands — it just has to name the authored kind, not "withdrawn".
      const kind = loaded ? loaded.localKinds.get(t.id) ?? "fragment" : row ? await authoredKind(db, row) : "fragment";
      link = { href: `${mount}/${kind === "thread" ? "t" : "f"}/${t.id}/`, label: `${kind} ↗` };
    }
    // A partial quote says so. §16.4 puts the disclosure on the second class,
    // and this is the human half of it: without it an excerpt and a whole
    // transclusion are the same blockquote to a reader, differing only in
    // being shorter — which is indistinguishable from the source being short.
    const what = t.selector ? "excerpt of" : "snapshot of";
    out.push(`<p class="provenance"><a href="${escapeHref(link.href)}">${link.label}</a> · ${what} v${t.version}</p>`);
  }
  return out;
}

/**
 * Inject a provenance paragraph inside each *top-level* baked transclusion
 * blockquote, in document order. Presentation only — this is never stored in
 * the protocol content_html (§2.9 specifies only the blockquote + data
 * attributes as baked content).
 *
 * Depth-aware, and that is load-bearing from v0.3: a nested transclusion puts
 * a `</blockquote>` inside the outer quote, so the old non-greedy regex would
 * have closed the outer match at the inner tag and mis-paired every following
 * provenance line. Deeper layers deliberately get none — provenance records
 * direct transclusions only.
 */
export function injectProvenance(html: string, provenance: string[]): string {
  const re = /<blockquote\b[^>]*>|<\/blockquote>/g;
  let out = "";
  let last = 0;
  let depth = 0;
  let inTransclusion = false;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0].startsWith("</")) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && inTransclusion) {
        const p = provenance[i++];
        out += html.slice(last, m.index) + (p ? `\n${p}` : "");
        last = m.index;
        inTransclusion = false;
      }
    } else {
      // Match the class **token**, not the literal attribute. A partial
      // transclusion's class is `blyg-transclusion blyg-partial` (§16.4), so a
      // substring test on the whole attribute misses it — and missing it does
      // not merely drop one provenance line, it stops the index advancing and
      // mis-pairs every following line in a thread that mixes the two forms,
      // which is exactly the failure the depth-awareness above exists to
      // prevent, arrived at from the other direction.
      if (depth === 0) inTransclusion = /\bclass="[^"]*\bblyg-transclusion\b/.test(m[0]);
      depth++;
    }
  }
  return out + html.slice(last);
}

function parseTransclusions(json: string | null | undefined): Transclusion[] {
  if (!json) return [];
  return JSON.parse(json) as Transclusion[];
}

/**
 * A thread on the feed page shows the top of its own page: the same HTML the
 * permalink renders, with the same provenance lines on its quotes, cut off at
 * a fixed height and continued by "read the thread". Session 30, Venkat: the
 * card should be "as much of the detail page view as will fit in the feed
 * view, with the same formatting".
 *
 * **This reverses session 28's plain-text teaser, deliberately.** That teaser
 * existed because long threads crowded a mixed stream, and its later fixes
 * (author's prose only, heading split off) existed because flattening HTML to
 * text welded a quoted sentence onto the author's own with no boundary. The
 * fixed-height clip answers the first; rendering the real HTML answers the
 * second, since a quote is then a blockquote with a provenance line naming
 * whose it is, exactly as on the thread's own page.
 *
 * The title rule is unchanged (#46: presentation only, the wire keeps the bare
 * heading): a leading heading is linked to the thread by `linkLeadingTitle`,
 * the same helper the fragment card uses.
 */
async function threadCard(db: D1Database, item: FeedItem, mount: string, tz: string, loaded?: FeedCardData, provenance?: FeedProvenance): Promise<string> {
  const latest = loaded ? loaded.latest : await publishedVersion(db, item);
  const href = `${mount}/t/${item.id}/`;
  const transclusions = parseTransclusions(latest?.transclusions);
  const html = injectProvenance(await sanitizeHtml(latest?.content_html ?? ""), await transclusionProvenance(db, transclusions, mount, provenance));
  const media = loaded ? loaded.media : await listMediaForItem(db, item.id);
  // The kind line is apparatus, on its own line above the item, never inline
  // with the author's first sentence (session 30). The quote count says what
  // the card may be cutting off.
  const quoted = transclusions.length;
  const kindLine = `<p class="card-kind">thread${quoted ? ` <span class="quote-count">· ${quoted} quoted</span>` : ""}</p>`;
  return `<article class="fragment thread-card${highlightClass(item)}">
${stubCitation(latest, tz, { compact: true })}
${forkLineage(item, tz, { compact: true })}
${kindLine}
<div class="item-content card-clip"${generatedAttr(latest?.generated_json)}>
${linkLeadingTitle(html, href)}
</div>
${mediaHtml(media, mount, html)}
<p class="read-more"><a href="${href}">read the thread →</a></p>
${itemMeta(item, latest?.note ?? null, loaded ? loaded.pins : await pinnedVersions(db, item.id), mount, true, tz)}
</article>`;
}

async function threadBlock(db: D1Database, item: ItemRow, mount: string, tz: string): Promise<string> {
  const latest = await publishedVersion(db, item);
  const transclusions = parseTransclusions(latest?.transclusions);
  const html = injectProvenance(await sanitizeHtml(latest?.content_html ?? ""), await transclusionProvenance(db, transclusions, mount));
  const media = await listMediaForItem(db, item.id);
  return `<article class="thread${highlightClass(item)}">
${stubCitation(latest, tz)}
${forkLineage(item, tz)}
<div class="item-content"${generatedAttr(latest?.generated_json)}>
${html}
</div>
${mediaHtml(media, mount, html)}
${itemMeta(item, latest?.note ?? null, await pinnedVersions(db, item.id), mount, true, tz)}
${permalinkLink(item.id, true, mount)}
</article>`;
}

/**
 * A stub's citation line — what this thread is a response to (§2.2, and
 * Venkat's session-23 ruling for conventional citation norms).
 *
 * Rendered from the **frozen** `stub_cite` where one exists, so the sentence
 * survives the subscription being renamed or deleted and the target being
 * withdrawn; the URL is printed as its own anchor text, so a link that has
 * since died still reads as a citation a human can follow by other means.
 * Versions published before migration 0008 have no frozen half and fall back
 * to the wire marker alone, which is always enough for identity.
 */
export function stubCitation(row: Pick<VersionRow, "stub_of" | "stub_cite"> | null, tz: string, opts: { compact?: boolean } = {}): string {
  const stub = parseStoredStub(row?.stub_of ?? null);
  if (!stub) return "";
  const cite = parseStoredCite(row?.stub_cite ?? null);
  const url = cite?.url ?? ("url" in stub ? stub.url : `${stub.origin}f/${stub.id}/`);
  if (opts.compact) {
    // Summary contexts (feed card, RSS description) get the shortest true
    // form: who it answers, linked. The full citation lives on the permalink.
    const who = cite?.source ? `<cite>${escapeHtml(cite.source)}</cite>` : escapeHtml(url);
    return `<p class="stub-cite compact"><span class="label">In response to</span> <a href="${escapeHref(url)}">${who} ↗</a></p>`;
  }
  const parts: string[] = [];
  if (cite?.source) parts.push(`<cite>${escapeHtml(cite.source)}</cite>`);
  if (cite?.author) parts.push(escapeHtml(cite.author));
  if (cite?.excerpt) parts.push(`&ldquo;${escapeHtml(cite.excerpt)}&rdquo;`);
  if ("id" in stub) parts.push(`item <code>${escapeHtml(stub.id)}</code>, v${stub.version}`);
  parts.push(`&lt;<a href="${escapeHref(url)}">${escapeHtml(url)}</a>&gt;`);
  if (cite?.retrieved) parts.push(`retrieved ${formatDate(cite.retrieved, tz)}`);
  return `<p class="stub-cite"><span class="label">In response to</span><br>${parts.join(" &middot; ")}</p>`;
}

/**
 * An item's lineage line — the pinned version this one was forked from
 * (§2.4). Same apparatus, same reasoning, and the same frozen human half as
 * `stubCitation`: a citation that stops reading when the link dies has
 * stopped being a citation (Venkat, session 23).
 *
 * Two differences from a stub citation, both following from what the two
 * things are. Lineage belongs to the *item*, so it renders from `items`
 * rather than from a version row and appears on every representation of the
 * item including the withdrawal endcap — withdrawing your work does not
 * unmake where it came from. And the URL it names is a **pinned version**,
 * which is the only kind of URL a lineage pointer is allowed to name, because
 * it is the only one somebody promised to keep serving.
 */
/**
 * An item's own decision about highlighting its generated spans, as a class on
 * its <article>. No class means it follows the blyg's default, which lives in
 * style.css (`generatedHighlightCss`), so a page never needs the settings to
 * render an item and the default changes every page at once.
 */
/**
 * The version's generated[] disclosure (§5.7) on the element holding its
 * content, for the robot badge's info box (GEN_INFO_SCRIPT). Version-level by
 * design: the spec promises no span-level mapping. The version carousel
 * replaces it with the swapped-in version's own array.
 */
function generatedAttr(json: string | null | undefined): string {
  return json ? ` data-generated="${escapeHtml(json)}"` : "";
}

function highlightClass(item: { highlight_override?: number | null }): string {
  return item.highlight_override === 1 ? " gen-on" : item.highlight_override === 0 ? " gen-off" : "";
}

export function forkLineage(item: Pick<ItemRow, "forked_from" | "fork_cite">, tz: string, opts: { compact?: boolean } = {}): string {
  const fork = parseStoredFork(item.forked_from);
  if (!fork) return "";
  const cite = parseStoredCite(item.fork_cite);
  // Every fork freezes the URL it was fetched from into its citation (a
  // templated origin's included, §16.6e); the default pin path is only for
  // rows older than citations.
  const url = cite?.url ?? `${fork.origin}items/${fork.id}/v${fork.version}.json`;
  if (opts.compact) {
    const who = cite?.source ? `<cite>${escapeHtml(cite.source)}</cite>` : escapeHtml(url);
    return `<p class="stub-cite compact"><span class="label">Forked from</span> <a href="${escapeHref(url)}">${who} ↗</a></p>`;
  }
  const parts: string[] = [];
  if (cite?.source) parts.push(`<cite>${escapeHtml(cite.source)}</cite>`);
  if (cite?.author) parts.push(escapeHtml(cite.author));
  if (cite?.excerpt) parts.push(`&ldquo;${escapeHtml(cite.excerpt)}&rdquo;`);
  parts.push(`item <code>${escapeHtml(fork.id)}</code>, pinned v${fork.version}`);
  parts.push(`&lt;<a href="${escapeHref(url)}">${escapeHtml(url)}</a>&gt;`);
  if (cite?.retrieved) parts.push(`retrieved ${formatDate(cite.retrieved, tz)}`);
  return `<p class="stub-cite"><span class="label">Forked from</span><br>${parts.join(" &middot; ")}</p>`;
}

/** Cap on any string an origin asserts about itself before it reaches our page. */
function clampForeign(raw: string, max = 60): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > max ? graphemePrefix(flat, max - 1) + "…" : flat;
}

/**
 * The public responses list (§3.4, Venkat's session-23 ruling: shape A plus a
 * hide control, open to all origins). Opt-in per item, off by default.
 *
 * **This is chrome, not content.** It is rendered from `mentions_in` at
 * request time and appears in no item document, no feed, and no hash — which
 * is forced, not stylistic: putting responses in the versioned document would
 * let a stranger's publish change your bytes, which every subscriber's
 * importer would read as a stealth edit (decision #18b) or as a publish event
 * you never made (#19). Your versioned state stays yours.
 *
 * What it shows is bounded by what a verified mention *is* — a pointer. We
 * hold no content of theirs, so a line is: who (their self-asserted author
 * name, which #11 makes opaque and unguaranteed), the origin that actually
 * authenticated, the relation, and the date. The origin is rendered as the
 * load-bearing half, because it is the only part the protocol vouches for.
 */
export async function responsesSection(db: D1Database, item: ItemRow, settings: Settings, mount: string): Promise<string> {
  const tz = settings.timezone;
  // The item decides, or defers to the global default — one rule, in model.ts,
  // shared with the studio control that reports what is published.
  if (!itemShowsResponses(item, settings)) return "";
  const rows = await listPublicResponses(db, item.id);
  if (!rows.length) return "";
  const lines = rows.map((row) => {
    const host = row.source_origin ? new URL(row.source_origin).host : (row.source ? new URL(row.source).host : "");
    let who = "";
    if (row.source_author_json) {
      try {
        const author = JSON.parse(row.source_author_json) as { name?: string } | null;
        if (author?.name) who = clampForeign(author.name);
      } catch {
        // Their malformed author object is not our page's problem.
      }
    }
    const label = who ? `<span class="who">${escapeHtml(who)}</span> <span class="at-origin">at ${escapeHtml(host)}</span>` : `<span class="who">${escapeHtml(host)}</span>`;
    const rel = row.relation === "transclusion" ? "quoted this" : row.relation === "fork" ? "forked this" : "stubbed this";
    const when = row.verified_at ? ` <span class="when">&middot; ${formatDate(row.verified_at, tz)}</span>` : "";
    return `<li><a href="${escapeHtml(row.source_page ?? row.source)}">${label}</a> <span class="rel">&middot; ${rel}</span>${when}</li>`;
  });
  return `<section class="responses">
<h2>Responses</h2>
<ul>
${lines.join("\n")}
</ul>
</section>`;
}

async function withdrawnBlock(db: D1Database, item: ItemRow, mount: string, tz: string): Promise<string> {
  const isThread = (await authoredKind(db, item)) === "thread";
  return `<article class="fragment withdrawn"><p>This item was withdrawn.</p>
${forkLineage(item, tz)}
${itemMeta(item, null, await pinnedVersions(db, item.id), mount, isThread, tz)}
</article>`;
}

/**
 * Absolute URL of the first image on an item, for og:image. Falls back to the
 * avatar so a text-only item still unfurls with the blyg's face on it rather
 * than a blank card.
 */
async function socialImage(db: D1Database, settings: Settings, media: MediaRow[], origin: string): Promise<string | undefined> {
  const first = media[0];
  if (first) return origin + first.r2_key;
  const avatar = settings.avatar_media_id ? await getMedia(db, settings.avatar_media_id) : null;
  return avatar ? origin + avatar.r2_key : undefined;
}

/**
 * `<title>` for an item page. It used to be the bare site title on every
 * permalink, which made every item share one browser-tab label and one search
 * result heading — the excerpt is the only part that distinguishes them.
 */
function itemTitle(excerptText: string, settings: Settings): string {
  return excerptText ? `${excerptText} — ${settings.site_title}` : settings.site_title;
}

/**
 * **The author's own text**, for every surface that has to *name* an item in
 * one line — the page `<title>`, `og:title`, the meta description, the feed
 * card's excerpt, the RSS headline, the archive row.
 *
 * A thread's `content_html` contains other people's writing, baked in verbatim
 * as `blockquote.blyg-transclusion` (§10). That is correct for the thread's own
 * page, where the quote is displayed as a quote with a provenance line under it
 * and nobody can mistake whose words they are. It is **wrong for every derived
 * one-liner**, because flattening the HTML to text drops exactly the structure
 * that made the attribution legible.
 *
 * Measured on the live node before this was written: of 19 published threads,
 * 5 *opened* with a transclusion — so their browser tab, their search-result
 * heading, their social card, their RSS headline and their feed-page excerpt
 * were all someone else's sentence presented as the author's. A sixth ran the
 * author's prose straight into a quote mid-excerpt, with no boundary at all.
 *
 * The Studio index strips quotes and shows a count chip. The public surfaces
 * did not. Same shape as the two title bugs before it: one derivation that
 * several surfaces run, fixed in some of them.
 *
 * Returns HTML, not text, so callers can still split a leading heading off it.
 * A no-op on anything with no baked quotes, so fragments are unaffected.
 */
export function authorOwnHtml(html: string): string {
  return stripTransclusionQuotes(html);
}

/**
 * What to call a thread that quoted someone and said nothing of its own.
 *
 * Rare but real (1 of 19 live). The honest answer is not the quoted sentence —
 * that is the misattribution this whole helper exists to prevent — and not an
 * empty string either. A stub knows what it answers, so it says that.
 */
export function respondsToLabel(latest: Pick<VersionRow, "stub_of" | "stub_cite"> | null): string {
  const stub = parseStoredStub(latest?.stub_of ?? null);
  if (!stub) return "";
  const cite = parseStoredCite(latest?.stub_cite ?? null);
  const who = cite?.source ?? ("url" in stub ? new URL(stub.url).host : new URL(stub.origin).host);
  return `In response to ${who}`;
}

/**
 * The three derived strings an item's head needs: `<title>`, `og:title`, and
 * the description both the meta tag and the unfurled card use.
 *
 * Items stay titleless on the wire (§5.3) and nothing here changes that. But
 * an item that opens with a heading has declared a title in the only way the
 * protocol allows one to be declared, and #46 already makes that heading the
 * item's title on three other surfaces — the feed page, the permalink, the
 * studio reader. Reading it here is the same derivation a fourth time, not a
 * new field: before this, a titled item's `og:title` was an excerpt that had
 * swallowed its own heading ("On Protocols Protocols are the thin…"), which is
 * the one thing an unfurled card must not look like.
 *
 * The description is taken from what follows the heading, so a card does not
 * print the title twice. `og:title` carries no site suffix — `og:site_name`
 * is the tag that says where this is, and repeating it makes a narrower card.
 */
function itemHead(
  html: string,
  settings: Settings,
  fallback = "",
): { title: string; ogTitle: string; description: string } {
  // The author's own words, never a quoted one — see authorOwnHtml. A fragment
  // has no baked quotes, so this changes nothing for one.
  const own = authorOwnHtml(html);
  const { title, rest } = leadingHeading(own);
  const derived = title ? clampText(title, 70) : excerptFromHtml(own, 70) || clampText(fallback, 70);
  return {
    title: itemTitle(derived, settings),
    ogTitle: derived || settings.site_title,
    description: excerptFromHtml(title ? rest : own, 200) || fallback,
  };
}

/**
 * A leading `<h1>` is the item's title, so on the feed page it becomes the
 * link to that item's own page — the affordance a reader expects from a
 * titled post, and one the feed previously lacked entirely (the only way in
 * was the small "Permalink" line at the bottom).
 *
 * Presentation only, and deliberately so: the anchor is wrapped around the
 * *rendered* heading at render time and never touches the stored
 * `content_html`, exactly like `injectProvenance`. Item JSON, feed.xml and
 * the static export of the permalink page all keep the bare heading.
 *
 * Only a heading that *opens* the item counts. A `<h1>` further down is a
 * section head inside the piece, not its title, and linking it would be a
 * claim about structure the author did not make.
 */
export function linkLeadingTitle(html: string, href: string): string {
  const m = /^\s*<h1([^>]*)>([\s\S]*?)<\/h1>/.exec(html);
  if (!m) return html;
  // An <h1> that already contains a link is left alone — nesting anchors is
  // invalid HTML and the author's own link should win.
  if (/<a[\s>]/i.test(m[2])) return html;
  // Function replacement, so `$&` in a heading is text, not a pattern (studio#2).
  return html.replace(m[0], () => `<h1${m[1]}><a class="item-title" href="${href}">${m[2]}</a></h1>`);
}

/**
 * The blogroll, rendered for humans. §2.2 already publishes it as
 * `blogroll.opml` and advertises it with `rel="blogroll"`, which means it was
 * readable by feed readers and invisible to people — and a blogroll whose
 * whole purpose is to point readers at other blygs is the last thing that
 * should be machine-only. Same data, same `listBlogrollSubscriptions()`
 * source as the OPML file, so the two cannot disagree.
 */
function blogrollSection(subs: SubscriptionRow[], mount: string): string {
  if (!subs.length) return "";
  const rows = subs
    .map((sub) => {
      const label = escapeHtml(sub.title || sub.origin);
      // `kind: "rss"` is an L0 subscription — a plain feed, not a blyg. Worth
      // saying, because "this one is a blyg you can subscribe to natively" is
      // the distinction the blogroll exists to make visible.
      const mark = sub.kind === "blyg" ? '<span class="blyg-mark" title="a blyg">blyg</span> ' : "";
      return `<li>${mark}<a href="${escapeHtml(sub.origin)}">${label}</a></li>`;
    })
    .join("\n");
  return `<section class="blogroll">
<h2>Also reading</h2>
<ul>
${rows}
</ul>
<p class="blogroll-foot"><a href="${mount}/blogroll.opml">blogroll.opml</a> — import this list into your feed reader</p>
</section>`;
}

/**
 * Public hoppers, listed on the homepage and archive (0.24.0). A public hopper
 * page existed since v0.2 (decision #12: curation display, never re-emitted on
 * the feed), but nothing on the site linked to one, so a visitor could only
 * find it from a pasted URL. Presentation only; nothing here is on the wire.
 */
export function collectionsSection(hoppers: { name: string; slug: string | null; description: string | null; count: number }[], mount: string): string {
  const rows = hoppers
    .filter((h) => h.slug)
    .map((h) => {
      const desc = h.description ? ` <span class="collection-desc">${escapeHtml(h.description)}</span>` : "";
      return `<li><a href="${mount}/h/${encodeURIComponent(h.slug!)}/">${escapeHtml(h.name)}</a> <span class="meta">${h.count} ${h.count === 1 ? "item" : "items"}</span>${desc}</li>`;
    })
    .join("\n");
  if (!rows) return "";
  return `<section class="collections">
<h2>Collections</h2>
<ul>
${rows}
</ul>
</section>`;
}

export async function feedPage(db: D1Database, settings: Settings, items: FeedItem[], hasMore: boolean, mount: string, origin: string): Promise<string> {
  const [data, blogrollSubs, collections] = await Promise.all([loadFeedData(db, items, settings.avatar_media_id || ""), listBlogrollSubscriptions(db), listPublicHoppers(db)]);
  const blocks: string[] = [];
  for (const item of items) {
    // Withdrawn items don't appear on the feed page (rev-3 wireframe note) —
    // they still live in the archive listing and their permanent endcap URLs.
    if (item.kind === "fragment") blocks.push(await fragmentBlock(db, item, mount, settings.timezone, true, data.cards.get(item.id)));
    else if (item.kind === "thread") blocks.push(await threadCard(db, item, mount, settings.timezone, data.cards.get(item.id), data.provenance));
  }
  const body = `<div class="blyg">
${await pageTop(db, settings, mount, data.avatar)}
${blocks.join("\n") || '<p class="withdrawn">Nothing published yet.</p>'}
${hasMore ? `<footer class="older"><a href="${mount}/archive/">older items →</a></footer>` : ""}
${collectionsSection(collections, mount)}
${blogrollSection(blogrollSubs, mount)}
</div>
<script>${VERSION_NAV_SCRIPT}</script>`;
  // §2.2: publishers SHOULD emit rel="blogroll" on the HTML feed page when the blogroll is non-empty.
  const hasBlogroll = blogrollSubs.length > 0;
  // The bio is the blyg's own description of itself; with none set, the most
  // recent item is the best available summary of what this blyg is — and a
  // brand-new blyg has neither, in which case there is no description to emit.
  const newest = items[0];
  const description =
    settings.author_bio ||
    (newest ? excerptFromHtml(data.cards.get(newest.id)?.latest?.content_html ?? "", 200) : "");
  return layout(settings.site_title, body, mount, {
    hasBlogroll,
    description,
    url: origin,
    webmention: webmentionHref(settings, origin),
    image: data.avatar ? origin + data.avatar.r2_key : undefined,
    siteName: settings.site_title,
    feedUrl: `${origin}feed.xml`,
    feedTitle: settings.site_title,
  });
}

/**
 * The endpoint a page advertises, or `undefined` when this blyg does not accept
 * mentions — §15.1 again: the `rel="webmention"` link, like the manifest key,
 * exists only when there is something behind it. Advertising a 404 would send
 * every conformant sender on a wasted round trip.
 */
function webmentionHref(settings: Settings, origin: string): string | undefined {
  return settings.accept_mentions ? origin + WEBMENTION_PATH : undefined;
}

/**
 * An endcap page's head. A withdrawn item's text is gone by design, so there is
 * nothing to summarize and nothing to unfurl — the tags say what the page *is*,
 * and deliberately carry no image.
 */
function withdrawnMeta(settings: Settings, url: string, alternateJson?: string, webmention?: string, origin?: string): PageMeta {
  return {
    description: `A withdrawn item on ${settings.site_title}.`,
    url,
    type: "article",
    siteName: settings.site_title,
    alternateJson,
    webmention,
    ...(origin ? { feedUrl: `${origin}feed.xml`, feedTitle: settings.site_title } : {}),
  };
}

/**
 * Fragment permalink page — caller (index.ts) 404s if the item's authored kind
 * isn't fragment.
 *
 * The withdrawn endcap deliberately gets no version-nav script (session 21).
 * Its pins still render as links — that is the point of a pin, it survives
 * withdrawal (§2.8) — but paging a pinned version *into* a page whose headline
 * says "This item was withdrawn" reads as a contradiction. The frozen page,
 * which wears its own banner, is the honest destination for withdrawn content.
 */
export async function permalinkPage(db: D1Database, settings: Settings, item: ItemRow, mount: string, origin: string): Promise<string> {
  const url = `${origin}f/${item.id}/`;
  const alternateJson = `${origin}items/${item.id}.json`;
  const webmention = webmentionHref(settings, origin);
  if (item.kind === "withdrawn") {
    return layout(
      `withdrawn — ${settings.site_title}`,
      `<div class="blyg">\n${await pageTop(db, settings, mount)}\n${await withdrawnBlock(db, item, mount, settings.timezone)}\n</div>`,
      mount,
      withdrawnMeta(settings, url, alternateJson, webmention, origin),
    );
  }
  const latest = await publishedVersion(db, item);
  const media = await listMediaForItem(db, item.id);
  const head = itemHead(latest?.content_html ?? "", settings);
  const body = `<div class="blyg">
${await pageTop(db, settings, mount)}
${await fragmentBlock(db, item, mount, settings.timezone)}
${await responsesSection(db, item, settings, mount)}
</div>
<script>${VERSION_NAV_SCRIPT}</script>`;
  return layout(head.title, body, mount, {
    description: head.description,
    ogTitle: head.ogTitle,
    url,
    alternateJson,
    webmention,
    type: "article",
    image: await socialImage(db, settings, visibleMedia(media, latest?.content_html ?? ""), origin),
    siteName: settings.site_title,
    feedUrl: `${origin}feed.xml`,
    feedTitle: settings.site_title,
  });
}

/** Thread permalink page (§2.9) — caller (index.ts) 404s if the item's authored kind isn't thread. */
export async function threadPage(db: D1Database, settings: Settings, item: ItemRow, mount: string, origin: string): Promise<string> {
  const url = `${origin}t/${item.id}/`;
  const alternateJson = `${origin}items/${item.id}.json`;
  const webmention = webmentionHref(settings, origin);
  if (item.kind === "withdrawn") {
    return layout(
      `withdrawn — ${settings.site_title}`,
      `<div class="blyg">\n${await pageTop(db, settings, mount)}\n${await withdrawnBlock(db, item, mount, settings.timezone)}\n</div>`,
      mount,
      withdrawnMeta(settings, url, alternateJson, webmention, origin),
    );
  }
  const latest = await publishedVersion(db, item);
  const media = await listMediaForItem(db, item.id);
  const head = itemHead(latest?.content_html ?? "", settings, respondsToLabel(latest));
  const body = `<div class="blyg">
${await pageTop(db, settings, mount)}
${await threadBlock(db, item, mount, settings.timezone)}
${await responsesSection(db, item, settings, mount)}
</div>
<script>${VERSION_NAV_SCRIPT}</script>`;
  return layout(head.title, body, mount, {
    description: head.description,
    ogTitle: head.ogTitle,
    url,
    alternateJson,
    webmention,
    type: "article",
    image: await socialImage(db, settings, visibleMedia(media, latest?.content_html ?? ""), origin),
    siteName: settings.site_title,
    feedUrl: `${origin}feed.xml`,
    feedTitle: settings.site_title,
  });
}

/**
 * Pinned-version HTML page — `{mount}/f/{id}/v{n}/`, `{mount}/t/{id}/v{n}/`
 * (session-18 decision, amending §2.8's session-5 "JSON only" via the additive
 * path that decision explicitly reserved; demand demonstrated by Venkat
 * clicking a pin citation and getting raw JSON).
 *
 * The pin's *promise* stays the JSON file — this page is presentation of the
 * same already-promised bytes: the version's stored publish-time content_html,
 * verbatim, never re-rendered. What the page adds is human legibility: a
 * frozen banner (a reader must never mistake a snapshot for the live item), a
 * canonical link to the live permalink (the living page is the one to index),
 * and a pointer to the JSON twin (machine citation ↔ human citation).
 *
 * Deliberately NOT here: feed/archive/index membership (pinning is not a
 * publish event), any new wire vocabulary, any route for unpinned versions
 * (withheld-unless-pinned is what keeps withdrawal meaningful).
 */
export async function pinnedVersionPage(
  db: D1Database,
  settings: Settings,
  item: ItemRow,
  row: VersionRow,
  isThread: boolean,
  mount: string,
  origin: string,
): Promise<string> {
  const tz = settings.timezone;
  const live = `${mount}/${isThread ? "t" : "f"}/${item.id}/`;
  const html = isThread
    ? injectProvenance(await sanitizeHtml(row.content_html), await transclusionProvenance(db, parseTransclusions(row.transclusions), mount))
    : row.content_html;
  const noteHtml = row.note ? `<p class="version-note">&ldquo;${escapeHtml(row.note)}&rdquo;</p>` : "";
  // A pin is a frozen artifact of a response, so it carries the citation that
  // was true when it froze — not whatever the live item cites now.
  const cite = isThread ? stubCitation(row, tz) : "";
  const body = `<div class="blyg">
${await pageTop(db, settings, mount)}
<p class="pinned-banner">📌 Pinned v${row.version} — a frozen snapshot from ${formatDate(row.published_at, tz)}.
<a href="${live}">latest version</a> &middot; <a href="${mount}/items/${item.id}/v${row.version}.json">citable JSON</a></p>
<article class="${isThread ? "thread" : "fragment"}${highlightClass(item)}"${generatedAttr(row.generated_json)}>
${cite}
${forkLineage(item, tz)}
<div class="item-content">${html}</div>
${noteHtml}
<p class="timestamps"><span>Published: ${formatDate(row.published_at, tz)}</span></p>
</article>
</div>`;
  // Canonical points at the live permalink (absolute — origin is the blyg
  // base URL, trailing slash included): the frozen page is a version of the
  // same work, and the living one is the page that should be indexed.
  const canonical = `${origin}${isThread ? "t" : "f"}/${item.id}/`;
  // `{excerpt} (v1) — {site}`, not `v1 — {excerpt} — {site}`: the version is a
  // qualifier on the item, and three em-dash-separated segments is one too many.
  // The name is derived from the pinned bytes by the same rule as a live item's
  // (a declared heading, else an excerpt) — a title is part of what froze.
  const pinnedHead = itemHead(row.content_html, settings, respondsToLabel(row));
  const pinnedName = pinnedHead.ogTitle === settings.site_title ? "" : pinnedHead.ogTitle;
  const pinnedTitle = pinnedName
    ? `${pinnedName} (v${row.version}) — ${settings.site_title}`
    : `v${row.version} — ${settings.site_title}`;
  return layout(pinnedTitle, body, mount, {
    canonical,
    // The excerpt comes from the *pinned* version's own bytes, so a citation
    // unfurls as the text that was actually frozen, not the live text.
    description: pinnedHead.description,
    ogTitle: pinnedName ? `${pinnedName} (v${row.version})` : `v${row.version}`,
    url: `${origin}${isThread ? "t" : "f"}/${item.id}/v${row.version}/`,
    type: "article",
    // The blyg's avatar, never the item's attachments: a live lookup of the
    // item's media would put today's image on a page whose whole promise is
    // that it shows the bytes from then. Site identity is true either way.
    image: await socialImage(db, settings, [], origin),
    siteName: settings.site_title,
    feedUrl: `${origin}feed.xml`,
    feedTitle: settings.site_title,
  });
}

export async function archivePage(db: D1Database, settings: Settings, items: ItemRow[], mount: string, origin: string): Promise<string> {
  const tz = settings.timezone;
  const rows: string[] = [];
  for (const item of items) {
    // A withdrawn row is a link like any other: the endcap page is a real,
    // permanent URL (§2.8) and is where a reader learns which versions stay
    // citable. Its authored kind picks the route — `kind` is 'withdrawn' by
    // then, so it cannot say whether this was a fragment or a thread.
    if (item.kind === "withdrawn") {
      const href = `${mount}/${(await authoredKind(db, item)) === "thread" ? "t" : "f"}/${item.id}/`;
      rows.push(
        `<li class="withdrawn"><span class="row-main"><a href="${href}">withdrawn</a></span><span class="meta">${formatDate(item.updated, tz)}</span></li>`,
      );
      continue;
    }
    const isThread = item.kind === "thread";
    const latest = await publishedVersion(db, item);
    // The archive was the fourth surface that names an item and the one #46
    // did not reach, so a titled item listed as "On Protocols Protocols are
    // the thin layer where…" — the heading, then the heading again as the
    // first words of the body, because an 80-character excerpt of the whole
    // rendered HTML cannot see that the first block was a title. Split it the
    // way every other surface does: the link is the title, the dimmed tail is
    // what follows it. An untitled item is unchanged.
    // Same rule as the card and the head: an archive row names the item, so it
    // names it in the author's own words.
    const own = authorOwnHtml(latest?.content_html ?? "");
    const { title, rest } = leadingHeading(own);
    const linkText =
      (title ? clampText(title, 80) : excerptFromHtml(own, 80)) || clampText(respondsToLabel(latest), 80);
    const tail = title ? excerptFromHtml(rest, 60) : "";
    const href = `${mount}/${isThread ? "t" : "f"}/${item.id}/`;
    rows.push(
      `<li><span class="row-main">${isThread ? '<span class="kind-chip">thread</span> ' : ""}<a href="${href}">${escapeHtml(linkText)}</a>${tail ? ` <span class="row-sub">${escapeHtml(tail)}</span>` : ""}</span><span class="meta">${formatDate(item.updated, tz)} · v${item.version}</span></li>`,
    );
  }
  const body = `<div class="blyg">
${await pageTop(db, settings, mount)}
<h2>Archive</h2>
<ul class="archive">
${rows.join("\n")}
</ul>
${collectionsSection(await listPublicHoppers(db), mount)}
</div>`;
  return layout(`archive — ${settings.site_title}`, body, mount, {
    description: `Every item published on ${settings.site_title}.`,
    ogTitle: `Archive — ${settings.site_title}`,
    url: `${origin}archive/`,
    image: await socialImage(db, settings, [], origin),
    siteName: settings.site_title,
    feedUrl: `${origin}feed.xml`,
    feedTitle: settings.site_title,
  });
}
