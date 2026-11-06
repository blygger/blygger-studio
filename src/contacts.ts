// The address book and the `@handle` grammar (tn-6 sections 5.1-5.3, #67, #91).
// Studio-private: a handle never leaves the studio. At publish, on every write
// path, a handle that names a contact becomes a markdown link in `content_md`
// and an h-card in `content_html`. Nothing else reaches the wire: no member, no
// relation, nothing sent. A word that names no contact stays literal prose.
import { codeRanges, inRanges } from "./code-ranges.ts";
import type { FetchLike } from "./importer/http.ts";
import { decodeEntities, renderMarkdown } from "./markdown.ts";
import { addLinkToken, type InternalLinkDocument } from "./transclusion.ts";
import { escapeHtml, newId, nowIso } from "./util.ts";

export type IdProvenance = "self" | "bound" | "entered";
export interface ContactId { id: string; provenance: IdProvenance }
export interface ContactRow { id: string; handle: string; name: string; url: string; ids_json: string; created: string; updated: string }

export const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;

export const contactResource = (row: ContactRow) => ({
  id: row.id,
  handle: row.handle,
  name: row.name,
  url: row.url,
  ids: JSON.parse(row.ids_json) as ContactId[],
  created: row.created,
  updated: row.updated,
});

export async function listContacts(db: D1Database): Promise<ContactRow[]> {
  return (await db.prepare("SELECT * FROM contacts ORDER BY handle").all<ContactRow>()).results;
}

export async function getContact(db: D1Database, id: string): Promise<ContactRow | null> {
  return db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
}

export async function handleTaken(db: D1Database, handle: string, exceptId = ""): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM contacts WHERE handle = ? AND id <> ?").bind(handle, exceptId).first());
}

/**
 * The API can only enter an identifier: `self` and `bound` are set by the
 * resolver, never by a caller (tn-6 section 5.6). One the book already holds
 * keeps the provenance it earned.
 */
export function enteredIds(ids: string[], held: ContactId[] = []): ContactId[] {
  return [...new Set(ids)].map((id) => held.find((h) => h.id === id) ?? { id, provenance: "entered" as const });
}

export async function createContact(db: D1Database, input: { handle: string; name: string; url: string; ids?: string[] }): Promise<ContactRow> {
  const now = nowIso();
  const row: ContactRow = { id: newId(), handle: input.handle, name: input.name, url: input.url, ids_json: JSON.stringify(enteredIds(input.ids ?? [])), created: now, updated: now };
  await db.prepare("INSERT INTO contacts (id, handle, name, url, ids_json, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.handle, row.name, row.url, row.ids_json, row.created, row.updated).run();
  return row;
}

export async function updateContact(db: D1Database, row: ContactRow, input: { handle?: string; name?: string; url?: string; ids?: string[] }): Promise<ContactRow> {
  const next: ContactRow = {
    ...row,
    handle: input.handle ?? row.handle,
    name: input.name ?? row.name,
    url: input.url ?? row.url,
    ids_json: input.ids ? JSON.stringify(enteredIds(input.ids, JSON.parse(row.ids_json))) : row.ids_json,
    updated: nowIso(),
  };
  await db.prepare("UPDATE contacts SET handle = ?, name = ?, url = ?, ids_json = ?, updated = ? WHERE id = ?")
    .bind(next.handle, next.name, next.url, next.ids_json, next.updated, row.id).run();
  return next;
}

export async function deleteContact(db: D1Database, id: string): Promise<boolean> {
  return ((await db.prepare("DELETE FROM contacts WHERE id = ?").bind(id).run()).meta.changes ?? 0) > 0;
}

const REL_ME_TAG = /<(?:a|link)\b[^>]*>/gi;
const attribute = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);

/**
 * What a contact's own page says is also them: its `rel="me"` links, in the
 * three wire schemes (tn-6 sections 4 and 5.1). A claim the person makes at
 * their own URL is `self`, which is what lets it go on the wire. Their reciprocal
 * proof is a reader's concern, not this list's.
 */
export function selfIdsInPage(html: string, pageUrl: string): string[] {
  const found = new Set<string>();
  for (const [tag] of html.matchAll(REL_ME_TAG)) {
    const rel = attribute(tag, "rel");
    const href = attribute(tag, "href");
    if (!href || !rel?.toLowerCase().split(/\s+/).includes("me")) continue;
    try {
      const url = new URL(decodeEntities(href), pageUrl);
      if (["https:", "acct:", "did:"].includes(url.protocol) && url.href !== pageUrl) found.add(url.href);
    } catch {
      // Not a URL: nothing to carry.
    }
  }
  return [...found].slice(0, 50);
}

/**
 * The book's identifiers after reading the page: found ones are `self`; a `self`
 * the page no longer lists falls back to `entered`, which takes it off the wire;
 * `bound` and anything typed by hand stay.
 */
export function mergeSelfIds(held: ContactId[], found: string[]): ContactId[] {
  const kept = held.map((id): ContactId => (found.includes(id.id) ? { id: id.id, provenance: id.provenance === "bound" ? "bound" : "self" } : id.provenance === "self" ? { id: id.id, provenance: "entered" } : id));
  return [...kept, ...found.filter((id) => !held.some((h) => h.id === id)).map((id): ContactId => ({ id, provenance: "self" }))];
}

export async function resolveContact(db: D1Database, fetchFn: FetchLike, row: ContactRow): Promise<ContactRow> {
  const res = await fetchFn(row.url, { headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`the page answered ${res.status}`);
  const ids_json = JSON.stringify(mergeSelfIds(JSON.parse(row.ids_json), selfIdsInPage(await res.text(), res.url || row.url)));
  const updated = nowIso();
  await db.prepare("UPDATE contacts SET ids_json = ?, updated = ? WHERE id = ?").bind(ids_json, updated, row.id).run();
  return { ...row, ids_json, updated };
}

// Not after a word or URL character (emails, `/@name` paths); not before `@`,
// `.word` or `-word` (`@a@b.example`, `@a.example`).
const AT_HANDLE = /(?<![\w@./:+-])@([A-Za-z0-9][A-Za-z0-9_-]{0,38})(?![\w@]|[.-]\w)/g;
// What a handle inside is not the author's prose to rewrite: bracket directives
// and links, markdown links and images, autolinks.
const OPAQUE = /!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]*>/g;
// A quoted line is someone else's speech, and an attached partial quote must
// stay a substring of its target (§10.2).
const QUOTED_LINE = /^[ \t]{0,3}>.*$/gm;

function handleSpots(md: string): { at: number; length: number; handle: string }[] {
  if (!md.includes("@")) return [];
  const skip = codeRanges(md);
  for (const re of [OPAQUE, QUOTED_LINE]) {
    for (const m of md.matchAll(re)) skip.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const spots = [];
  for (const m of md.matchAll(AT_HANDLE)) {
    if (!inRanges(skip, m.index ?? 0)) spots.push({ at: m.index ?? 0, length: m[0].length, handle: m[1] });
  }
  return spots;
}

/** The link `content_md` carries for a contact. */
function mentionLink(row: Pick<ContactRow, "name" | "url">): string {
  const name = row.name.replace(/[\\[\]*_`<]/g, "\\$&");
  return `[@${name}](${row.url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20")})`;
}

/** The markup `content_html` carries (tn-6 section 5.3). `entered` identifiers stay in the book. */
function mentionCard(row: Pick<ContactRow, "name" | "url" | "ids_json">): string {
  const href = /href="([^"]*)"/.exec(renderMarkdown(mentionLink(row)))?.[1] ?? escapeHtml(row.url);
  const data = (JSON.parse(row.ids_json) as ContactId[])
    .filter((id) => id.provenance !== "entered")
    .map((id) => `<data class="u-url" value="${escapeHtml(id.id)}"></data>`).join("");
  return `<span class="h-card"><a class="u-url" href="${href}">@<span class="p-name">${escapeHtml(row.name)}</span></a>${data}</span>`;
}

export interface ConsumedHandles {
  /** The markdown with each known handle replaced by its link. */
  text: string;
  /** Link -> the h-card that replaces it after rendering. */
  cards: Map<string, string>;
  /** Handles that name no contact, once each. Empty while the book is empty. */
  unresolved: string[];
}

export async function consumeHandles(db: D1Database, md: string): Promise<ConsumedHandles> {
  const spots = handleSpots(md);
  if (!spots.length) return { text: md, cards: new Map(), unresolved: [] };
  const handles = [...new Set(spots.map((s) => s.handle))];
  const { results } = await db.prepare("SELECT * FROM contacts WHERE handle IN (SELECT value FROM json_each(?))").bind(JSON.stringify(handles)).all<ContactRow>();
  const known = new Map(results.map((row) => [row.handle.toLowerCase(), row]));
  const cards = new Map<string, string>();
  let text = "", last = 0;
  for (const spot of spots) {
    const row = known.get(spot.handle.toLowerCase());
    if (!row) continue;
    const link = mentionLink(row);
    cards.set(link, mentionCard(row));
    text += md.slice(last, spot.at) + link;
    last = spot.at + spot.length;
  }
  text += md.slice(last);
  const unresolved = handles.filter((h) => !known.has(h.toLowerCase()));
  const empty = !results.length && !(await db.prepare("SELECT 1 FROM contacts LIMIT 1").first());
  return { text, cards, unresolved: empty ? [] : unresolved };
}

/** Swap each mention's link for a token that `applyInternalLinks` turns into its h-card. */
export function withMentionCards(doc: InternalLinkDocument, cards: Map<string, string>): InternalLinkDocument {
  for (const [link, card] of cards) addLinkToken(doc, link, card);
  return doc;
}
