/*
 * The Agentic feed's edition (blygger-spec docs/agentic-feed-plan.md): the one
 * document an assistant writes and the Agentic feed tab renders, a digest of
 * sections that refer to entries the reader already holds. The assistant
 * chooses and words; it never supplies anyone's content, so a reference that
 * does not resolve simply drops out. Studio-private (migration 0052).
 *
 * Two modes (Venkat, session 77): `sections`, a laid-out edition, or `scores`,
 * per-entry scores the Studio lays out as one section, highest first.
 *
 * Two entry kinds name what the reader does not hold (plan §3.3, session 92):
 * a `mention` names a verified receipt, drawn from what the receiver stored;
 * a `remote` names an item on an origin the last discovery met (met_origins,
 * migration 0066), read through /peek when opened. Neither carries content.
 */
import { OWN_SUBSCRIPTION } from "./own-subscription.ts";
import { hiddenItemSql } from "./private-access.ts";
import { enabledRules } from "./background.ts";
import { getSettings } from "./model.ts";
import { readingEntries, type Identity } from "./reading-data.ts";
import { editionMarkdown, writeEditionDraft } from "./agentic-thread.ts";
import { formatDateIn } from "./dates.ts";
import { normalizeOrigin } from "./stub.ts";

import { AGENTIC_PRESENTS, AGENTIC_SECTION_KINDS } from "./agentic-limits.ts";
/** How many scored entries the Studio lays out. */
export const SCORED_SHOWN = 50;

type Present = (typeof AGENTIC_PRESENTS)[number];
type SectionKind = (typeof AGENTIC_SECTION_KINDS)[number];
interface Reference { sub: string; remoteId: string }
/** What an entry names: an item the reader holds, a verified mention receipt, or an item on a met origin. */
export type EntryReference = Reference | { mention: string } | { remote: { origin: string; id: string } };
export type AgenticEntry = EntryReference & { version?: number; headline?: string; summary?: string; reason?: string; present?: Present; group?: string };
export interface AgenticSection { title: string; kind?: SectionKind; note?: string; entries: AgenticEntry[] }
export interface AgenticScore extends Reference { score: number; reason?: string }
export interface AgenticEditionInput {
  title?: string;
  lede?: string;
  agent: { name: string; model?: string };
  generatedAt?: string;
  sections?: AgenticSection[];
  scores?: AgenticScore[];
}
interface Row { revision: number; mode: "sections" | "scores" | null; edition_json: string | null; updated_at: string | null; draft_id: string | null; draft_md: string | null }

/** The default feed's id; the only feed until the UI grows more tabs (plan §3.3). */
export const DEFAULT_FEED = "default";

async function readRow(db: D1Database, feed: string): Promise<Row | null> {
  return db.prepare("SELECT revision, mode, edition_json, updated_at, draft_id, draft_md FROM agentic_feeds WHERE id = ?").bind(feed).first<Row>();
}

/** The agentic feeds in the owner's order, each with its name: its own, else the default feed's setting, else its id. */
export async function listFeeds(db: D1Database) {
  const [rows, settings] = await Promise.all([
    db.prepare("SELECT id, title, revision, updated_at FROM agentic_feeds ORDER BY position, id").all<{ id: string; title: string | null; revision: number; updated_at: string | null }>(),
    getSettings(db),
  ]);
  return rows.results.map((r) => ({ id: r.id, title: r.title ?? (r.id === DEFAULT_FEED ? settings.agentic_title : r.id), revision: r.revision, updatedAt: r.updated_at }));
}

/** Replace a feed's edition when it is still at `expectedRevision`; false when it has moved on or the feed does not exist. */
export async function replaceEdition(db: D1Database, feed: string, edition: AgenticEditionInput, expectedRevision: number, now: string): Promise<boolean> {
  const mode = edition.sections ? "sections" : "scores";
  const result = await db.prepare(`UPDATE agentic_feeds SET revision = revision + 1, mode = ?, edition_json = ?, updated_at = ? WHERE id = ? AND revision = ?`)
    .bind(mode, JSON.stringify(edition), now, feed, expectedRevision).run();
  if (!result.meta.changes) return false;
  await writeThread(db, feed);
  return true;
}

/** Compose a feed's stored edition into its draft thread (src/agentic-thread.ts), headed with the feed's name. */
async function writeThread(db: D1Database, feed: string): Promise<void> {
  // Called after a replace, so the row exists, holds an edition, and has its update time.
  const [row, read, settings, feeds] = await Promise.all([readRow(db, feed), readEdition(db, feed), getSettings(db), listFeeds(db)]);
  const layout = read!.layout!;
  const date = formatDateIn(layout.generatedAt ?? row!.updated_at!, settings.timezone);
  const markdown = editionMarkdown(layout, feeds.find((f) => f.id === feed)!.title, date);
  const id = await writeEditionDraft(db, { id: row!.draft_id, md: row!.draft_md }, markdown);
  // While the composed draft names a hidden own item it is hidden too, like a tainted draft
  // (Venkat, session 85; a stopgap until agentic-feed-plan §3.1 makes edition drafts private
  // items). The mark follows each composition: it clears when one names none.
  const own = layout.sections.flatMap((s) => s.entries).flatMap((e) => ("entry" in e && e.entry.own ? [e.entry.own.id] : []));
  const names = own.length ? await db.prepare(`SELECT 1 AS hit FROM items i WHERE id IN (SELECT value FROM json_each(?)) AND ${hiddenItemSql("i")} LIMIT 1`).bind(JSON.stringify(own)).first() : null;
  await db.batch([
    db.prepare("UPDATE agentic_feeds SET draft_id = ?, draft_md = ? WHERE id = ?").bind(id, markdown, feed),
    db.prepare("UPDATE items SET private_taint = ? WHERE id = ? AND status = 'draft' AND private_taint IS NOT ?").bind(names ? 1 : 0, id, names ? 1 : 0),
  ]);
}

const identityOf = (ref: Reference): Identity =>
  ref.sub === OWN_SUBSCRIPTION ? { source: "own", sub: "", id: ref.remoteId, at: null } : { source: "imported", sub: ref.sub, id: ref.remoteId, at: null };
const keyOf = (ref: Reference) => ref.sub === OWN_SUBSCRIPTION ? `own:${ref.remoteId}` : `imported:${JSON.stringify([ref.sub, ref.remoteId])}`;
/** An outside entry's identity, so a repeat is shown once. A remote origin is compared normalized. */
const outsideKey = (ref: Exclude<EntryReference, Reference>) => ("mention" in ref ? `mention:${ref.mention}` : `remote:${JSON.stringify([normalizeOrigin(ref.remote.origin), ref.remote.id])}`);

/** The sections an edition draws, in either mode, before resolving. */
export function sectionsOf(edition: AgenticEditionInput): AgenticSection[] {
  if (edition.sections) return edition.sections;
  const ranked = [...(edition.scores ?? [])].sort((a, b) => b.score - a.score).slice(0, SCORED_SHOWN);
  return [{ title: "Ranked for you", kind: "section", entries: ranked.map(({ sub, remoteId, reason }) => ({ sub, remoteId, ...(reason ? { reason } : {}) })) }];
}

type ReceiptRow = { id: string; source_page: string | null; source_origin: string | null; source_id: string | null; source_kind: string | null; relation: string | null; source_author_json: string | null; verified_at: string | null; target_item_id: string };
type MetRow = { origin: string; listed: number; title: string | null };

/** The verified receipts and met origins an edition's outside entries name, keyed as entryKey keys them. */
async function outsideCards(db: D1Database, refs: readonly EntryReference[]) {
  const receiptIds = refs.flatMap((r) => ("mention" in r ? [r.mention] : []));
  const origins = refs.flatMap((r) => ("remote" in r ? [normalizeOrigin(r.remote.origin) ?? ""] : []));
  const [receipts, met] = await Promise.all([
    receiptIds.length ? db.prepare("SELECT id, source_page, source_origin, source_id, source_kind, relation, source_author_json, verified_at, target_item_id FROM mentions_in WHERE status = 'verified' AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(receiptIds)).all<ReceiptRow>() : null,
    origins.length ? db.prepare("SELECT origin, listed, title FROM met_origins WHERE origin IN (SELECT value FROM json_each(?))").bind(JSON.stringify(origins)).all<MetRow>() : null,
  ]);
  // The stored author's name, when it is a non-empty string; a missing or unreadable author is none.
  const author = (json: string | null) => {
    let a: { name?: unknown } | null;
    try { a = JSON.parse(String(json)) as { name?: unknown } | null; } catch { return null; }
    return typeof a?.name === "string" && a.name ? a.name : null;
  };
  return {
    receipts: new Map((receipts?.results ?? []).map((r) => [r.id, { sourcePage: r.source_page, sourceOrigin: r.source_origin, sourceId: r.source_id, sourceKind: r.source_kind, relation: r.relation, author: author(r.source_author_json), verifiedAt: r.verified_at, targetItemId: r.target_item_id }])),
    sites: new Map((met?.results ?? []).map((m) => [m.origin, { title: m.title, listed: m.listed === 1 }])),
  };
}

/** An outside entry as the tab draws it: a mention with its verified receipt, a remote item with its met origin; nothing when neither resolves. */
function placeOutside(ref: Extract<AgenticEntry, { mention: string } | { remote: unknown }>, cards: Awaited<ReturnType<typeof outsideCards>>) {
  if ("mention" in ref) { const receipt = cards.receipts.get(ref.mention); return receipt && { ...ref, receipt }; }
  const site = cards.sites.get(normalizeOrigin(ref.remote.origin) ?? "");
  return site && { ...ref, site };
}

/**
 * The stored edition and what the tab draws: every reference resolved to its
 * reading entry, with withdrawn ones and ones no longer held left out, a
 * repeat of an entry already shown left out, and empty sections dropped.
 */
export async function readEdition(db: D1Database, feed: string) {
  const row = await readRow(db, feed);
  if (!row) return;
  const edition = row.edition_json ? (JSON.parse(row.edition_json) as AgenticEditionInput) : null;
  const draft = row.draft_id ? { id: row.draft_id } : null;
  if (!edition) return { revision: row.revision, updatedAt: row.updated_at, mode: row.mode, edition: null, layout: null, draft };
  const sections = sectionsOf(edition);
  const refs = sections.flatMap((s) => s.entries);
  const identities = refs.flatMap((r) => ("sub" in r ? [identityOf(r)] : []));
  const rules = enabledRules((await getSettings(db)).bg_rules);
  const [held, outside] = await Promise.all([readingEntries(db, identities, rules), outsideCards(db, refs)]);
  const entries = new Map(held.filter((e) => !e.withdrawn).map((e) => [e.key, e]));
  // Each reference resolved to what the tab draws, or nothing: a held entry, a verified receipt, or a met origin.
  const resolve = (ref: AgenticEntry) => {
    if (!("sub" in ref)) return placeOutside(ref, outside);
    const entry = entries.get(keyOf(ref));
    return entry && { ...ref, entry };
  };
  const entryKey = (ref: AgenticEntry) => ("sub" in ref ? keyOf(ref) : outsideKey(ref));
  const shown = new Set<string>();
  const laid = sections.map((section) => ({
    title: section.title,
    kind: section.kind ?? "section",
    note: section.note ?? null,
    entries: section.entries.flatMap((ref) => {
      const placed = resolve(ref);
      if (!placed || shown.has(entryKey(ref))) return [];
      shown.add(entryKey(ref));
      return [placed];
    }),
  })).filter((section) => section.entries.length);
  return {
    revision: row.revision,
    updatedAt: row.updated_at,
    mode: row.mode,
    edition,
    layout: { title: edition.title ?? null, lede: edition.lede ?? null, agent: edition.agent, generatedAt: edition.generatedAt ?? null, sections: laid },
    draft,
  };
}
