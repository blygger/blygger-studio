import { flushSync } from 'react-dom';

/**
 * Write `text` into a controlled textarea and put the caret (or a selection)
 * at [start, end), all before returning.
 *
 * React resets the caret to the end whenever it writes a new value, so the
 * caret can only be placed after React has committed. This used to wait for
 * the next animation frame, which left a frame in which the caret was wrong
 * and then moved under the writer: anything that selected or typed in the box
 * before that frame — a tap elsewhere in the text on a janky phone, or
 * Playwright's `fill()` selecting the old text before inserting the new — had
 * its selection collapsed to the end, so the new text was appended to the old
 * instead of replacing it (CI: "[TK]Summarise this[/TK]Linking [[").
 * `flushSync` commits the value now, so the caret is placed in the same task
 * and nothing is left pending.
 */
export function setTextAt(
  el: HTMLTextAreaElement,
  change: (text: string) => void,
  text: string,
  start: number,
  end = start,
) {
  flushSync(() => change(text));
  el.focus();
  el.setSelectionRange(start, end);
  // The bracket picker follows the caret through this event.
  el.dispatchEvent(new Event('selectionchange'));
}

/** The last text measured above a caret's paragraph, which typing in it leaves unchanged. */
let above: { el: HTMLTextAreaElement; text: string; width: number; height: number } | undefined;
/**
 * Scroll a textarea so the caret's line sits mid-way down the part of it that can
 * be seen, which an on-screen keyboard may shorten. A textarea can't report where
 * its caret is, so this lays the text out in a hidden copy, wrapped the same way,
 * and measures that. The copy carries the rest of the word at the caret, or a word
 * about to wrap would be measured on the line it is leaving. Only the caret's own
 * paragraph is measured per keystroke, or a long chapter would lag the typing.
 */
export function revealCaret(el: HTMLTextAreaElement) {
  const style = getComputedStyle(el);
  const width = el.clientWidth;
  /** Where `rest` would end up after `text`, from the top of `text`. */
  const measure = (text: string, rest: string) => {
    const copy = document.createElement('div');
    Object.assign(copy.style, {
      position: 'absolute', visibility: 'hidden', top: '0', left: '0', boxSizing: 'border-box',
      whiteSpace: 'pre-wrap', overflowWrap: 'break-word', width: `${width}px`,
      paddingLeft: style.paddingLeft, paddingRight: style.paddingRight,
      fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle,
      lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, tabSize: style.tabSize,
    });
    copy.textContent = text;
    const mark = document.createElement('span');
    mark.textContent = rest || '\u200b';
    copy.append(mark);
    document.body.append(copy);
    const y = mark.offsetTop;
    copy.remove();
    return y;
  };
  const caret = el.selectionEnd;
  const start = caret ? el.value.lastIndexOf('\n', caret - 1) + 1 : 0;
  const text = el.value.slice(0, start);
  if (above?.el !== el || above.width !== width || above.text !== text)
    above = { el, text, width, height: measure(text, '') };
  const word = /^\S*/.exec(el.value.slice(caret, caret + 200))![0];
  const caretY = parseFloat(style.paddingTop) + above.height + measure(el.value.slice(start, caret), word) + parseFloat(style.lineHeight) / 2;
  const box = el.getBoundingClientRect();
  const view = window.visualViewport;
  const top = Math.max(box.top, view?.offsetTop ?? box.top);
  // On a phone the picker docks over the bottom of the window.
  const dock = document.querySelector('.picker')?.getBoundingClientRect();
  const docked = dock && dock.left <= box.left ? dock.top : Infinity;
  const bottom = Math.min(box.top + el.clientHeight, view ? view.offsetTop + view.height : Infinity, docked);
  const middle = bottom > top ? (top + bottom) / 2 - box.top : el.clientHeight / 2;
  el.scrollTop = caretY - middle;
}
