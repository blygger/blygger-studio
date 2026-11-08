// Changelog display and summaries (session 61, Venkat).
//
// An item's changelog is on the wire already (§5.2): every version's note, its
// time, and whether it is pinned. Settings choose how much of it a reader sees:
// the latest note, every note, or an AI summary of them, separately for an
// item's own public page (changelog_display) and for blyg items in the reader
// (reader_changelog_display).
//
// A summary reads **notes only**, never the text of a version. Notes are
// public by construction and already obey §5.2's depth rule, so a summary of
// them cannot reproduce withheld content. It is studio-private presentation:
// stored here, shown on a page with an AI label, never put in an item document
// or the feed.
//
// Cost. A summary is written once per item version and kept, so a page that is
// viewed a thousand times costs one model call. The row for an item is claimed
// before the call (status "pending"), so two views arriving together do not
// both pay; a claim left by a request that died is taken over after
// STALE_CLAIM_MS, and a failure is retried after RETRY_FAILED_MS.

import { complete, ProviderError, AiBudgetError, type ProviderFetchLike, platformProviderFetch } from "./ai/provider.ts";
import { getSettings, listVersions } from "./model.ts";
import { versionState } from "./version-state.ts";
import type { Env } from "./types.ts";

export interface ChangelogEntry {
  version: number;
  at: string;
  note: string | null;
  pinned: boolean;
}

/** Longest summary shown; the prompt asks for less. */
export const SUMMARY_MAX_CHARS = 600;
const STALE_CLAIM_MS = 10 * 60 * 1000;
const RETRY_FAILED_MS = 60 * 60 * 1000;

/** Worth showing more than the latest note: more than one version, or any note at all. */
export function meaningful(entries: readonly ChangelogEntry[]): boolean {
  return entries.length > 1 || entries.some((e) => !!e.note?.trim());
}

/** An own item's changelog as published: every version but a withdrawal endcap. */
export async function ownChangelog(db: D1Database, itemId: string): Promise<ChangelogEntry[]> {
  return (await listVersions(db, itemId))
    .filter((v) => versionState(v) !== "withdrawn")
    .map((v) => ({ version: v.version, at: v.published_at, note: v.note, pinned: v.pinned === 1 }));
}

export const ownSubject = (id: string) => `own:${id}`;
export const importedSubject = (subscriptionId: string, remoteId: string) => `imp:${subscriptionId}:${remoteId}`;

const SYSTEM = [
  "You summarize the revision history of one published piece of writing, from its changelog:",
  "the author's note for each version, oldest first. Write two to four plain sentences, under",
  `${SUMMARY_MAX_CHARS - 100} characters, saying how the piece has developed: what kinds of change`,
  "were made and in what order, which versions the author pinned as worth keeping, and where it",
  "stands now. Work only from the notes; you have not seen the text and must not invent its content.",
  "A version with no note changed without saying how. Output ONLY the summary: no heading, no preamble.",
].join(" ");

/** The changelog as the model reads it: one line per version. */
export function changelogLines(entries: readonly ChangelogEntry[]): string {
  return entries
    .map((e) => `v${e.version} (${e.at.slice(0, 10)}${e.pinned ? ", pinned" : ""}): ${e.note?.trim() || "(no note)"}`)
    .join("\n");
}

/** The owner's own instructions, appended when set. */
export function ownerInstructions(prompt: string): string[] {
  const p = prompt.trim();
  return p ? [`The author's instructions for summaries:\n${p}`] : [];
}

/** Cut at the last sentence end within `max`, else at a word, marked with an ellipsis. */
export function capText(text: string, max: number): string {
  const t = text.trim().replace(/^["“]|["”]$/g, "").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentence > max * 0.5) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(" ");
  return `${head.slice(0, word > 0 ? word : max - 1).trimEnd()}…`;
}

export type SummaryResult =
  | { ok: true; summary: string; model: string; version: number; cached: boolean }
  | { ok: false; status: 409 | 429 | 502; error: string };

interface SummaryRow {
  version: number;
  status: "pending" | "ready" | "failed";
  summary: string | null;
  model: string | null;
  at: string;
}

/** The stored summary for this exact version, if one is ready. */
export async function storedSummary(db: D1Database, subject: string, version: number): Promise<{ summary: string; model: string } | null> {
  const row = await db
    .prepare("SELECT version, status, summary, model, at FROM changelog_summaries WHERE subject = ?")
    .bind(subject)
    .first<SummaryRow>();
  return row && row.status === "ready" && row.version === version && row.summary ? { summary: row.summary, model: row.model ?? "" } : null;
}

/**
 * Take the row for this version, or report that another request holds it or
 * it is ready already. A claim is granted for a newer version, for a claim
 * gone stale, and for a failure old enough to retry.
 */
async function claim(db: D1Database, subject: string, version: number, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const stale = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const retry = new Date(now.getTime() - RETRY_FAILED_MS).toISOString();
  const result = await db
    .prepare(
      `INSERT INTO changelog_summaries (subject, version, status, summary, model, at) VALUES (?1, ?2, 'pending', NULL, NULL, ?3)
       ON CONFLICT(subject) DO UPDATE SET version = excluded.version, status = 'pending', summary = NULL, model = NULL, at = excluded.at
       WHERE changelog_summaries.version < excluded.version
          OR (changelog_summaries.version = excluded.version AND changelog_summaries.status = 'pending' AND changelog_summaries.at < ?4)
          OR (changelog_summaries.version = excluded.version AND changelog_summaries.status = 'failed' AND changelog_summaries.at < ?5)`,
    )
    .bind(subject, version, at, stale, retry)
    .run();
  return result.meta.changes > 0;
}

/**
 * The summary for `subject` at `version`: the stored one, or a new one written
 * from `entries` (which must be that version's changelog). Concurrent callers
 * that lose the claim get 409 and the stored summary once it is ready.
 */
export async function summarizeChangelog(
  env: Env,
  subject: string,
  version: number,
  entries: readonly ChangelogEntry[],
  fetchImpl: ProviderFetchLike = platformProviderFetch,
  now = new Date(),
): Promise<SummaryResult> {
  const stored = await storedSummary(env.DB, subject, version);
  if (stored) return { ok: true, ...stored, version, cached: true };
  if (!meaningful(entries)) return { ok: false, status: 409, error: "this item's changelog has nothing to summarize" };
  if (!(await claim(env.DB, subject, version, now))) {
    return { ok: false, status: 409, error: "a summary of this version is being written or failed recently; try again shortly" };
  }
  const settings = await getSettings(env.DB);
  const user = [`Changelog, oldest first:\n${changelogLines(entries)}`, ...ownerInstructions(settings.changelog_summary_prompt)].join("\n\n");
  const fail = async (status: 429 | 502, error: string): Promise<SummaryResult> => {
    await env.DB.prepare("UPDATE changelog_summaries SET status = 'failed', at = ? WHERE subject = ? AND version = ?")
      .bind(now.toISOString(), subject, version)
      .run();
    return { ok: false, status, error };
  };
  let result;
  try {
    result = await complete(env, SYSTEM, user, fetchImpl, "changelog");
  } catch (e) {
    if (e instanceof AiBudgetError) return fail(429, e.message);
    if (e instanceof ProviderError) return fail(502, e.message);
    await fail(502, "the summary could not be written");
    throw e;
  }
  const summary = capText(result.text, SUMMARY_MAX_CHARS);
  if (!summary) return fail(502, "the model returned an empty summary");
  await env.DB.prepare("UPDATE changelog_summaries SET status = 'ready', summary = ?, model = ?, at = ? WHERE subject = ? AND version = ?")
    .bind(summary, result.model, now.toISOString(), subject, version)
    .run();
  return { ok: true, summary, model: result.model, version, cached: false };
}
