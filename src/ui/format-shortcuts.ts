// Cmd/Ctrl+B, I and K in the editors: markdown's bold, italic and link, written
// into the text as if typed, so the browser's own undo takes them back.
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

/** The textarea's onKeyDown. Fires its input event, so the editor's onChange sees the edit. */
export function onFormatKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
  const el = event.currentTarget;
  const kind = formatKey(event, isMac());
  if (!kind || el.readOnly) return;
  event.preventDefault();
  const edit = formatEdit(el.value, el.selectionStart, el.selectionEnd, kind);
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
