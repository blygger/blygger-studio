// Held-out regions (src/ui/editor-regions.ts): the offset logic behind the editorRegions slot.
import { expect, test } from 'vitest';
import { change, join, normalize, rebase, split, toFull, toShown, touches } from '../src/ui/editor-regions.ts';
import type { EditorRegion } from '../src/ui/editor-regions.ts';

// A chapter as blykker writes it: nav after the title and at the end, each region starting with its separator.
const top = '\n\n[[a | ← Preface]] · [[b | Contents]]\n\n[blykker-nav-top]: #';
const bottom = '\n\n[blykker-nav-bottom]: #\n\n[[a | ← Preface]] · [[b | Contents]]';
const chapter = `# Chapter 1${top}\n\nFirst paragraph.\n\nLast paragraph.${bottom}`;
const navRegions = (text: string): EditorRegion[] => {
  const regions: EditorRegion[] = [];
  const t = text.indexOf('\n\n[blykker-nav-top]: #');
  if (t >= 0) {
    const start = text.lastIndexOf('\n\n', t - 1);
    regions.push({ start, end: t + '\n\n[blykker-nav-top]: #'.length, label: 'chapter navigation' });
  }
  const b = text.indexOf('\n\n[blykker-nav-bottom]: #');
  if (b >= 0) regions.push({ start: b, end: text.length, label: 'chapter navigation' });
  return regions;
};
/** One edit in the text box, as the editor makes it: rebase the anchors, join, and check it round-trips. */
const typeInBox = (full: string, edit: (shown: string) => string, caret?: number) => {
  const before = split(full, navRegions(full));
  const shown = edit(before.shown);
  const joined = join(shown, rebase(before.held, before.shown, shown, caret));
  return { joined, roundTrips: split(joined, navRegions(joined)).shown === shown };
};

test('split and join: the box shows the text without the regions, and joining gives the text back', () => {
  const parts = split(chapter, navRegions(chapter));
  expect(parts.shown).toBe('# Chapter 1\n\nFirst paragraph.\n\nLast paragraph.');
  expect(parts.held.map((region) => region.at)).toEqual([11, parts.shown.length]);
  expect(join(parts.shown, parts.held)).toBe(chapter);
  expect(split('no regions', [])).toEqual({ shown: 'no regions', held: [] });
});

test('typing in the box: before, at and after an anchor', () => {
  // In a paragraph: both regions stay where they were.
  const middle = typeInBox(chapter, (shown) => shown.replace('First', 'The first'));
  expect(middle.joined).toBe(chapter.replace('First', 'The first'));
  expect(middle.roundTrips).toBe(true);
  // At the end of the title (the top anchor): the text joins the title, before the nav.
  const title = typeInBox(chapter, (shown) => shown.replace('# Chapter 1', '# Chapter 1: Introduction'));
  expect(title.joined).toBe(chapter.replace('# Chapter 1', '# Chapter 1: Introduction'));
  // At the very end of the box (the bottom anchor): the text joins the last paragraph, before the nav.
  const end = typeInBox(chapter, (shown) => `${shown} More.`);
  expect(end.joined).toBe(chapter.replace('Last paragraph.', 'Last paragraph. More.'));
  expect(end.roundTrips).toBe(true);
  // A new paragraph at the end goes before the bottom nav too.
  expect(typeInBox(chapter, (shown) => `${shown}\n\nNew paragraph.`).joined.endsWith(`New paragraph.${bottom}`)).toBe(true);
});

test('typing in the box: replacing text around an anchor puts the region after the replacement', () => {
  // Select all and type: the caret says the new text ends at its end, so the old "." is not kept.
  const all = typeInBox(chapter, () => 'Everything new.', 'Everything new.'.length);
  expect(all.joined).toBe(`Everything new.${top}${bottom}`);
  // Without the caret the diff keeps the shared "." and it lands after the marker: why typed edits pass it.
  expect(typeInBox(chapter, () => 'Everything new.').joined).toContain('[blykker-nav-top]: #.');
});

test('change: the one replacement between two strings', () => {
  expect(change('abc', 'abc')).toEqual({ start: 3, end: 3, inserted: 0 });
  expect(change('abc', 'abXc')).toEqual({ start: 2, end: 2, inserted: 1 });
  expect(change('abc', 'ac')).toEqual({ start: 1, end: 2, inserted: 0 });
  expect(change('abc', 'xyz')).toEqual({ start: 0, end: 3, inserted: 3 });
  // Ambiguous: "a." to "b." could keep the "."; the caret after the edit says it didn't.
  expect(change('a.', 'b.')).toEqual({ start: 0, end: 1, inserted: 1 });
  expect(change('a.', 'b.', 2)).toEqual({ start: 0, end: 2, inserted: 2 });
});

test('touches: shown regions are read-only, but typing right at their edge is fine', () => {
  const regions = navRegions(chapter);
  const inNav = chapter.replace('Contents]]\n\n[blykker-nav-top]', 'Contents]] x\n\n[blykker-nav-top]');
  expect(touches(regions, chapter, inNav)?.label).toBe('chapter navigation');
  expect(touches(regions, chapter, chapter.replace('First', 'The first'))).toBeUndefined();
  // Right at the end of the top region (start of the content separator), and right at the start of the bottom one.
  const afterTop = chapter.replace('[blykker-nav-top]: #', '[blykker-nav-top]: #!');
  expect(touches(regions, chapter, afterTop)).toBeUndefined();
  expect(touches(regions, chapter, chapter.replace('Last paragraph.', 'Last paragraph!'))).toBeUndefined();
  // Deleting across a region's edge touches it.
  expect(touches(regions, chapter, chapter.replace('paragraph.\n\n[blykker-nav-bottom]', 'paragraph[blykker-nav-bottom]'))?.label).toBe('chapter navigation');
});

test('carets: shown to full and back, as the show/hide toggle maps them', () => {
  const regions = navRegions(chapter);
  const parts = split(chapter, regions);
  const first = parts.shown.indexOf('First');
  expect(chapter.slice(toFull(first, parts.held))).toMatch(/^First/);
  expect(toShown(toFull(first, parts.held), chapter, regions)).toBe(first);
  // A caret at an anchor stays before the region; one inside a region goes to its anchor.
  expect(toFull(11, parts.held)).toBe(11);
  expect(toShown(chapter.indexOf('Contents'), chapter, regions)).toBe(11);
});

test('normalize: clamped, sorted, empty dropped, overlapping merged with both labels', () => {
  expect(normalize([{ start: 5, end: 2, label: 'x' }, { start: 8, end: 99, label: 'b' }, { start: 0, end: 3, label: 'a' }, { start: 2, end: 4, label: 'c' }], 10)).toEqual([
    { start: 0, end: 4, label: 'a, c' },
    { start: 8, end: 10, label: 'b' },
  ]);
});
