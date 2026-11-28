/*
 * The resident assistant's digest (blygger-spec docs/agentic-digest-plan.md §8;
 * laws 1, 2 and 5 approved by Venkat, session 90, laws 3 and 4 session 92):
 * Highlights and Happening conversations, chosen by rule from what this reader
 * holds, then mentions from blygs it does not follow and the met blygs the
 * last discovery found active (src/agentic-discovery.ts). No model is
 * involved; the AI layer (plan §3.1) may only rank and word within what these
 * rules admit. Owned by test/agentic-digest.oracle.test.ts and, for the two
 * outside sections, test/agentic-outside.oracle.test.ts.
 */
import { DEFAULT_FEED, readEdition, replaceEdition, type AgenticEntry, type AgenticSection } from "./agentic.ts";
import { ownWordCount } from "./fork-flatten.ts";
import { getSettings } from "./model.ts";
import { OWN_SUBSCRIPTION } from "./own-subscription.ts";
import { NEW_BLYGS_SHOWN, discoverBlygs, followedOrigins, isFresh } from "./agentic-discovery.ts";
import type { FetchLike } from "./importer/http.ts";
import { normalizeOrigin } from "./stub.ts";

/** The edition's window follows its frequency (Venkat, session 90): the day before it for an hourly or daily edition, the week before it for a weekly one. */
export const windowFor = (frequency: "hourly" | "daily" | "weekly") => (frequency === "weekly" ? 7 : 1) * 24 * 3600 * 1000;
/** A highlight says at least this many words itself (Venkat, session 90). */
export const HIGHLIGHT_OWN_WORDS = 300;
export const HIGHLIGHTS_SHOWN = 7;
export const CONVERSATIONS_SHOWN = 5;
export const MENTIONS_SHOWN = 5;
/** A conversation shows its newest items, oldest first. */
export const CONVERSATION_ENTRIES = 6;

/** A held item as the digest reads it. */
export interface DigestItem {
  sub: string;
  remoteId: string;
  /** Its node in the link graph: its blyg's origin and its id. */
  node: string;
  created: number;
  /** Imported from a followed blyg outside Background, and not a stub or fork. */
  candidate?: true;
  /** The words it says itself, read only for a candidate in the window. */
  ownWords?: number;
  /** The nodes it points at: its stub target, its quotes and its links. */
  names: string[];
}

const withSlash = (origin: string) => origin.replace(/\/?$/, "/");
const nodeOf = (origin: string, id: string) => `${withSlash(origin)}|${id}`;
/** Whose it is: its node's origin. A conversation needs two. */
const authorOf = (item: DigestItem) => item.node.slice(0, item.node.lastIndexOf("|"));
const keyOf = (item: DigestItem) => `${item.sub}|${item.remoteId}`;
// Ties fall to the item id, then its subscription.
const byKey = (a: DigestItem, b: DigestItem) => (a.remoteId < b.remoteId ? -1 : a.remoteId > b.remoteId ? 1 : a.sub < b.sub ? -1 : a.sub > b.sub ? 1 : 0);

/** The nodes a stub target, a quote list and a link list point at; a bare id is on the item's own blyg. Each is JSON this client stored. */
function namesOf(origin: string, stubOf: string | null, quotes: string | null, links: string | null): string[] {
  const refs: { id?: unknown; origin?: unknown }[] = [...(stubOf ? [JSON.parse(stubOf)] : []), ...(quotes ? JSON.parse(quotes) : []), ...(links ? JSON.parse(links) : [])];
  return refs.flatMap((r) => (typeof r.id === "string" ? [nodeOf(typeof r.origin === "string" ? r.origin : origin, r.id)] : []));
}

/** Created in the window of `windowMs` that ends at `now`, its start excluded. */
const inWindow = (created: number, now: number, windowMs: number) => created > now - windowMs && created <= now;

/** The digest's sections over the held items and verified mentions, for the window of `windowMs` ending at `now`. */
export function digestSections(items: readonly DigestItem[], mentions: readonly [string, string][], now: number, windowMs: number): AgenticSection[] {
  const fresh = (item: DigestItem) => inWindow(item.created, now, windowMs);
  // The link graph's connected parts, found by walking it: an item, every node it points at, and both ends of a mention.
  const edges = new Map<string, string[]>();
  const link = (a: string, b: string) => { edges.set(a, [...(edges.get(a) ?? []), b]); edges.set(b, [...(edges.get(b) ?? []), a]); };
  for (const item of items) for (const name of item.names) link(item.node, name);
  for (const [a, b] of mentions) link(a, b);
  const byNode = new Map(items.map((item) => [item.node, item]));
  const seen = new Set<string>();
  const components: DigestItem[][] = [];
  // A walk from an item already reached finds only that item, which no filter below admits.
  for (const item of items) {
    const members: DigestItem[] = [];
    const queue = [item.node];
    seen.add(item.node);
    while (queue.length) {
      const node = queue.pop()!;
      const held = byNode.get(node);
      if (held) members.push(held);
      for (const next of edges.get(node) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    components.push(members);
  }

  const conversations = components
    .filter((members) => new Set(members.map(authorOf)).size >= 2 && members.some(fresh))
    .map((members) => ({ members: [...members].sort((a, b) => a.created - b.created || byKey(a, b)), fresh: members.filter(fresh).length, newest: Math.max(...members.map((m) => m.created)), first: [...members].sort(byKey)[0]! }))
    .sort((a, b) => b.fresh - a.fresh || b.newest - a.newest || byKey(a.first, b.first))
    .slice(0, CONVERSATIONS_SHOWN);
  const claimed = new Set(conversations.flatMap((c) => c.members.map(keyOf)));
  const highlights = items
    .filter((item) => item.candidate && fresh(item) && (item.ownWords ?? 0) >= HIGHLIGHT_OWN_WORDS && !claimed.has(keyOf(item)))
    .sort((a, b) => b.ownWords! - a.ownWords! || b.created - a.created || byKey(a, b))
    .slice(0, HIGHLIGHTS_SHOWN);

  const entry = (item: DigestItem, group?: string): AgenticEntry => ({ sub: item.sub, remoteId: item.remoteId, ...(group ? { group } : {}) });
  // An empty section is left to the layout, which draws no section without entries.
  return [
    { title: "Highlights", kind: "lead", entries: highlights.map((item) => entry(item)) },
    { title: "Happening conversations", entries: conversations.flatMap((c, n) => c.members.slice(-CONVERSATION_ENTRIES).map((item) => entry(item, `conversation-${n + 1}`))) },
  ];
}

/** A verified receipt as the Mentions section reads it. */
export interface DigestReceipt { id: string; sourceOrigin: string; verifiedAt: number }

/** Mentions (law 3): receipts (given in id order) verified in the window whose source is neither followed nor `own`, newest first, then by id. */
export function mentionEntries(receipts: readonly DigestReceipt[], followed: ReadonlySet<string>, own: string | null, now: number, windowMs: number): AgenticEntry[] {
  return receipts
    .filter((r) => inWindow(r.verifiedAt, now, windowMs) && !followed.has(r.sourceOrigin) && r.sourceOrigin !== own)
    .sort((a, b) => b.verifiedAt - a.verifiedAt)
    .slice(0, MENTIONS_SHOWN)
    .map((r) => ({ mention: r.id }));
}

/** A met origin the last discovery found active, with its sample. */
export interface MetSample { origin: string; met: number; sampleId: string; created: number }

/** New blygs (law 4): the last discovery's active origins (given in origin order), less any followed since or gone stale, most met first, then newest, then origin. */
export function newBlygEntries(samples: readonly MetSample[], followed: ReadonlySet<string>, now: number): AgenticEntry[] {
  return samples
    .filter((s) => !followed.has(s.origin) && isFresh(s.created, now))
    .sort((a, b) => b.met - a.met || b.created - a.created)
    .slice(0, NEW_BLYGS_SHOWN)
    .map((s) => ({ remote: { origin: s.origin, id: s.sampleId } }));
}

/** The receipts verified in the window, the last discovery's samples, and the origins followed, read for the outside sections. */
async function loadOutside(db: D1Database, now: number, windowMs: number) {
  const [receipts, samples, followed] = await Promise.all([
    // Stored times may omit milliseconds, so the index narrows by a day's margin and the window is judged on parsed times.
    db.prepare("SELECT id, source_origin, verified_at FROM mentions_in WHERE status = 'verified' AND verified_at > ? ORDER BY id")
      .bind(new Date(now - windowMs - 24 * 3600 * 1000).toISOString()).all<{ id: string; source_origin: string | null; verified_at: string }>(),
    db.prepare("SELECT origin, met, sample_id, sample_created FROM met_origins WHERE sample_id IS NOT NULL ORDER BY origin").all<{ origin: string; met: number; sample_id: string; sample_created: string }>(),
    followedOrigins(db),
  ]);
  return {
    receipts: receipts.results.flatMap((r) => { const origin = normalizeOrigin(r.source_origin); return origin ? [{ id: r.id, sourceOrigin: origin, verifiedAt: Date.parse(r.verified_at) }] : []; }),
    samples: samples.results.map((s) => ({ origin: s.origin, met: s.met, sampleId: s.sample_id, created: Date.parse(s.sample_created) })),
    followed,
  };
}

/** The two sections from outside what the reader follows (laws 3 and 4), after the daily discovery when `discover` is given. */
export async function outsideSections(db: D1Database, now: number, ownOrigin: string, windowMs: number, discover?: FetchLike): Promise<AgenticSection[]> {
  if (discover) await discoverBlygs(db, discover, now, ownOrigin);
  const outside = await loadOutside(db, now, windowMs);
  return [
    { title: "Mentions from blygs you don't follow", kind: "briefs", entries: mentionEntries(outside.receipts, outside.followed, normalizeOrigin(ownOrigin), now, windowMs) },
    { title: "Newly active blygs", kind: "briefs", entries: newBlygEntries(outside.samples, outside.followed, now) },
  ];
}

type ImportedRow = { sub: string; remote_id: string; kind: string; created: string | null; stub_of_json: string | null; forked_from_json: string | null; transclusions_json: string | null; links_json: string | null; origin: string; background: number | null };
type OwnRow = { id: string; created: string; stub_of: string | null; transclusions: string | null; links_json: string | null };

/** Every held blyg item and own public item, with the link graph's edges, and the own words of the new candidates. */
export async function loadDigest(db: D1Database, now: number, ownOrigin: string, windowMs: number): Promise<{ items: DigestItem[]; mentions: [string, string][] }> {
  const [imported, own, mentions] = await Promise.all([
    db.prepare(`SELECT ii.subscription_id AS sub, ii.remote_id, ii.kind, ii.created, ii.stub_of_json, ii.forked_from_json, ii.transclusions_json, ii.links_json, s.origin, s.background
      FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id
      WHERE ii.state = 'current' AND ii.l0 = 0 AND s.kind = 'blyg' AND s.hopper_feed IS NULL`).all<ImportedRow>(),
    db.prepare(`SELECT i.id, i.created, i.stub_of, v.transclusions, v.links_json FROM items i JOIN versions v ON v.item_id = i.id AND v.version = i.version
      WHERE i.status = 'public'`).all<OwnRow>(),
    db.prepare(`SELECT target_item_id, source_origin, source_id FROM mentions_in WHERE status = 'verified' AND source_origin IS NOT NULL AND source_id IS NOT NULL`)
      .all<{ target_item_id: string; source_origin: string; source_id: string }>(),
  ]);
  const items: DigestItem[] = [
    ...imported.results.map((r) => ({
      sub: r.sub, remoteId: r.remote_id, node: nodeOf(r.origin, r.remote_id),
      // An item that gives no date cannot be shown to be in the window.
      created: Date.parse(r.created ?? "") || 0,
      ...(!r.background && r.kind !== "withdrawn" && !r.stub_of_json && !r.forked_from_json ? { candidate: true as const } : {}),
      names: namesOf(r.origin, r.stub_of_json, r.transclusions_json, r.links_json),
    })),
    ...own.results.map((r) => ({
      sub: OWN_SUBSCRIPTION, remoteId: r.id, node: nodeOf(ownOrigin, r.id),
      created: Date.parse(r.created) || 0,
      names: namesOf(ownOrigin, r.stub_of, r.transclusions, r.links_json),
    })),
  ];
  // Own words for the new items (own ones have no imported body): only the window's bodies are read.
  const wanted = items.filter((item) => inWindow(item.created, now, windowMs));
  const bodies = await db.prepare(`SELECT subscription_id AS sub, remote_id, content_html FROM imported_items
    WHERE (subscription_id, remote_id) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`)
    .bind(JSON.stringify(wanted.map((item) => [item.sub, item.remoteId]))).all<{ sub: string; remote_id: string; content_html: string }>();
  const words = new Map(bodies.results.map((b) => [`${b.sub}|${b.remote_id}`, ownWordCount(b.content_html ?? "")]));
  for (const item of wanted) item.ownWords = words.get(keyOf(item));
  return { items, mentions: mentions.results.map((m) => [nodeOf(ownOrigin, m.target_item_id), nodeOf(m.source_origin, m.source_id)]) };
}

/**
 * Write the default feed's edition from the digest's rules, as the resident assistant. An edition
 * whose sections are unchanged is not written again, so an idle reader costs no writes; `force`
 * (regenerate now) writes it anyway, with a new date. With `discover`, the daily discovery runs
 * first through that fetch; without it the edition reads the last discovery and fetches nothing.
 */
export async function writeResidentDigest(db: D1Database, now: number, ownOrigin: string, { force = false, discover }: { force?: boolean; discover?: FetchLike } = {}): Promise<void> {
  const windowMs = windowFor((await getSettings(db)).agentic_frequency);
  const [{ items, mentions }, outside] = await Promise.all([loadDigest(db, now, ownOrigin, windowMs), outsideSections(db, now, ownOrigin, windowMs, discover)]);
  const sections = [...digestSections(items, mentions, now, windowMs), ...outside];
  // The default feed's row is made by its migration (0052).
  const current = (await readEdition(db, DEFAULT_FEED))!;
  const stored = current.edition as { agent: { name: string }; sections: unknown } | null;
  if (!force && stored?.agent.name === "resident" && JSON.stringify(stored.sections) === JSON.stringify(sections)) return;
  const at = new Date(now).toISOString();
  await replaceEdition(db, DEFAULT_FEED, { agent: { name: "resident" }, generatedAt: at, sections }, current.revision, at);
}
