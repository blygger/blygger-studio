// The dictionary check: which words in a draft aren't in the word list, where they are, and what
// they might have been. Pure, apart from unpacking the list (test/spellcheck.test.ts).
//
// Only prose is checked. Skipped: code, math, URLs and e-mail addresses, link targets, `[[id]]`
// and the id part of `[[id | label]]` (the label is checked), `![[…]]`, `[label]: #` lines,
// HTML tags, @handles, a TK scope's instruction (its output is checked), and words that are all
// capitals, hold a capital after the first letter, or are one letter long.

export interface Speller {
  has(word: string): boolean;
  /** Count a word as known from now on (the author's own dictionary). */
  add(word: string): void;
  suggest(word: string, limit?: number): string[];
}

export interface Misspelling {
  word: string;
  start: number;
  end: number;
}

/** Unpacks the list the server sends: one word per line, gzipped, base64. */
export async function unpack(gz: string): Promise<string[]> {
  const bytes = Uint8Array.from(atob(gz), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return (await new Response(stream).text()).split('\n');
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz'";

export function speller(words: Iterable<string>, extra: Iterable<string> = []): Speller {
  const set = new Set<string>(words);
  for (const word of extra) set.add(word);
  // Each word in lower case, mapped to how the list spells it (the lower-case form when it has one).
  const lower = new Map<string, string>();
  for (const word of set) {
    const key = word.toLowerCase();
    if (!lower.has(key) || word === key) lower.set(key, word);
  }
  // A capital the list doesn't have is a sentence start or a heading: the lower-case word counts.
  // A lower-case word the list only has capitalized (london) does not.
  const has = (word: string) => set.has(word) || (word[0] !== word[0].toLowerCase() && set.has(word.toLowerCase())) || (word === word.toUpperCase() && lower.has(word.toLowerCase()));
  const edits = (word: string) => {
    const out = new Set<string>();
    for (let i = 0; i <= word.length; i++) {
      const a = word.slice(0, i);
      const b = word.slice(i);
      if (b) out.add(a + b.slice(1));
      if (b.length > 1) out.add(a + b[1] + b[0] + b.slice(2));
      for (const c of ALPHABET) {
        if (b) out.add(a + c + b.slice(1));
        out.add(a + c + b);
      }
    }
    out.delete(word);
    return out;
  };
  const known = (candidates: Iterable<string>) => [...candidates].filter((w) => set.has(w) || lower.has(w));
  return {
    has,
    add(word) {
      set.add(word);
      const key = word.toLowerCase();
      if (!lower.has(key) || word === key) lower.set(key, word);
    },
    suggest(word, limit = 6) {
      const cap = word[0] !== word[0].toLowerCase();
      const base = word.toLowerCase();
      const one = edits(base);
      let found = known(one);
      if (found.length < limit && base.length > 3) {
        const two = new Set<string>();
        for (const w of one) for (const e of edits(w)) if (!one.has(e) && e !== base) two.add(e);
        found = [...found, ...known(two)];
      }
      // Swapped neighbours are the commonest typo (teh, recieve), so they lead.
      const swaps = new Set<string>();
      for (let i = 0; i + 1 < base.length; i++) swaps.add(base.slice(0, i) + base[i + 1] + base[i] + base.slice(i + 2));
      const score = (w: string) => (swaps.has(w) ? -1 : 0) + (w[0] === base[0] ? 0 : 2) + Math.abs(w.length - base.length) + (one.has(w) ? 0 : 3);
      const ranked = [...new Set(found)].sort((x, y) => score(x) - score(y) || x.localeCompare(y));
      // The list's own spelling of a name; a capital carried over from the word otherwise.
      const shown = ranked.map((w) => (set.has(w) ? w : lower.get(w) ?? w));
      return [...new Set(shown.map((w) => (cap && w[0] === w[0].toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w)))].slice(0, limit);
    },
  };
}

/** The text with everything that isn't prose blanked out, offsets kept. */
export function prose(text: string): string {
  const out = text.split('');
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    for (const m of text.matchAll(re)) fn(m as RegExpExecArray);
  };
  each(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|$(?![\s\S]))/gm, (m) => blank(m.index, m.index + m[0].length));
  each(/`[^`\n]+`/g, (m) => blank(m.index, m.index + m[0].length));
  each(/\$\$[\s\S]*?\$\$|\$[^\s$][^$\n]*?\$/g, (m) => blank(m.index, m.index + m[0].length));
  // A TK scope: the instruction and its tokens; the output (after [=], or impyrt's =) stays.
  each(/\[TK\]([\s\S]*?)\[\/TK\]/g, (m) => {
    const inner = m[1];
    const eq = inner.indexOf('[=]');
    const impyrt = /^impyrt(?:\s[^=\n]*)?=/.exec(inner);
    const keep = eq >= 0 ? eq + 3 : impyrt ? impyrt[0].length : inner.length;
    blank(m.index, m.index + 4 + keep);
    blank(m.index + m[0].length - 5, m.index + m[0].length);
  });
  each(/^\[[^\]\n]+\]:[ \t]*\S[^\n]*$/gm, (m) => blank(m.index, m.index + m[0].length));
  each(/!\[\[[^\]\n]*\]\]/g, (m) => blank(m.index, m.index + m[0].length));
  each(/\[\[([0-9a-z]{26})([ \t]*\|)?/g, (m) => blank(m.index, m.index + m[0].length));
  each(/\]\]/g, (m) => blank(m.index, m.index + 2));
  each(/\]\([^)\n]*\)/g, (m) => blank(m.index, m.index + m[0].length));
  each(/<[^>\n]+>/g, (m) => blank(m.index, m.index + m[0].length));
  each(/\b(?:https?:\/\/|www\.)[^\s)>\]]+|[\w.+-]+@[\w-]+\.[\w.-]+|(?:^|(?<=\s))@[\w.-]+/g, (m) => blank(m.index, m.index + m[0].length));
  return out.join('');
}

const WORD = /[\p{L}][\p{L}\p{M}'’]*/gu;
/** Before a hyphen, these are prefixes, not words: pre-industrial, non-linear, proto-urban. */
const PREFIXES = new Set(['anti', 'auto', 'bi', 'co', 'counter', 'de', 'extra', 'hyper', 'infra', 'inter', 'intra', 'macro', 'meta', 'micro', 'mid', 'mis', 'multi', 'neo', 'non', 'over', 'para', 'post', 'pre', 'pro', 'proto', 'pseudo', 're', 'semi', 'sub', 'super', 'trans', 'tri', 'ultra', 'un', 'under']);
/** Short Latin of citations and asides. */
const LATIN = new Set(['et', 'al', 'etc', 'ibid', 'cf', 'viz', 'circa', 'passim', 'sic']);

/** Each word of prose the speller doesn't know, in order. `ignore` holds words to leave alone. */
export function misspellings(text: string, check: Speller, ignore: ReadonlySet<string> = new Set()): Misspelling[] {
  const out: Misspelling[] = [];
  for (const m of prose(text).matchAll(WORD)) {
    let word = m[0].replace(/’/g, "'");
    let end = m.index + m[0].length;
    // A trailing apostrophe or possessive 's is the word's own.
    const trail = /'s?$/.exec(word);
    if (trail) {
      word = word.slice(0, trail.index);
      end -= m[0].length - word.length;
    }
    if (word.length < 2 || word === word.toUpperCase() || /[\p{Lu}]/u.test(word.slice(1))) continue;
    if (ignore.has(word) || ignore.has(word.toLowerCase()) || check.has(word) || LATIN.has(word.toLowerCase())) continue;
    // Part of a hyphenated compound: fine when it is a prefix, or the compound is a word.
    const compound = /[\p{L}'’-]*$/u.exec(text.slice(0, m.index))![0] + text.slice(m.index).match(/^[\p{L}'’-]*/u)![0];
    if (compound.includes('-')) {
      if (text[end] === '-' && PREFIXES.has(word.toLowerCase())) continue;
      const joined = compound.replace(/^-+|-+$/g, '');
      if (check.has(joined) || check.has(joined.replace(/-/g, ''))) continue;
    }
    out.push({ word: text.slice(m.index, end), start: m.index, end });
  }
  return out;
}
