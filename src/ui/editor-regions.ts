/*
 * Held-out regions: parts of the full editor's text an extension keeps out of
 * the text box (docs/extensions.md, `editorRegions`). Pure, so the UI suite
 * tests it without a browser.
 *
 * The draft is always the full text. The text box shows it with the regions
 * cut out; each region is remembered by where it was cut (its anchor, an offset
 * in the shown text). A text box change is one contiguous replacement, so the
 * anchors move with it, and joining puts every region back before the draft
 * sees the edit. Text typed at an anchor lands before the region, so a region
 * should start with its own separator (a leading blank line).
 */

export interface EditorRegion {
  /** Offsets in the full text, end exclusive. */
  start: number;
  end: number;
  /** What the region is, for the editor's notice: "chapter navigation". */
  label: string;
}

export interface Held {
  /** Where the region sits in the shown text. */
  at: number;
  text: string;
  label: string;
}

/** Sorted, clamped to the text, empty ones dropped, overlapping and touching ones merged. */
export function normalize(regions: readonly EditorRegion[], length: number): EditorRegion[] {
  const sorted = regions
    .map((region) => ({ ...region, start: Math.max(0, Math.min(region.start, length)), end: Math.max(0, Math.min(region.end, length)) }))
    .filter((region) => region.end > region.start)
    .sort((a, b) => a.start - b.start);
  const merged: EditorRegion[] = [];
  for (const region of sorted) {
    const last = merged.at(-1);
    if (last && region.start <= last.end) {
      last.end = Math.max(last.end, region.end);
      if (!last.label.split(', ').includes(region.label)) last.label = `${last.label}, ${region.label}`;
    } else merged.push({ ...region });
  }
  return merged;
}

/** The text box's text, and the regions cut from it. */
export function split(text: string, regions: readonly EditorRegion[]): { shown: string; held: Held[] } {
  let shown = '';
  let from = 0;
  const held: Held[] = [];
  for (const region of normalize(regions, text.length)) {
    shown += text.slice(from, region.start);
    held.push({ at: shown.length, text: text.slice(region.start, region.end), label: region.label });
    from = region.end;
  }
  return { shown: shown + text.slice(from), held };
}

/** The full text: every held region put back at its anchor. */
export function join(shown: string, held: readonly Held[]): string {
  let text = '';
  let from = 0;
  for (const region of held) {
    const at = Math.max(from, Math.min(region.at, shown.length));
    text += shown.slice(from, at) + region.text;
    from = at;
  }
  return text + shown.slice(from);
}

/**
 * The one replacement that turns `before` into `after`: [start, end) of `before` became
 * `inserted` characters. Where that is ambiguous (replacing "paragraph." with "new." could
 * keep the "."), `caret`, the text box's caret after the edit, says where the new text ends.
 */
export function change(before: string, after: string, caret?: number): { start: number; end: number; inserted: number } {
  const known = caret !== undefined && caret >= 0 && caret <= after.length;
  let start = 0;
  const max = Math.min(before.length, after.length);
  const head = known ? Math.min(max, caret) : max;
  while (start < head && before[start] === after[start]) start++;
  let tail = 0;
  const tailMax = Math.min(max - start, known ? after.length - caret : Infinity);
  while (tail < tailMax && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { start, end: before.length - tail, inserted: after.length - tail - start };
}

/**
 * Anchors after the text box went from `before` to `after`. One before the
 * change stays; one at or after it moves with the text, so text typed at an
 * anchor lands before the region; one inside replaced text goes after the
 * replacement.
 */
export function rebase(held: readonly Held[], before: string, after: string, caret?: number): Held[] {
  const { start, end, inserted } = change(before, after, caret);
  return held.map((region) => ({
    ...region,
    at: region.at < start ? region.at : region.at >= end ? region.at + inserted - (end - start) : start + inserted,
  }));
}

/** Whether turning the full text `before` into `after` touches a region's text. Typing right at its edge does not. */
export function touches(regions: readonly EditorRegion[], before: string, after: string, caret?: number): EditorRegion | undefined {
  const { start, end } = change(before, after, caret);
  return normalize(regions, before.length).find((region) =>
    end > start ? start < region.end && end > region.start : start > region.start && start < region.end,
  );
}

/** A caret in the shown text, as an offset in the full text (it lands before a region at its anchor). */
export function toFull(offset: number, held: readonly Held[]): number {
  return offset + held.filter((region) => region.at < offset).reduce((sum, region) => sum + region.text.length, 0);
}

/** A caret in the full text, as an offset in the shown text (one inside a region goes to its anchor). */
export function toShown(offset: number, text: string, regions: readonly EditorRegion[]): number {
  let shift = 0;
  for (const region of normalize(regions, text.length)) {
    if (offset <= region.start) break;
    if (offset < region.end) return region.start - shift;
    shift += region.end - region.start;
  }
  return offset - shift;
}
