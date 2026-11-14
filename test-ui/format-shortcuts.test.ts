import { describe, expect, it } from 'vitest';
import { breakEdit, codeBlockEdit, formatEdit, formatKey, formulaEdit, indentEdit, structureKey, type FormatEdit, type FormatKind } from '../src/ui/format-shortcuts.ts';

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

/** As `run`, for any edit; `∅` when the edit declines. */
function apply(marked: string, make: (text: string, from: number, to: number) => FormatEdit | null): string {
  const caret = marked.indexOf('|');
  const from = caret >= 0 ? caret : marked.indexOf('«');
  const to = caret >= 0 ? caret : marked.indexOf('»') - 1;
  const text = marked.replace(/[|«»]/g, '');
  const edit = make(text, from, to);
  if (!edit) return '∅';
  const out = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return edit.start === edit.end
    ? `${out.slice(0, edit.start)}|${out.slice(edit.start)}`
    : `${out.slice(0, edit.start)}«${out.slice(edit.start, edit.end)}»${out.slice(edit.end)}`;
}
const indent = (marked: string) => apply(marked, (text, from, to) => indentEdit(text, from, to, false));
const outdent = (marked: string) => apply(marked, (text, from, to) => indentEdit(text, from, to, true));

describe('Tab and Shift+Tab on list lines', () => {
  it.each([
    ['- a\n- b|', '- a\n    - b|'],
    ['- a\n|- b', '- a\n    |- b'],
    // A numbered sublist starts again at 1, or markdown does not see a list.
    ['1. a\n2. b|\n3. c', '1. a\n    1. b|\n3. c'],
    ['1. a\n    1. b\n2. c|', '1. a\n    1. b\n    2. c|'],
    ['9. a\n10. b|', '9. a\n    1. b|'],
    ['* a\n    + b| c', '* a\n        + b| c'],
    ['- a\n10) b|', '- a\n    1) b|'],
    ['- a\n-|', '- a\n    -|'],
  ])('%j moves in to %j', (before, after) => expect(indent(before)).toBe(after));

  it.each([
    ['- a\n    - b|', '- a\n- b|'],
    ['- a\n  - b|', '- a\n- b|'],
    ['- a\n\t- b|', '- a\n- b|'],
    ['- a\n        - b|', '- a\n    - b|'],
    // A caret inside the indent that goes lands at the line's start, not on the line above.
    ['- a\n  |  - b', '- a\n|- b'],
  ])('%j moves out to %j', (before, after) => expect(outdent(before)).toBe(after));

  it('moves every selected item and keeps them selected; blank lines between stay blank', () => {
    expect(indent('- a\n«- b\n\n- c»\n- d')).toBe('- a\n«    - b\n\n    - c»\n- d');
    expect(outdent('- a\n«    - b\n    - c»')).toBe('- a\n«- b\n- c»');
    // A selection that ends at the start of the next line does not take that line.
    expect(indent('- x\n«- a\n»- b')).toBe('- x\n«    - a»\n- b');
  });

  it('declines off a list, so Tab moves focus as usual', () => {
    expect(indent('plain| text')).toBe('∅');
    expect(indent('|')).toBe('∅');
    expect(indent('-not a list|')).toBe('∅');
    expect(indent('«- a\nprose»')).toBe('∅');
    expect(outdent('- already at the margin|')).toBe('∅');
    expect(indent('**bold** start|')).toBe('∅');
    // The first item of a list has nothing to go under: indented, it would be a code block.
    expect(indent('- first|\n- second')).toBe('∅');
    expect(indent('prose\n\n- first|')).toBe('∅');
  });

  it('what Tab writes is a sublist to the renderer, under bullets and numbers', async () => {
    const { default: MarkdownIt } = await import('markdown-it');
    const md = new MarkdownIt();
    for (const source of ['- a\n- b|', '1. a\n2. b|', '10. a\n11. b|', '- a\n2. b|', '- a\n    - b\n    - c|']) {
      const html = md.render(indent(source).replace('|', ''));
      expect(html.replace(/\s+/g, '')).toMatch(/<li>a<[uo]l><li>b/);
      expect(html).not.toContain('<pre>');
    }
  });
});

describe('Shift+Enter', () => {
  const brk = (marked: string) => apply(marked, breakEdit);
  it.each([
    ['Tyger Tyger, burning bright,|', 'Tyger Tyger, burning bright,\\\n|'],
    ['one| two', 'one\\\n| two'],
    ['a «one» two', 'a \\\n| two'],
    // Nothing to break after, or already broken: an ordinary newline.
    ['|', '\n|'],
    ['a\n\n|', 'a\n\n\n|'],
    ['a\\|', 'a\\\n|'],
    // Inside a code block a backslash would be a backslash.
    ['```\nline|\n```', '```\nline\n|\n```'],
    ['```\ncode\n```\nafter|', '```\ncode\n```\nafter\\\n|'],
    ['~~~~\n```\nstill code|', '~~~~\n```\nstill code\n|'],
  ])('%j becomes %j', (before, after) => expect(brk(before)).toBe(after));

  it('renders as a line break inside one paragraph', async () => {
    const { default: MarkdownIt } = await import('markdown-it');
    const text = brk(brk('one|').replace('|', 'two|')).replace('|', 'three');
    expect(new MarkdownIt().render(text)).toBe('<p>one<br>\ntwo<br>\nthree</p>\n');
  });
});

describe('the code block button', () => {
  const code = (marked: string) => apply(marked, codeBlockEdit);
  it.each([
    ['|', '```\n|\n```'],
    ['text|', 'text\n\n```\n|\n```'],
    ['text\n|', 'text\n\n```\n|\n```'],
    ['text\n\n|\n\nmore', 'text\n\n```\n|\n```\n\nmore'],
    ['«let a = 1;\nlet b = 2;»', '```\n«let a = 1;\nlet b = 2;»\n```'],
    ['before\n«code\n»after', 'before\n\n```\n«code»\n```\n\nafter'],
  ])('%j becomes %j', (before, after) => expect(code(before)).toBe(after));
});

describe('which keys are structure', () => {
  const key = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
    structureKey({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  it('Tab, Shift+Tab and Shift+Enter, and nothing with a command key', () => {
    expect(key('Tab')).toBe('indent');
    expect(key('Tab', { shiftKey: true })).toBe('outdent');
    expect(key('Enter', { shiftKey: true })).toBe('break');
    expect(key('Enter')).toBeNull();
    // Cmd/Ctrl+Shift+Enter is the focus view's; Ctrl+Tab is the browser's.
    expect(key('Enter', { shiftKey: true, metaKey: true })).toBeNull();
    expect(key('Enter', { shiftKey: true, ctrlKey: true })).toBeNull();
    expect(key('Tab', { ctrlKey: true })).toBeNull();
    expect(key('Tab', { altKey: true })).toBeNull();
  });
});

describe('the formula button', () => {
  const formula = (marked: string) => apply(marked, formulaEdit);
  it.each([
    ['|', '$|$'],
    ['area «pi r^2» here', 'area $«pi r^2»$ here'],
    ['«\\int f\ndx»', '$$«\\int f\ndx»$$'],
    ['a « x » b', 'a $«x»$ b'],
  ])('%j becomes %j', (before, after) => expect(formula(before)).toBe(after));
});
