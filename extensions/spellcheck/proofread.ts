// The AI proofread's prompt and the reading of its answer. Pure, so test/spellcheck.test.ts holds it.

/** One call reads at most this much of a draft. */
export const MAX_PROOFREAD_CHARS = 24_000;
export const MAX_ISSUES = 60;

export const PROOFREAD_SYSTEM = `You proofread a draft written in markdown. Find spelling mistakes, typos, wrong or doubled words, and plain grammar errors. Leave alone: style and word choice, markdown and HTML syntax, links and URLs, anything inside [[ ]] or ![[ ]], code, [TK]…[/TK] scopes, lines of the form [label]: #, and names you do not know unless they are clearly misspelled.

Answer with a JSON array and nothing else. Each element is {"find": …, "replace": …, "why": …}:
- "find" is copied exactly from the draft, including punctuation and case: the error with a few words around it, so it occurs once in the draft.
- "replace" is that same text, corrected, changing nothing else.
- "why" is a few words, such as "spelling", "doubled word", "agreement".
At most ${MAX_ISSUES} elements. If there is nothing to fix, answer [].`;

export interface Issue {
  find: string;
  replace: string;
  why: string;
}

/** The issues in a model's answer that can be applied: found in the text, and changing something. */
export function readIssues(answer: string, text: string): Issue[] {
  const start = answer.indexOf("[");
  const end = answer.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const { find, replace, why } = raw as Record<string, unknown>;
    if (typeof find !== "string" || typeof replace !== "string" || !find || find === replace || !text.includes(find) || seen.has(find)) continue;
    seen.add(find);
    out.push({ find, replace, why: typeof why === "string" ? why.slice(0, 80) : "" });
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}
