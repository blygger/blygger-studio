// Cmd/Ctrl+B, I and K in the editors: markdown's bold, italic and link, written
// into the text as if typed, so the browser's own undo takes them back.
// Also the keys for markdown's structure, which a textarea makes awkward: Tab and
// Shift+Tab move a list item in and out, and Shift+Enter breaks a line without
// ending the paragraph (verse, addresses).
export type FormatKind = 'bold' | 'italic' | 'link';
export interface FormatEdit {
  /** Replace [from, to) with insert, then select [start, end). */
  from: number;
  to: number;
  insert: string;
  start: number;
  end: number;
}

const stars = (s: string) => /^\**/.exec(s)![0].length;
const endStars = (s: string) => /\**$/.exec(s)![0].length;
// Asterisks in a run mean: 1 italic, 2 bold, 3 both. So bold is 2 or more, italic is odd.
const isOn = (run: number, kind: 'bold' | 'italic') => (kind === 'bold' ? run >= 2 : run % 2 === 1);
const width = (kind: 'bold' | 'italic') => (kind === 'bold' ? 2 : 1);

function wrapLine(line: string, kind: 'bold' | 'italic', on: boolean): string {
  const w = width(kind);
  const core = line.trim();
  const lead = line.slice(0, line.length - line.trimStart().length);
  const tail = line.slice(line.trimEnd().length);
  const mark = '*'.repeat(w);
  return lead + (on ? mark + core + mark : core.slice(w, core.length - w)) + tail;
}

function emphasis(text: string, from: number, to: number, kind: 'bold' | 'italic'): FormatEdit {
  const picked = text.slice(from, to);
  // Across lines each line is wrapped on its own: emphasis cannot span a paragraph.
  if (picked.includes('\n')) {
    const lines = picked.split('\n');
    const filled = lines.filter((l) => l.trim());
    const allOn = filled.length > 0 && filled.every((l) => {
      const core = l.trim();
      return isOn(Math.min(stars(core), endStars(core)), kind);
    });
    const insert = lines.map((l) => (l.trim() ? wrapLine(l, kind, !allOn) : l)).join('\n');
    return { from, to, insert, start: from, end: from + insert.length };
  }
  // Spaces stay outside the markers, or markdown does not read them as emphasis.
  const lead = picked.length - picked.trimStart().length;
  const tail = picked.length - picked.trimEnd().length;
  const a = picked.trim() ? from + lead : from;
  const b = picked.trim() ? to - tail : to;
  const w = width(kind);
  const inner = text.slice(a, b);
  // Markers selected along with the words.
  const innerRun = Math.min(stars(inner), endStars(inner));
  if (inner && inner.length > innerRun * 2 && isOn(innerRun, kind)) {
    const bare = inner.slice(w, inner.length - w);
    return { from: a, to: b, insert: bare, start: a, end: a + bare.length };
  }
  // Markers just outside the selection, or around the caret.
  const run = Math.min(endStars(text.slice(0, a)), stars(text.slice(b)));
  if (isOn(run, kind)) {
    return { from: a - w, to: b + w, insert: inner, start: a - w, end: a - w + inner.length };
  }
  const mark = '*'.repeat(w);
  return { from: a, to: b, insert: mark + inner + mark, start: a + w, end: a + w + inner.length };
}

function link(text: string, from: number, to: number): FormatEdit {
  const picked = text.slice(from, to);
  if (/^https?:\/\/\S+$/.test(picked)) {
    // A URL selected: it is the target, and the caret goes to the words.
    return { from, to, insert: `[](${picked})`, start: from + 1, end: from + 1 };
  }
  const insert = `[${picked}]()`;
  // Words selected: the caret waits for the URL. Nothing selected: for the words.
  const at = picked ? from + insert.length - 1 : from + 1;
  return { from, to, insert, start: at, end: at };
}

export function formatEdit(text: string, from: number, to: number, kind: FormatKind): FormatEdit {
  return kind === 'link' ? link(text, from, to) : emphasis(text, from, to, kind);
}

const LIST_LINE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
/**
 * Four spaces: enough to nest under any bullet or number markdown allows up to
 * `99.`, and the one indent every markdown renderer agrees is a sublist.
 */
const INDENT = '    ';
/** [from, to) widened to whole lines. A selection ending at a line's start does not take that line. */
function lineSpan(text: string, from: number, to: number) {
  const start = text.lastIndexOf('\n', from - 1) + 1;
  const last = to > from && text[to - 1] === '\n' ? to - 1 : to;
  const end = text.indexOf('\n', last);
  return { start, end: end < 0 ? text.length : end };
}
/**
 * Move the list items under the selection one level in or out. Null when a line
 * there is not a list item (or nothing would move), so Tab keeps its usual meaning.
 */
export function indentEdit(text: string, from: number, to: number, out: boolean): FormatEdit | null {
  const { start, end } = lineSpan(text, from, to);
  const lines = text.slice(start, end).split('\n');
  if (!lines.some((line) => line.trim()) || !lines.every((line) => !line.trim() || LIST_LINE.test(line))) return null;
  const moved = lines.map((line) => (!line.trim() ? line : out ? line.replace(/^(?: {1,4}|\t)/, '') : INDENT + line));
  // A numbered item that opens a sublist must be number 1: markdown reads any other
  // number straight after its parent's text as more of that text, not as a list.
  if (!out) {
    const first = lines.findIndex((line) => line.trim());
    const depth = /^[ \t]*/.exec(moved[first]!)![0];
    const above = text.slice(0, start).trimEnd().split('\n').pop() ?? '';
    // With no list above to go under, four spaces would make the line a code block.
    if (!LIST_LINE.test(above) && !/^[ \t]+\S/.test(above)) return null;
    const continues = lines.slice(0, first).length === 0 && above.startsWith(depth) && /^\d{1,9}[.)]/.test(above.slice(depth.length));
    if (!continues) moved[first] = moved[first]!.replace(/^([ \t]*)\d{1,9}([.)])/, '$11$2');
  }
  const insert = moved.join('\n');
  if (insert === lines.join('\n')) return null;
  if (from !== to) return { from: start, to: end, insert, start, end: start + insert.length };
  // A caret stays on its character; one inside the removed indent goes to the line's start.
  const caret = Math.max(start, from + moved[0]!.length - lines[0]!.length);
  return { from: start, to: end, insert, start: caret, end: caret };
}

/** Whether `at` is inside a fenced code block, where a backslash is a backslash. */
function inFence(text: string, at: number) {
  let open: string | null = null;
  for (const line of text.slice(0, at).split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence) continue;
    if (!open) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length && !line.trim().slice(fence.length)) open = null;
  }
  return open !== null;
}
/**
 * A line break that is not a paragraph break: markdown's backslash at the end of
 * the line. The backslash form, not two trailing spaces, because it can be seen.
 */
export function breakEdit(text: string, from: number, to: number): FormatEdit {
  const before = text.slice(0, from);
  const line = before.slice(before.lastIndexOf('\n') + 1);
  // Nothing to break after on an empty line, and a line already ending in one needs no second.
  const plain = !line.trim() || /\\$/.test(line) || inFence(text, from);
  const insert = plain ? '\n' : '\\\n';
  return { from, to, insert, start: from + insert.length, end: from + insert.length };
}

/** A fenced code block around the selected lines, or an empty one with the caret inside. */
export function codeBlockEdit(text: string, from: number, to: number): FormatEdit {
  const picked = text.slice(from, to);
  // A block starts on its own line with a blank line before it, and ends the same way.
  const lead = from === 0 || text.slice(0, from).endsWith('\n\n') ? '' : text[from - 1] === '\n' ? '\n' : '\n\n';
  const rest = text.slice(to);
  const tail = !rest || rest.startsWith('\n\n') ? '' : rest.startsWith('\n') ? '\n' : '\n\n';
  const body = picked.replace(/\n$/, '');
  const insert = `${lead}\`\`\`\n${body}\n\`\`\`${tail}`;
  const inside = from + lead.length + 4;
  return { from, to, insert, start: inside, end: inside + body.length };
}

/**
 * A formula (#105): the selection between dollars, or an empty pair with the
 * caret inside. A selection that runs over a line break, or one already in
 * dollars, is displayed (`$$…$$`); a word or two is inline.
 */
export function formulaEdit(text: string, from: number, to: number): FormatEdit {
  const picked = text.slice(from, to);
  const mark = picked.includes('\n') ? '$$' : '$';
  const inner = picked.trim() ? picked.trim() : '';
  const insert = `${mark}${inner}${mark}`;
  const start = from + mark.length;
  return { from, to, insert, start, end: start + inner.length };
}

const KEYS: Record<string, FormatKind> = { b: 'bold', i: 'italic', k: 'link' };

/**
 * Which format a key press asks for. Cmd on a Mac, where Ctrl+B and Ctrl+K are
 * the system's own text-field motions (back a character, delete to line end).
 */
export function formatKey(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, mac: boolean): FormatKind | null {
  if (event.altKey || event.shiftKey) return null;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  return KEYS[event.key.toLowerCase()] ?? null;
}

const isMac = () => /mac|iphone|ipad/i.test(navigator.platform);

/** Which structural edit a key press asks for, if any. */
export function structureKey(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): 'indent' | 'outdent' | 'break' | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === 'Tab') return event.shiftKey ? 'outdent' : 'indent';
  return event.key === 'Enter' && event.shiftKey ? 'break' : null;
}

/** The textarea's onKeyDown. Fires its input event, so the editor's onChange sees the edit. */
export function onFormatKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
  const el = event.currentTarget;
  // A picker that took the key (Tab or Enter choosing a row) keeps it.
  if (el.readOnly || event.defaultPrevented || event.nativeEvent.isComposing) return;
  const [from, to] = [el.selectionStart, el.selectionEnd];
  const kind = formatKey(event, isMac());
  const structure = kind ? null : structureKey(event);
  const edit = kind
    ? formatEdit(el.value, from, to, kind)
    : structure === 'break'
      ? breakEdit(el.value, from, to)
      : structure
        ? indentEdit(el.value, from, to, structure === 'outdent')
        : null;
  // Tab off a list line moves focus on, as it does in any form.
  if (!edit) return;
  event.preventDefault();
  applyEdit(el, edit);
}

/** Write an edit into the textarea as if typed, and leave the selection where the edit says. */
export function applyEdit(el: HTMLTextAreaElement, edit: FormatEdit) {
  el.focus({ preventScroll: true });
  el.setSelectionRange(edit.from, edit.to);
  // insertText is what keeps the edit on the undo stack; empty insert means delete.
  const done = edit.insert ? document.execCommand('insertText', false, edit.insert) : document.execCommand('delete');
  if (!done) {
    el.setRangeText(edit.insert, edit.from, edit.to);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.setSelectionRange(edit.start, edit.end);
  el.dispatchEvent(new Event('selectionchange'));
}
