import { describe, expect, test } from 'vitest';
import { closedPlaceholder, locateSite, mintableLabel, placeholderAfterTyping, rewriteSite, stillMintable } from '../src/ui/placeholder-link.ts';

const ID = '7c9wk2n4h6q1x8v0z3m5rjy2ke';
const NEW = 'abcdefghjkmnpqrstvwxyz0123';

/** Type `]` at the caret of `before` (caret marked by `|`), as the textarea would. */
function typeClose(marked: string) {
  const caret = marked.indexOf('|');
  const before = marked.slice(0, caret) + marked.slice(caret + 1);
  const next = before.slice(0, caret) + ']' + before.slice(caret);
  return placeholderAfterTyping(before, next, caret + 1);
}

describe('which [[…]] mints a placeholder', () => {
  test('typing the closing ]] of plain text does', () => {
    expect(typeClose('I will argue [[the maintenance argument]| later.')).toEqual({
      start: 13, end: 41, original: '[[the maintenance argument]]', label: 'the maintenance argument',
    });
  });

  test.each([
    ['an id', `see [[${ID}]|`],
    ['an id with a label', `see [[${ID} | words]|`],
    ['something that looks like an attempt at an id', `see [[${ID.slice(0, 24)}]|`],
    ['a quote directive', `![[some text]|`],
    ['an inline TK source', `[TK]summarise ![[some text]|`],
    ['a code span', 'in `[[some text]|` code'],
    ['a code span still being typed', 'in `[[some text]|'],
    ['a fenced block', '```\n[[some text]|\n```'],
    ['a TK instruction', '[TK]write about [[some text]|'],
    ['TK output', '[TK]x[=]generated [[some text]|[/TK]'],
    ['empty brackets', 'see [[  ]|'],
    ['nested brackets', 'see [[a [b]|'],
  ])('%s does not', (_name, marked) => {
    expect(typeClose(marked)).toBeNull();
  });

  test('a closed code span earlier in the paragraph does not shield what follows it', () => {
    expect(typeClose('`code` then [[some text]|')?.label).toBe('some text');
    expect(typeClose('an open ` tick\n\nnew paragraph [[some text]|')?.label).toBe('some text');
  });

  test('a scope that has closed does not shield what follows it', () => {
    expect(typeClose('[TK]x[=]y[/TK] then [[some text]|')?.label).toBe('some text');
  });

  test('only a typed ] counts: a paste or a loaded draft mints nothing', () => {
    expect(placeholderAfterTyping('', 'see [[pasted]]', 14)).toBeNull();
    expect(placeholderAfterTyping('see [[pasted]', 'see [[pasted]]x', 15)).toBeNull();
    expect(closedPlaceholder('see [[loaded]]', 14)?.label).toBe('loaded');
  });

  test('the label is made safe and one line', () => {
    expect(mintableLabel('  two   words ')).toBe('two words');
    expect(mintableLabel('line\nbreak')).toBeNull();
    expect(mintableLabel(ID)).toBeNull();
    expect(mintableLabel('a | b')).toBe('a | b');
  });
});

describe('the rewrite', () => {
  test('writes [[id | text]] in place and carries the caret past it', () => {
    const text = 'I will argue [[the argument]] later.';
    const site = closedPlaceholder(text, 29)!;
    const out = rewriteSite(text, locateSite(text, site)!, site, NEW, 29);
    expect(out.text).toBe(`I will argue [[${NEW} | the argument]] later.`);
    expect(out.caret).toBe(`I will argue [[${NEW} | the argument]]`.length);
  });

  test('finds the brackets again if text was typed before them meanwhile, and gives up if they are gone', () => {
    const site = closedPlaceholder('x [[idea]]', 10)!;
    expect(locateSite('more x [[idea]]', site)).toBe(7);
    expect(locateSite('x [[ide]]', site)).toBeNull();
    expect(locateSite('[[idea]] and [[idea]] twice', site)).toBeNull();
  });

  test('a caret before the site stays put; one after it moves with the text', () => {
    const text = 'a [[idea]] b';
    const site = closedPlaceholder(text, 10)!;
    expect(rewriteSite(text, 2, site, NEW, 0).caret).toBe(0);
    expect(rewriteSite(text, 2, site, NEW, 12).caret).toBe(12 + NEW.length + 3);
  });

  test('checked again when the item comes back: a code span or a ! that arrived meanwhile cancels it', () => {
    expect(stillMintable('see [[idea]] now', 4)).toBe(true);
    expect(stillMintable('see `[[idea]]` now', 5)).toBe(false);
    expect(stillMintable('see ![[idea]]', 5)).toBe(false);
  });

  test('an unclosed query from the picker becomes a closed link', () => {
    const text = 'see [[half typed';
    const site = { start: 4, end: text.length, original: text.slice(4), label: 'half typed' };
    expect(rewriteSite(text, 4, site, NEW, text.length).text).toBe(`see [[${NEW} | half typed]]`);
  });
});
