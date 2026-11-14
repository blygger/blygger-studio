/*
 * `syndication` (spec 0.4 §16.14, decision #98; a ruled shape awaiting its
 * gate): copies of an item that its publisher made on other networks. Each
 * entry is { url, version }: an absolute https: URL at which the copy can be
 * read, and the version of the item it was made from. Migration 0047.
 *
 * Publisher side (own items):
 * - The list is written in place. It never publishes a version, never adds a
 *   changelog entry and never touches the feed (rule 3); the live item
 *   document carries it, and pinned files and withdrawal endcaps never do
 *   (rule 4).
 * - It is the publisher's claim (rule 2): outside content_hash and
 *   content_html, not a reference, so it sends no mention.
 * - An entry carries a URL and a version and nothing else (rule 1): no counts,
 *   no network name, no account.
 * - The studio requires a published, non-withdrawn item, and each entry's
 *   version must be one of its published versions. A replace bumps the
 *   item's revision, the same as a pin: both rewrite the live document.
 *
 * Reader side (imported items): the member is kept as fetched, filtered to
 * well-formed https: entries, so nothing that is not https: is ever rendered
 * as a link (rule 5). The importer fetches an item document only when its
 * version moves, so an entry added later reaches us at the next version;
 * the spec allows that ("sees it at its next fetch"). Nothing here hides or
 * merges another party's post on the strength of an entry, or says the
 * author is the account that posted the copy.
 */
import { ItemRevisionConflict, assertItemRevision } from './item-revision.ts';
import type { ItemRow } from './types.ts';

export const SYNDICATION_MAX = 20;
export const SYNDICATION_URL_MAX = 2048;

export interface SyndicationEntry { url: string; version: number }

/** An absolute https: URL, or null. The one test both sides use. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > SYNDICATION_URL_MAX) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname ? value : null;
  } catch {
    return null;
  }
}

/**
 * A held document's member as a reader keeps it: well-formed https: entries
 * only, first occurrence of a URL wins, at most SYNDICATION_MAX. Null when
 * nothing is left, so an item with no copies stores nothing.
 */
export function readSyndication(member: unknown): SyndicationEntry[] | null {
  if (!Array.isArray(member)) return null;
  const seen = new Set<string>();
  const entries: SyndicationEntry[] = [];
  for (const raw of member) {
    if (!raw || typeof raw !== 'object') continue;
    const { url, version } = raw as Record<string, unknown>;
    const href = httpsUrl(url);
    if (!href || seen.has(href) || typeof version !== 'number' || !Number.isInteger(version) || version < 1) continue;
    seen.add(href);
    entries.push({ url: href, version });
    if (entries.length === SYNDICATION_MAX) break;
  }
  return entries.length ? entries : null;
}

export async function listSyndication(db: D1Database, itemId: string): Promise<SyndicationEntry[]> {
  const rows = await db.prepare('SELECT url, version FROM item_syndication WHERE item_id = ? ORDER BY position, url')
    .bind(itemId).all<SyndicationEntry>();
  return rows.results.map(({ url, version }) => ({ url, version }));
}

export type SyndicationRefusal = { refused: string };

/**
 * Why `entries` cannot be stored on `item`, or null. Checked before the
 * write; the write itself is guarded on the revision.
 */
export function refuseSyndication(item: Pick<ItemRow, 'status' | 'version'>, entries: readonly SyndicationEntry[]): SyndicationRefusal | null {
  if (item.status === 'draft' || item.version < 1) return { refused: 'publish the item first: a copy is made from a published version' };
  if (item.status === 'withdrawn') return { refused: 'a withdrawn item carries no syndication (spec 0.4 §16.14 rule 4)' };
  for (const entry of entries) {
    if (!httpsUrl(entry.url)) return { refused: `not an absolute https: URL: ${entry.url}` };
    if (entry.version > item.version) return { refused: `version ${entry.version} is not published yet (latest is ${item.version})` };
  }
  return null;
}

/** First occurrence of a URL keeps its place. */
export function uniqueByUrl(entries: readonly SyndicationEntry[]): SyndicationEntry[] {
  const seen = new Set<string>();
  return entries.filter(({ url }) => (seen.has(url) ? false : (seen.add(url), true)));
}

/**
 * Replace the item's list in one transaction, guarded on the item's revision,
 * which it bumps. Returns the stored list and the new revision.
 */
export async function replaceSyndication(
  db: D1Database,
  item: Pick<ItemRow, 'id' | 'revision'>,
  entries: readonly SyndicationEntry[],
  expectedRevision: number,
): Promise<{ entries: SyndicationEntry[]; revision: number }> {
  assertItemRevision(item, expectedRevision);
  const guard = 'EXISTS (SELECT 1 FROM items WHERE id = ? AND revision = ?)';
  const list = uniqueByUrl(entries);
  const statements = [
    db.prepare(`DELETE FROM item_syndication WHERE item_id = ? AND ${guard}`).bind(item.id, item.id, expectedRevision),
    ...list.map(({ url, version }, position) => db.prepare(`INSERT INTO item_syndication(item_id, url, version, position) SELECT ?, ?, ?, ? WHERE ${guard}`)
      .bind(item.id, url, version, position, item.id, expectedRevision)),
    db.prepare('UPDATE items SET revision = revision + 1 WHERE id = ? AND revision = ?').bind(item.id, expectedRevision),
  ];
  const results = await db.batch([...statements, db.prepare('SELECT url, version FROM item_syndication WHERE item_id = ? ORDER BY position, url').bind(item.id)]);
  if (!results[statements.length - 1].meta.changes) throw new ItemRevisionConflict(item.id, expectedRevision);
  const stored = (results[statements.length].results as SyndicationEntry[]).map(({ url, version }) => ({ url, version }));
  return { entries: stored, revision: expectedRevision + 1 };
}
