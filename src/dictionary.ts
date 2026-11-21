/*
 * The dictionary: words this blyg's spellchecking accepts, shared by every client
 * and device (migration 0049). Studio-private: nothing here reaches an item
 * document, a feed, the manifest, a public page or the static export. The Studio
 * holds the words; a checker (the spellcheck extension, or any client) reads them.
 *
 * Rules, shared by GET and PUT:
 * - A word belongs to a source. "owner" holds the words the author adds; any other
 *   name holds a set that an extension or client installs, such as a technical
 *   domain's terms, and can be replaced or removed as a whole.
 * - A source name is lowercase letters, digits and hyphens (at most 48), starting
 *   and ending with a letter or digit.
 * - A word is 1 to 64 characters with no whitespace and at least one letter, kept
 *   as written (names keep their capitals), in Unicode NFC. A PUT holding a word
 *   that breaks this is refused, naming it; repeats are kept once.
 * - PUT replaces one source's words. An empty list removes the source.
 * - The dictionary has one revision. A PUT must send expectedRevision and applies
 *   only when it matches; every successful PUT bumps it. Several clients share
 *   the dictionary, so one must not silently undo another's addition.
 * - At most 20,000 words a source, 50 sources and 100,000 words in all.
 */

export const OWNER_SOURCE = 'owner';
export const SOURCE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
export const WORD_MAX = 64;
export const SOURCE_WORDS_MAX = 20_000;
export const SOURCES_MAX = 50;
export const TOTAL_WORDS_MAX = 100_000;

export interface DictionarySource { source: string; words: string[] }
export interface Dictionary { sources: DictionarySource[]; revision: number }

/** Why a word can't go in the dictionary, or null when it can. */
export function wordProblem(word: string): string | null {
  if (!word.length) return 'is empty';
  if ([...word].length > WORD_MAX) return `is longer than ${WORD_MAX} characters`;
  if (/\s/u.test(word)) return 'holds whitespace';
  if (!/\p{L}/u.test(word)) return 'holds no letter';
  return null;
}

/** The words as stored: NFC, repeats once, in order. */
export const normalizeWords = (words: readonly string[]) => [...new Set(words.map((word) => word.normalize('NFC')))];

const REVISION = 'COALESCE((SELECT revision FROM dictionary_revision WHERE id = 1), 0)';

const readStatements = (db: D1Database) => [
  db.prepare('SELECT source, word FROM dictionary ORDER BY source, word COLLATE NOCASE, word'),
  db.prepare(`SELECT ${REVISION} AS revision`),
];
function dictionaryFrom(rows: D1Result, revision: D1Result): Dictionary {
  const sources = new Map<string, string[]>();
  for (const { source, word } of rows.results as { source: string; word: string }[]) sources.set(source, [...(sources.get(source) ?? []), word]);
  // The author's own words first, then the installed sets by name.
  const order = [...sources.keys()].sort((a, b) => Number(b === OWNER_SOURCE) - Number(a === OWNER_SOURCE) || a.localeCompare(b));
  return { sources: order.map((source) => ({ source, words: sources.get(source)! })), revision: (revision.results[0] as { revision: number }).revision };
}

export async function readDictionary(db: D1Database): Promise<Dictionary> {
  const [rows, revision] = await db.batch(readStatements(db));
  return dictionaryFrom(rows, revision);
}

/** Replace one source's words in one transaction. Null when expectedRevision is stale. */
export async function replaceSource(db: D1Database, source: string, words: readonly string[], expectedRevision: number): Promise<Dictionary | null> {
  const statements = [
    db.prepare(`DELETE FROM dictionary WHERE source = ?1 AND ${REVISION} = ?2`).bind(source, expectedRevision),
    db.prepare(`INSERT INTO dictionary(source, word) SELECT ?1, value FROM json_each(?3) WHERE ${REVISION} = ?2`).bind(source, expectedRevision, JSON.stringify(words)),
    db.prepare(`INSERT INTO dictionary_revision(id, revision) SELECT 1, ${REVISION} + 1 WHERE ${REVISION} = ?
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision`).bind(expectedRevision),
  ];
  // The read rides in the same transaction, so it is exactly what was stored.
  const results = await db.batch([...statements, ...readStatements(db)]);
  if (!results[statements.length - 1].meta.changes) return null;
  return dictionaryFrom(results[statements.length], results[statements.length + 1]);
}
