// Editor marks (src/ui/editor-marks.tsx, docs/extensions.md "Editor marks"). What these pin:
//   1. Marks move with an edit: before it they stay, after it they shift, one it touched is dropped.
//   2. The layer's runs cover the text exactly, marks clamped and sorted, an overlap keeping the first.
//   3. The spellcheck control is replaced only while its owner is in a row on screen.
import { expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { markRuns, rebaseMarks, MarksLayer } from '../src/ui/editor-marks.tsx';
import { barPlacement, barReplaces } from '../src/ui/extensions.tsx';
import type { EditorMark, StudioExtension } from '../src/ui/extension-api.ts';

const m = (start: number, end: number): EditorMark => ({ start, end, kind: 'spelling' });

test('marks move with an edit and drop where it touched them', () => {
  const before = 'teh cat and teh dog';
  const marks = [m(0, 3), m(12, 15)];
  // Typing before both shifts both.
  expect(rebaseMarks(marks, before, `A ${before}`)).toEqual([m(2, 5), m(14, 17)]);
  // Typing between them shifts only the second.
  expect(rebaseMarks(marks, before, 'teh cat, and teh dog')).toEqual([m(0, 3), m(13, 16)]);
  // Fixing the first drops it and shifts the second.
  expect(rebaseMarks(marks, before, 'the cat and teh dog')).toEqual([m(12, 15)]);
  // A letter typed onto a mark joins the word: dropped until the bar marks again. A space or comma doesn't.
  expect(rebaseMarks(marks, before, 'xteh cat and teh dog')).toEqual([m(13, 16)]);
  expect(rebaseMarks(marks, before, 'tehs cat and teh dog')).toEqual([m(13, 16)]);
  expect(rebaseMarks(marks, before, 'teh, cat and teh dog')).toEqual([m(0, 3), m(13, 16)]);
  expect(rebaseMarks(marks, before, before)).toEqual(marks);
});

test('the runs cover the text, marks clamped and sorted, an overlap keeping the first', () => {
  const text = 'abc def ghi';
  const runs = markRuns(text, [m(8, 11), m(0, 3), m(2, 6), m(9, 99)]);
  expect(runs.map((r) => r.text).join('')).toBe(text);
  expect(runs.map((r) => [r.text, !!r.mark])).toEqual([['abc', true], [' def ', false], ['ghi', true]]);
  expect(markRuns('', [m(0, 3)])).toEqual([]);
});

test('the layer renders nothing without marks, and transparent text with its marks', () => {
  const input = { current: null };
  expect(renderToStaticMarkup(createElement(MarksLayer, { input, text: 'x', marks: [] }))).toBe('');
  const html = renderToStaticMarkup(createElement(MarksLayer, { input, text: 'a teh b\n', marks: [m(2, 5)] }));
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('<span class="ed-mark ed-mark-spelling">teh</span>');
  expect(html).toContain('​');
});

test('the browser spellcheck is replaced only while its owner is in a row on screen', () => {
  const bar = (name: string, replaces?: ('spellcheck' | 'regionToggle')[], blocks = 1): StudioExtension => ({
    name, label: name, description: name, editorBar: { label: name, blocks, ...(replaces ? { replaces } : {}), component: () => null },
  });
  const checker = bar('checker', ['spellcheck']);
  expect(barReplaces(barPlacement([checker]), 'spellcheck', [])).toBe(true);
  expect(barReplaces(barPlacement([checker]), 'regionToggle', [])).toBe(false);
  // Hidden, crashed or crowded into the menu: the browser's own is back.
  expect(barReplaces(barPlacement([checker], ['checker']), 'spellcheck', [])).toBe(false);
  expect(barReplaces(barPlacement([checker]), 'spellcheck', ['checker'])).toBe(false);
  expect(barReplaces(barPlacement([bar('a', undefined, 4), bar('b', undefined, 4), checker]), 'spellcheck', [])).toBe(false);
  // A second claim loses to the first, wherever the first is.
  expect(barPlacement([checker, bar('other', ['spellcheck'])]).ownerOf('spellcheck')?.name).toBe('checker');
});
