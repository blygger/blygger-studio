// Words in a piece of published HTML. Shared by both halves: the server counts
// our own items and their outline trees (tree.ts), the browser counts imported
// entries from the HTML the reading view already holds.
//
// The same definition as reading-time's: words are runs of letters and digits,
// and Han, kana and Hangul, which are not written with spaces, are counted
// character by character rather than as one enormous "word". Quoted passages
// are part of a thread's published HTML (the baked snapshot), so they count.

export interface Count {
  words: number;
  cjk: number;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/** The text of an HTML fragment, near enough for counting: tags become spaces. */
function textOf(html: string) {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&[#\w]+;/g, ' ');
}

export function countWords(html: string): Count {
  const text = textOf(html);
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, ' ').match(WORD)?.length ?? 0;
  return { words, cjk };
}
