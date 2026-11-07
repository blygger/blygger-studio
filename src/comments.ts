// Comments to self: `/* … */` in a working copy. Studio-private grammar, the
// same standing as TK (decision #70): the working copy keeps a comment across
// saves and publishes, and publish() removes it before anything is hashed,
// rendered or stored, so the wire only ever sees ordinary text.
//
// Every rule here leans towards keeping a note private. Anything ambiguous
// refuses the publish rather than guessing, because a wrong guess publishes
// words the author wrote for nobody else.

import { codeRanges, inRanges } from "./code-ranges.ts";

export interface CommentRange {
  /** Offsets into the source string: the opening token, and just past the closing one. */
  start: number;
  end: number;
}

export interface CommentIssue {
  at: number;
  reason: string;
}

export interface ParsedComments {
  /** The source with every comment gone and the whitespace around each tidied. */
  text: string;
  ranges: CommentRange[];
  /** Non-empty means publish must refuse. `text` is then only good for a preview. */
  errors: CommentIssue[];
}

/** Thrown by model.publish() when comments make the working copy unsafe to publish. */
export class CommentPublishError extends Error {
  constructor(public readonly issues: CommentIssue[]) {
    super("comments are not publish-ready");
  }
}

/** A token escaped by an odd run of backslashes is markdown's literal text, on the wire as written. */
function escaped(text: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

function findOpener(text: string, from: number, code: ReturnType<typeof codeRanges>): number {
  let at = text.indexOf("/*", from);
  while (at !== -1 && (inRanges(code, at) || escaped(text, at))) at = text.indexOf("/*", at + 2);
  return at;
}

// Where a comment body ends, as an offset into `body`, or -1. A closer in code
// doesn't close, and neither does one inside a whole TK scope, whose generated
// output can say anything. A `[TK]` with no `[/TK]` is just text here.
function findCloser(body: string): number {
  const code = codeRanges(body);
  let at = 0;
  while (true) {
    const close = body.indexOf("*/", at);
    if (close === -1) return -1;
    const scope = body.indexOf("[TK]", at);
    if (scope !== -1 && scope < close && !inRanges(code, scope)) {
      const end = body.indexOf("[/TK]", scope);
      if (end !== -1) {
        at = end + 5;
        continue;
      }
    }
    if (!inRanges(code, close) && !escaped(body, close)) return close;
    at = close + 2;
  }
}

const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;

/** Removal leaves what the author would have typed without the comment. */
function closeUp(before: string, after: string): [string, string] {
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineBefore = before.slice(lineStart);
  const newline = after.indexOf("\n");
  const lineAfter = newline === -1 ? after : after.slice(0, newline);
  const startsLine = !lineBefore.trim();
  const endsLine = !lineAfter.trim();

  if (startsLine && endsLine) {
    // The comment had its lines to itself, so they go.
    let head = before.slice(0, lineStart);
    const hadNewline = newline !== -1;
    let tail = hadNewline ? after.slice(newline + 1) : "";
    if (!head || /\n[ \t]*\n$/.test(head)) tail = tail.replace(/^(?:[ \t]*\n)+/, "");
    if (!tail) head = head.replace(/\s+$/, "") + (head.trim() && hadNewline ? "\n" : "");
    return [head, tail];
  }
  if (startsLine) return [before, after.replace(/^[ \t]+/, "")];
  // Spaces left at a line's end would be a hard break, or just noise.
  if (endsLine) return [before.replace(/[ \t]+$/, ""), after.replace(/^[ \t]+/, "")];
  if (/[ \t]$/.test(before)) {
    if (/^[ \t]*[.,;:!?)\]]/.test(after)) return [before.replace(/[ \t]+$/, ""), after.replace(/^[ \t]+/, "")];
    return [before, after.replace(/^[ \t]+/, "")];
  }
  return [before, after];
}

// A closer still in the text once comments are gone: usually a comment that
// closed early because comments don't nest, with the rest of a note now about
// to publish. Attached to a word (`**bold**/`) it is ordinary prose.
function strayClosers(text: string): CommentIssue[] {
  const issues: CommentIssue[] = [];
  const code = codeRanges(text);
  for (const m of text.matchAll(/\*\//g)) {
    const at = m.index!;
    const start = at === 0 || /\s/.test(text[at - 1]);
    if (!start || inRanges(code, at) || escaped(text, at)) continue;
    const near = text.slice(Math.max(0, at - 30), at).trim().split("\n").pop();
    issues.push({ at, reason: `a */ with no comment to close${near ? `, after "${near}"` : ""}. Comments don't nest: this text would publish. Write \\*/ if you meant it literally` });
  }
  return issues;
}

/**
 * Find every comment in a working copy. Code is judged on the text as it will
 * publish, earlier comments removed, so a stray backtick in a note can't turn
 * later prose into code and hide the next comment's opener.
 */
export function parseComments(md: string): ParsedComments {
  if (!md.includes("/*") && !md.includes("*/")) return { text: md, ranges: [], errors: [] };
  const ranges: CommentRange[] = [];
  let kept = "";
  let rest = md;
  while (true) {
    const scan = kept + rest;
    const open = findOpener(scan, kept.length, rest.includes("/*") ? codeRanges(scan) : []);
    if (open === -1) break;
    const source = md.length - rest.length + (open - kept.length);
    const body = scan.slice(open + 2);
    const close = findCloser(body);
    if (close === -1) {
      ranges.push({ start: source, end: md.length });
      return {
        text: closeUp(scan.slice(0, open), "")[0],
        ranges,
        errors: [{ at: source, reason: `a comment opened on line ${lineOf(md, source)} is never closed with */. Close it, or write \\/* if you meant it literally` }],
      };
    }
    const after = body.slice(close + 2);
    ranges.push({ start: source, end: md.length - after.length });
    [kept, rest] = closeUp(scan.slice(0, open), after);
  }
  const text = kept + rest;
  return { text, ranges, errors: strayClosers(text) };
}

export const withoutComments = (md: string) => parseComments(md).text;

/** For the Studio preview, which never refuses: what would stop a publish, said where the author is looking. */
export function previewComments(md: string): string {
  const { text, errors } = parseComments(md);
  return errors.length ? `${text}\n\n${errors.map((e) => `⚠ ${e.reason.replace(/[*\\]/g, "\\$&")}.`).join("\n\n")}` : text;
}

/** Do two working copies differ only in their comments? False if neither holds one, or either is malformed. */
export function sameOutsideComments(a: string, b: string): boolean {
  const left = parseComments(a);
  const right = parseComments(b);
  if (left.errors.length || right.errors.length) return false;
  return (left.ranges.length > 0 || right.ranges.length > 0) && left.text === right.text;
}

/**
 * The document with every comment gone except any holding `at`, and `at`'s new
 * offset: the context for a TK scope. A note is not for the model to draw on,
 * since what it draws on publishes, unless the scope is itself inside the note.
 */
export function outsideOtherComments(md: string, at: number): { text: string; offset: (position: number) => number } {
  const { ranges } = parseComments(md);
  const others = ranges.filter((r) => at < r.start || at >= r.end);
  let text = "";
  let last = 0;
  for (const r of others) {
    text += md.slice(last, r.start);
    last = r.end;
  }
  text += md.slice(last);
  const offset = (position: number) => others.reduce((p, r) => (r.end <= position ? p - (r.end - r.start) : p), position);
  return { text, offset };
}
