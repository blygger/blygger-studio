/**
 * How much a text changed between two versions, for the rules that treat a
 * version as maintenance (spec §13.2: decision #77's same hash, #83's
 * reader-local near-sameness). Used by the pace-layered order (RFC-3 R2,
 * decision #97) and, later, the reader's Background (blygger-spec
 * docs/background-plan.md).
 *
 * The measure is the **edit span**: the stretch between the longest common
 * prefix and the longest common suffix, counted in the longer text. It is an
 * upper bound on the characters changed, never an underestimate, so a rule
 * built on it errs towards "this changed" — the safe side, since one word can
 * negate a sentence. Linear in the text's length.
 */

/** Reader-local constants (#83): never on the wire, never advertised. Kept small. */
export const NEAR_SAME_MAX_CHARS = 40;
export const NEAR_SAME_MAX_FRACTION = 0.02;

export function editSpan(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++;
  return Math.max(a.length, b.length) - prefix - suffix;
}

/** Changed at most NEAR_SAME_MAX_CHARS characters and at most NEAR_SAME_MAX_FRACTION of the text. */
export function isNearSame(a: string, b: string): boolean {
  const span = editSpan(a, b);
  return span <= NEAR_SAME_MAX_CHARS && span <= NEAR_SAME_MAX_FRACTION * Math.max(a.length, b.length, 1);
}
