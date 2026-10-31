import { ItemRevisionConflict } from './item-revision.ts';
import { versionState } from './version-state.ts';
// The optional change classifier (session 49; Venkat's "Jev-class super cheap
// classifier" post). Off by default: it runs only when Settings → AI names a
// decision model in `ai_model_classify`, and then only when asked, by the
// Studio's publish dialog, before a publish — never inside one, so publish
// stays network-free (#26), as change-note drafting does (change-note.ts).
//
// The result is a category from change-category.ts. It reaches readers only as
// words in the changelog note the author confirms; the record of it
// (`change_class`, migration 0030) is studio-private. See change-category.ts for
// why nothing here may become a wire member (#19 / TN-1, #77).
//
// Failure is never fatal. No binding, no key, a provider error, an exhausted
// budget or an answer that cannot be parsed all come back as "no category", and
// the author publishes exactly as they would have without the classifier.

import { decide, ProviderError, platformProviderFetch, type DecisionQuestion, type ProviderFetchLike } from "./ai/provider.ts";
import { MODELS, type Manifest } from "./ai/models.ts";
import { isChangeCategory, type ChangeCategory } from "./change-category.ts";
import { getSettings, getVersion } from "./model.ts";
import { parseScopes, stripToOutput } from "./tk.ts";
import type { Env, ItemRow } from "./types.ts";
import { authoredText, contentHash, nowIso } from "./util.ts";
import { diffText } from "./word-diff.ts";

/**
 * The one question asked of the model. Three options; `refresh` is not among
 * them because it is decided locally from content_hash (change-category.ts).
 * The descriptions are the instruction: they say what a returning reader
 * should do, since that is what a category is for.
 */
export const CLASSIFY_QUESTION = {
  type: "choice",
  instructions:
    "The state holds the previous version of a short published piece of writing, the new version, and the words removed and added between them. " +
    "How significant is this change for someone who already read the previous version?",
  criteria: {
    typo:
      "Spelling, punctuation, capitalization, formatting or a broken link fixed. The meaning is unchanged; a reader of the previous version has missed nothing.",
    minor:
      "Small edits to wording or detail: a sentence clarified, reworded, added or cut, a fact corrected in passing. The piece says what it said before; a returning reader need not reread it.",
    major:
      "The substance changed: a new section or argument, a changed claim or conclusion, a large addition or removal. A returning reader should read it again.",
  },
} as const satisfies DecisionQuestion;

const QUESTION_ID = "change";

/** Long versions are cut before they reach the model, and so is a long change list. */
const MAX_VERSION_CHARS = 12_000;
const MAX_CHANGE_CHARS = 6_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[…cut…]` : s);

/** The classifier's state: both versions and the word-level change between them. */
export function classifierState(prior: string, next: string, priorVersion: number): string {
  const changes = diffText(prior, next)
    .filter((op) => op.op !== "eq")
    .map((op) => `${op.op === "del" ? "- removed" : "+ added"}: ${op.text.trim()}`)
    .join("\n");
  return [
    `Previous version (v${priorVersion}):\n${clip(prior, MAX_VERSION_CHARS)}`,
    `New version (v${priorVersion + 1}):\n${clip(next, MAX_VERSION_CHARS)}`,
    `Changes:\n${clip(changes, MAX_CHANGE_CHARS)}`,
  ].join("\n\n");
}

/** The working copy as publish() would store it: authored text, TK scopes stripped to their output. */
function publishableText(contentMd: string): string | null {
  const source = authoredText(contentMd);
  const { scopes, errors } = parseScopes(source);
  if (errors.length || scopes.some((s) => s.output === null)) return null;
  return stripToOutput(source, scopes).text;
}

export type ClassifyResult =
  | { ok: true; version: number; category: ChangeCategory | null; model: string | null; probability: number | null; reason?: string }
  | { ok: false; status: 400 | 409; error: string };

export interface ChangeClassRow {
  item_id: string;
  version: number;
  category: ChangeCategory | null;
  model: string | null;
  probability: number | null;
  classified_at: string;
  overridden: number;
  content_hash: string;
}

async function store(db: D1Database, row: ChangeClassRow, item?: ItemRow): Promise<void> {
  const committed = await db
    .prepare("INSERT OR REPLACE INTO change_class (item_id, version, category, model, probability, classified_at, overridden, content_hash) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM items WHERE id = ? AND revision = ?)")
    .bind(row.item_id, row.version, row.category, row.model, row.probability, row.classified_at, row.overridden, row.content_hash, item?.id ?? null, item?.id ?? null, item?.revision ?? 0)
    .run();
  if (item && !committed.meta.changes) throw new ItemRevisionConflict(item.id, item.revision);
}

/**
 * Classify the change the working copy would publish, and keep the answer for
 * publish to settle. Refuses (409) when the classifier is off or there is no
 * previous version to compare; everything else is `ok`, with a null category
 * and a `reason` when no category could be had.
 */
export async function classifyChange(
  env: Env,
  item: ItemRow,
  fetchImpl: ProviderFetchLike = platformProviderFetch,
  models: Manifest = MODELS,
): Promise<ClassifyResult> {
  const model = (await getSettings(env.DB)).ai_model_classify.trim();
  if (!model) return { ok: false, status: 409, error: "the change classifier is off: choose a decision model in Settings → AI" };
  if (item.version === 0) return { ok: false, status: 409, error: "a first version has no previous version to compare" };
  const prior = await getVersion(env.DB, item.id, item.version);
  if (!prior || versionState(prior) === "withdrawn") return { ok: false, status: 409, error: "the published version is a withdrawal; there is no previous text to compare" };
  const next = publishableText(item.content_md);
  if (next === null) return { ok: false, status: 400, error: "the working copy has TK scopes that are not publish-ready" };
  const version = item.version + 1;
  const hash = await contentHash(next);
  const base = { item_id: item.id, version, classified_at: nowIso(), overridden: 0, content_hash: hash };
  // The same words again: a republish, decided here with no model call.
  if (hash === prior.content_hash) {
    await store(env.DB, { ...base, category: "refresh", model: null, probability: null }, item);
    return { ok: true, version, category: "refresh", model: null, probability: null };
  }
  const none = async (reason: string): Promise<ClassifyResult> => {
    // An older classification of this version must not outlive a failed retry.
    const committed = await env.DB.batch([
      env.DB.prepare("DELETE FROM change_class WHERE item_id = ? AND version = ? AND EXISTS (SELECT 1 FROM items WHERE id = ? AND revision = ?)").bind(item.id, version, item.id, item.revision),
      env.DB.prepare("SELECT revision FROM items WHERE id = ? AND revision = ?").bind(item.id, item.revision),
    ]);
    if (!committed[1].results.length) throw new ItemRevisionConflict(item.id, item.revision);
    return { ok: true, version, category: null, model: null, probability: null, reason };
  };
  let answer;
  try {
    const result = await decide(env, model, classifierState(prior.content_md, next, prior.version), { [QUESTION_ID]: CLASSIFY_QUESTION }, fetchImpl, models);
    answer = result.answers[QUESTION_ID];
  } catch (e) {
    if (e instanceof ProviderError) return none(e.message);
    throw e;
  }
  if (!answer || !isChangeCategory(answer.choice) || answer.choice === "refresh") return none("the model gave no usable answer");
  await store(env.DB, { ...base, category: answer.choice, model, probability: answer.probability }, item);
  return { ok: true, version, category: answer.choice, model, probability: answer.probability };
}

/**
 * Settle a just-published version's record. `requested` is what the author
 * confirmed: undefined when the publish said nothing (the classification, if
 * any, stands), null when the author cleared it, or a category. A record made
 * for different words than were published is dropped first.
 */
export async function settleChangeClass(db: D1Database, itemId: string, version: number, requested: ChangeCategory | null | undefined): Promise<void> {
  const published = await db.prepare("SELECT content_hash FROM versions WHERE item_id = ? AND version = ?").bind(itemId, version).first<{ content_hash: string }>();
  if (!published) return;
  let row = await db.prepare("SELECT * FROM change_class WHERE item_id = ? AND version = ?").bind(itemId, version).first<ChangeClassRow>();
  if (row && row.content_hash !== published.content_hash) {
    await db.prepare("DELETE FROM change_class WHERE item_id = ? AND version = ?").bind(itemId, version).run();
    row = null;
  }
  if (requested === undefined) return;
  if (row) {
    if (row.category !== requested) await db.prepare("UPDATE change_class SET category = ?, overridden = 1 WHERE item_id = ? AND version = ?").bind(requested, itemId, version).run();
    return;
  }
  if (requested === null) return;
  await store(db, { item_id: itemId, version, category: requested, model: null, probability: null, classified_at: nowIso(), overridden: 1, content_hash: published.content_hash });
}

/** The studio-private records of an item's published versions, by version. */
export async function changeClassesFor(db: D1Database, itemId: string, publishedVersion: number): Promise<Map<number, ChangeClassRow>> {
  const rows = (await db.prepare("SELECT * FROM change_class WHERE item_id = ? AND version <= ?").bind(itemId, publishedVersion).all<ChangeClassRow>()).results;
  return new Map(rows.map((r) => [r.version, r]));
}
