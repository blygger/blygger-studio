import { versionState } from './version-state.ts';
// Generated changelog notes — decision #40, spec §5.2 + §5.2.
//
// The studio drafts a note from the local diff between the published version
// and the working copy; the author sees it in the note field and may edit it
// before publishing. Drafting happens before publish, never inside it: publish
// stays network-free (#26), and a note nobody looked at is not "editable before
// publish".
//
// The one hard rule is depth (§5.2): **a note describes a change; it never
// reproduces withheld content.** Where the prior version is unpinned its text is
// private, so the note describes and MUST NOT quote it. Between two pinned
// versions nothing is withheld and the note may be as full as it likes. The
// prompt says so, and `quotesWithheld` checks it mechanically, because a prompt
// is a request and this is a rule.

import { complete, ProviderError, AiBudgetError, type ProviderFetchLike, platformProviderFetch } from "./ai/provider.ts";
import { getVersion } from "./model.ts";
import { parseScopes, stripToOutput } from "./tk.ts";
import type { Env, ItemRow } from "./types.ts";

/** A run this long, copied from removed text, counts as reproducing it. */
export const QUOTE_RUN_WORDS = 6;

// Apostrophes only inside a word: a quote mark around a run must not hide it.
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];

/**
 * Does `note` reproduce a run of `QUOTE_RUN_WORDS` words that the prior version
 * had and the new version does not? Text still present in the new version is
 * public after publish, so quoting it withholds nothing.
 */
export function quotesWithheld(note: string, prior: string, next: string): boolean {
  const n = words(note);
  if (n.length < QUOTE_RUN_WORDS) return false;
  const p = ` ${words(prior).join(" ")} `;
  const q = ` ${words(next).join(" ")} `;
  for (let i = 0; i + QUOTE_RUN_WORDS <= n.length; i++) {
    const run = ` ${n.slice(i, i + QUOTE_RUN_WORDS).join(" ")} `;
    if (p.includes(run) && !q.includes(run)) return true;
  }
  return false;
}

const SYSTEM = [
  "You write the changelog note for a new version of a short published piece of writing.",
  "The note is one or two plain sentences, under 200 characters, describing what changed",
  "between the previous version and the new one: what was added, cut, corrected, sharpened",
  "or reorganized. It is read in feed readers next to the new version, so write it for a",
  "reader, in the past tense, without praise and without restating the whole piece.",
  "Output ONLY the note text: no quotation marks around it, no preamble.",
].join(" ");

const WITHHELD =
  "The previous version is private. Describe the change in your own words and never quote, " +
  "paraphrase closely, or reproduce any wording that appears only in the previous version.";

export type DraftNoteResult =
  | { ok: true; note: string; model: string; pinnedPrior: boolean }
  | { ok: false; status: 400 | 409 | 422 | 429 | 502; error: string };

/** The working copy as it would publish: TK scopes stripped to their output. */
function publishableText(contentMd: string): string | null {
  const { scopes, errors } = parseScopes(contentMd);
  if (errors.length || scopes.some((s) => s.output === null)) return null;
  return stripToOutput(contentMd, scopes).text;
}

export async function draftChangeNote(
  env: Env,
  item: ItemRow,
  fetchImpl: ProviderFetchLike = platformProviderFetch,
): Promise<DraftNoteResult> {
  if (item.version === 0) return { ok: false, status: 409, error: "a first version has no previous version to describe" };
  const prior = await getVersion(env.DB, item.id, item.version);
  if (!prior || versionState(prior) === "withdrawn") return { ok: false, status: 409, error: "the published version is a withdrawal; there is no previous text to compare" };
  const next = publishableText(item.content_md);
  if (next === null) return { ok: false, status: 400, error: "the working copy has TK scopes that are not publish-ready" };
  if (next === prior.content_md) return { ok: false, status: 409, error: "the working copy is the same as the published version" };

  const pinnedPrior = prior.pinned === 1;
  const user = [
    `Previous version (v${prior.version}${pinnedPrior ? ", pinned and public" : ", private"}):\n${prior.content_md}`,
    `New version (v${item.version + 1}):\n${next}`,
    ...(pinnedPrior ? [] : [WITHHELD]),
  ].join("\n\n");

  let result;
  try {
    result = await complete(env, SYSTEM, user, fetchImpl, "changelog");
  } catch (e) {
    if (e instanceof AiBudgetError) return { ok: false, status: 429, error: e.message };
    if (e instanceof ProviderError) return { ok: false, status: 502, error: e.message };
    throw e;
  }
  const note = result.text.trim().replace(/^["“]|["”]$/g, "").trim();
  if (!note) return { ok: false, status: 502, error: "the model returned an empty note" };
  if (!pinnedPrior && quotesWithheld(note, prior.content_md, next)) {
    return {
      ok: false,
      status: 422,
      error: "the drafted note reproduced wording from the unpublished previous version, which a note must not do (§5.2); draft again or write it yourself",
    };
  }
  return { ok: true, note, model: result.model, pinnedPrior };
}
