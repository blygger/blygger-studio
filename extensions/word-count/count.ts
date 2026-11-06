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

// Markdown the server has not rendered: link and image syntax is not words.
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const QUOTE = /!\[\[[^\]]*\]\]/g;
const LABELLED = /\[\[[^\]|]*\|([^\]]*)\]\]/g;
const BARE = /\[\[[^\]]*\]\]/g;

/**
 * Words in text with no server copy to count, near enough: what the composer
 * shows while typing. It cannot see what the server resolves, so a quote and a
 * bare [[id]] link's title count as nothing until the text is saved and opened.
 */
export function countMarkdown(md: string): Count {
  return countWords(md.replace(QUOTE, ' ').replace(IMAGE, ' ').replace(LABELLED, '$1').replace(BARE, ' ').replace(LINK, '$1'));
}

export function countWords(html: string): Count {
  const text = textOf(html);
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, ' ').match(WORD)?.length ?? 0;
  return { words, cjk };
}
