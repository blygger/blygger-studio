export function searchWords(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
}

// FTS5's trigram tokenizer needs three Unicode characters. A NUL would
// terminate the MATCH expression, so check such terms against candidates.
export function canIndexSearchWord(word: string): boolean {
  return !word.includes('\0') && [...word].length >= 3;
}
