/*
 * Editor marks (docs/extensions.md, "Editor marks"): underlines an editor bar draws on the
 * text box's text, such as misspellings. A textarea can't style part of its text, so the
 * marks are drawn in a layer laid exactly over it: the same box, font, padding and
 * wrapping, its text transparent, scrolled with it, and taking no pointer events, so the
 * author types, selects and scrolls the text box as ever. The text is never changed.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { change } from './editor-regions.ts';
import type { EditorMark } from './extension-api.ts';

const WORDY = /[\p{L}\p{N}'’]/u;

/**
 * Marks made against `before`, moved to `after`: shifted by the edit, or dropped where it
 * touched them. Text put right against a mark drops it when it joins the marked word (a
 * letter typed onto it), and leaves it when it doesn't (a space or punctuation).
 */
export function rebaseMarks(marks: readonly EditorMark[], before: string, after: string): EditorMark[] {
  if (before === after) return [...marks];
  const { start, end, inserted } = change(before, after);
  const shift = inserted - (end - start);
  const added = after.slice(start, start + inserted);
  return marks.flatMap((mark) => {
    if (mark.end < start || (mark.end === start && !WORDY.test(added.slice(0, 1)))) return [mark];
    if (mark.start > end || (mark.start === end && !WORDY.test(added.slice(-1)))) return [{ ...mark, start: mark.start + shift, end: mark.end + shift }];
    return [];
  });
}

/** The text in runs, each marked or not, for the layer. Marks are clamped, sorted, and an overlap keeps the first. */
export function markRuns(text: string, marks: readonly EditorMark[]): { text: string; mark?: EditorMark }[] {
  const sorted = marks
    .map((mark) => ({ ...mark, start: Math.max(0, Math.min(mark.start, text.length)), end: Math.max(0, Math.min(mark.end, text.length)) }))
    .filter((mark) => mark.end > mark.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const runs: { text: string; mark?: EditorMark }[] = [];
  let at = 0;
  for (const mark of sorted) {
    if (mark.start < at) continue;
    if (mark.start > at) runs.push({ text: text.slice(at, mark.start) });
    runs.push({ text: text.slice(mark.start, mark.end), mark });
    at = mark.end;
  }
  if (at < text.length) runs.push({ text: text.slice(at) });
  return runs;
}

const COPIED = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent', 'textTransform',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'] as const;

/** The marks over a text box. Renders nothing without marks. */
export function MarksLayer({ input, text, marks }: { input: RefObject<HTMLTextAreaElement | null>; text: string; marks: readonly EditorMark[] }) {
  const layer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const sync = () => {
    const el = input.current;
    const box = layer.current;
    if (!el || !box || !inner.current) return;
    const style = getComputedStyle(el);
    for (const key of COPIED) box.style[key] = style[key];
    const borders = (a: string, b: string) => parseFloat(a) + parseFloat(b);
    // The text box's own width less its scrollbar, so the text wraps where the box's does.
    Object.assign(box.style, {
      top: `${el.offsetTop}px`,
      left: `${el.offsetLeft}px`,
      width: `${el.clientWidth + borders(style.borderLeftWidth, style.borderRightWidth)}px`,
      height: `${el.clientHeight + borders(style.borderTopWidth, style.borderBottomWidth)}px`,
    });
    inner.current.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
  };
  useLayoutEffect(sync);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    el.addEventListener('scroll', sync);
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', sync);
    };
  }, [marks.length > 0]);
  if (!marks.length) return null;
  return (
    <div className="ed-marks" aria-hidden="true" ref={layer}>
      <div className="ed-marks-text" ref={inner}>
        {markRuns(text, marks).map((run, i) =>
          run.mark ? (
            <span key={i} className={`ed-mark ed-mark-${run.mark.kind}`}>
              {run.text}
            </span>
          ) : (
            run.text
          ),
        )}
        {/* A final newline needs a line after it, as the text box gives it one. */}
        {text.endsWith('\n') ? '​' : null}
      </div>
    </div>
  );
}
