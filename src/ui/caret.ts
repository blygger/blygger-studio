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

/**
 * Scroll a textarea so the caret sits mid-window. A textarea can't report where
 * its caret is, so this lays the text before it out in a hidden copy, wrapped
 * the same way, and measures that. Used when the box changes shape under the
 * writer, since rewrapping leaves the caret off-screen.
 */
export function revealCaret(el: HTMLTextAreaElement) {
  const style = getComputedStyle(el);
  const copy = document.createElement('div');
  copy.style.cssText = `position:absolute;visibility:hidden;top:0;left:0;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:break-word;width:${el.clientWidth}px;padding:0 ${style.paddingRight} 0 ${style.paddingLeft};font:${style.font};letter-spacing:${style.letterSpacing};tab-size:${style.tabSize}`;
  copy.textContent = el.value.slice(0, el.selectionEnd) + '\u200b';
  document.body.append(copy);
  const caretY = parseFloat(style.paddingTop) + copy.offsetHeight;
  copy.remove();
  el.scrollTop = caretY - el.clientHeight / 2;
}
