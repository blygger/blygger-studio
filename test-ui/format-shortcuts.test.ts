import { describe, expect, it } from 'vitest';
import { formatEdit, formatKey, type FormatKind } from '../src/ui/format-shortcuts.ts';

/** `«` and `»` mark the selection; `|` a caret. */
function run(marked: string, kind: FormatKind): string {
  const caret = marked.indexOf('|');
  const from = caret >= 0 ? caret : marked.indexOf('«');
  const to = caret >= 0 ? caret : marked.indexOf('»') - 1;
  const text = marked.replace(/[|«»]/g, '');
  const edit = formatEdit(text, from, to, kind);
  const out = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return edit.start === edit.end
    ? `${out.slice(0, edit.start)}|${out.slice(edit.start)}`
    : `${out.slice(0, edit.start)}«${out.slice(edit.start, edit.end)}»${out.slice(edit.end)}`;
}

describe('bold and italic', () => {
  it.each([
    ['a «word» b', 'bold', 'a **«word»** b'],
    ['a «word» b', 'italic', 'a *«word»* b'],
    ['a **«word»** b', 'bold', 'a «word» b'],
    ['a *«word»* b', 'italic', 'a «word» b'],
    ['a «**word**» b', 'bold', 'a «word» b'],
    ['a «*word*» b', 'italic', 'a «word» b'],
    ['a **«word»** b', 'italic', 'a ***«word»*** b'],
    ['a *«word»* b', 'bold', 'a ***«word»*** b'],
    ['a ***«word»*** b', 'bold', 'a *«word»* b'],
    ['a ***«word»*** b', 'italic', 'a **«word»** b'],
    ['a| b', 'bold', 'a**|** b'],
    ['a| b', 'italic', 'a*|* b'],
    ['a**|** b', 'bold', 'a| b'],
    ['a*|* b', 'italic', 'a| b'],
    ['«word »b', 'bold', '**«word»** b'],
  ] as const)('%s, %s', (input, kind, want) => {
    expect(run(input, kind)).toBe(want);
  });

  it('wraps each line of a selection, and takes them off again', () => {
    expect(run('«one\n\ntwo»', 'bold')).toBe('«**one**\n\n**two**»');
    expect(run('«**one**\n\n**two**»', 'bold')).toBe('«one\n\ntwo»');
    expect(run('«one\n*two*»', 'italic')).toBe('«*one*\n**two**»');
  });
});

describe('link', () => {
  it('waits for the URL with words selected, the words with a URL selected, and the words with neither', () => {
    expect(run('a «word» b', 'link')).toBe('a [word](|) b');
    expect(run('«https://x.example/a»', 'link')).toBe('[|](https://x.example/a)');
    expect(run('a | b', 'link')).toBe('a [|]() b');
  });
});

describe('formatKey', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  it('is Cmd on a Mac, where Ctrl keeps the system text-field motions', () => {
    expect(formatKey(key('b', { metaKey: true }), true)).toBe('bold');
    expect(formatKey(key('k', { ctrlKey: true }), true)).toBeNull();
  });
  it('is Ctrl elsewhere', () => {
    expect(formatKey(key('i', { ctrlKey: true }), false)).toBe('italic');
    expect(formatKey(key('i', { metaKey: true }), false)).toBeNull();
  });
  it('leaves other keys and modified chords alone', () => {
    expect(formatKey(key('b'), false)).toBeNull();
    expect(formatKey(key('x', { ctrlKey: true }), false)).toBeNull();
    expect(formatKey(key('b', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(formatKey(key('B', { ctrlKey: true }), false)).toBe('bold');
  });
});
