/*
 * Speculative authoring, the editor half (studio-only; no wire change).
 *
 * Writing top-down, the author types `[[some text]]` for an item they mean to
 * write later. When the closing `]]` is typed, the studio creates that item —
 * an empty fragment draft marked as a placeholder — and rewrites the brackets
 * in place to `[[id | some text]]`, the label grammar of decision #70. The
 * author always sees the id; one undo puts `[[some text]]` back and discards
 * the draft if it is still untouched.
 *
 * Pure: which text mints, where, and what it becomes. The calls live in the
 * bracket picker (picker.tsx), which also offers *create placeholder* for a
 * query that is still being typed.
 *
 * When it does **not** fire, and why:
 *  - contents that are id-shaped, or nearly (a 20+ character run of the id
 *    alphabet): under the label grammar a mistyped id would silently mint an
 *    item, so anything that looks like an attempt at an id is left alone;
 *  - `![[…]]`: a quote or a TK source names something that already exists;
 *  - inside code (the grammar is inert there, §10.1, #54) and inside a `[TK]`
 *    scope, instruction or output (generated text is not grammar, studio#5);
 *  - across a line, or around brackets of its own.
 */
import { codeRanges, inRanges } from '../code-ranges.ts';
import { linkSource } from '../grammar.ts';
import { ID_ALPHABET } from '../identity.ts';
import { placeholderLabel } from '../placeholder-label.ts';

const ID_SHAPED = new RegExp(`^[${ID_ALPHABET}]{26}`);
const NEAR_ID = new RegExp(`^[${ID_ALPHABET}]{20,}$`);

/** Text inside `[[…]]` that may mint a placeholder: what the label would be, or null. */
export function mintableLabel(contents: string): string | null {
  const trimmed = contents.trim();
  if (!trimmed || /[\n[\]]/.test(contents)) return null;
  if (ID_SHAPED.test(trimmed) || NEAR_ID.test(trimmed.toLowerCase())) return null;
  return placeholderLabel(trimmed) || null;
}

/**
 * Is `at` after a backtick run that nothing has closed yet, in its paragraph?
 * Typing a code span left to right, `[[…]]` is closed before the span is, so
 * the code rule alone would mint inside what is about to become code.
 */
function inOpenCodeSpan(text: string, at: number): boolean {
  const para = text.lastIndexOf('\n\n', at) + 1;
  const before = text.slice(para, at);
  const code = codeRanges(before);
  return [...before.matchAll(/`+/g)].some((run) => !inRanges(code, run.index ?? 0));
}

/** Is `at` inside a `[TK]` scope (opened before it and not yet closed)? */
function inTkScope(text: string, at: number): boolean {
  const before = text.slice(0, at);
  return before.lastIndexOf('[TK]') > before.lastIndexOf('[/TK]');
}

export interface PlaceholderSite {
  /** Where the `[[` starts. */
  start: number;
  /** Just after the `]]`. */
  end: number;
  /** The text as typed, `[[some text]]`. */
  original: string;
  /** What the placeholder is called. */
  label: string;
}

/**
 * The `[[some text]]` the caret has just closed, if it should mint: the text
 * right before the caret ends in `]]`, and its `[[` is on the same line.
 */
export function closedPlaceholder(text: string, caret: number): PlaceholderSite | null {
  if (text.slice(caret - 2, caret) !== ']]') return null;
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const open = text.lastIndexOf('[[', caret - 3);
  if (open < lineStart) return null;
  if (open > 0 && text[open - 1] === '!') return null;
  const label = mintableLabel(text.slice(open + 2, caret - 2));
  if (label === null) return null;
  if (inRanges(codeRanges(text), open) || inOpenCodeSpan(text, open) || inTkScope(text, open)) return null;
  return { start: open, end: caret, original: text.slice(open, caret), label };
}

/**
 * Did this edit close a `[[…]]` that should mint? Only a typed `]` closing it
 * counts — one character inserted at the caret — never a paste or a load, so
 * opening a draft that already holds `[[some text]]` mints nothing.
 */
export function placeholderAfterTyping(previous: string, next: string, caret: number): PlaceholderSite | null {
  if (next.length !== previous.length + 1 || next[caret - 1] !== ']') return null;
  if (next.slice(0, caret - 1) + next.slice(caret) !== previous) return null;
  return closedPlaceholder(next, caret);
}

/**
 * Where the site is in `text` now, which may have moved while the item was
 * being created: in place, else its one other occurrence; null when it is
 * gone or ambiguous, and the caller gives up.
 */
export function locateSite(text: string, site: PlaceholderSite): number | null {
  if (text.slice(site.start, site.start + site.original.length) === site.original) return site.start;
  const first = text.indexOf(site.original);
  if (first < 0 || text.indexOf(site.original, first + 1) >= 0) return null;
  return first;
}

/**
 * Would the site still mint where it now stands? Checked again when the item
 * comes back, since the text kept changing meanwhile (a code span closed
 * around it, a `!` typed before it). A site from the picker is still open.
 */
export function stillMintable(text: string, at: number): boolean {
  if (at > 0 && text[at - 1] === '!') return false;
  return !inRanges(codeRanges(text), at) && !inOpenCodeSpan(text, at) && !inTkScope(text, at);
}

/** `[[some text]]` at `at` rewritten to `[[id | some text]]`, with the caret carried along. */
export function rewriteSite(text: string, at: number, site: PlaceholderSite, id: string, caret: number) {
  const link = linkSource(id, site.label);
  const end = at + site.original.length;
  const next = text.slice(0, at) + link + text.slice(end);
  const delta = link.length - site.original.length;
  return { text: next, caret: caret >= end ? caret + delta : caret > at ? at + link.length : caret, link };
}
