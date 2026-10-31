// IDs, hashing, timestamps — v0.1-plan §2.1, §2.2.

import { DEFAULT_MOUNT } from "./types.ts";

/**
 * Normalize the deployment mount path (Env.MOUNT): returns "" for a root
 * mount, otherwise "/seg" or "/seg/seg" — leading slash, no trailing slash.
 * Unset (undefined) falls back to DEFAULT_MOUNT; an explicit "" or "/" is a
 * deliberate root mount, not an omission.
 */
export function normalizeMount(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_MOUNT;
  let m = raw.trim();
  while (m.endsWith("/")) m = m.slice(0, -1);
  if (m === "") return "";
  return m.startsWith("/") ? m : "/" + m;
}

/** Canonical paths for one deployment. Root nodes retain /api. */
export function deploymentPaths(rawMount: string | undefined) {
  const publicBase = normalizeMount(rawMount), studio = publicBase + '/studio';
  return { publicBase, studio, api: publicBase + '/api', issuer: studio + '/auth', mcp: studio + '/mcp', media: publicBase + '/media' };
}

/** Shared mounted Studio path for routing and links. */
export function studioPath(mount: string): string { return deploymentPaths(mount).studio; }

/** Crockford base32, lowercase, no i/l/o/u. */
import { ID_ALPHABET } from "./identity.ts";
export { ID_ALPHABET } from "./identity.ts";

/**
 * 128 random bits encoded as 26 chars of lowercase Crockford base32
 * (big-endian, 2 leading zero bits of padding since 26*5 = 130).
 */
export function newId(): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(16)), 26);
}

/** Short random key for media objects: 8 chars (40 bits). */
export function newMediaId(): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(5)), 8);
}

function encodeBase32(bytes: Uint8Array, chars: number): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < chars; i++) {
    out = ID_ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/** `"sha256:" + hex(SHA-256(content_md as UTF-8))` */
export async function contentHash(contentMd: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contentMd));
  return "sha256:" + hex(new Uint8Array(digest));
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** ISO 8601 UTC, second precision, Z suffix. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** RFC 822/1123 date for RSS elements. */
export function rfc822(iso: string): string {
  return new Date(iso).toUTCString();
}

/**
 * Normalize a foreign date string to our ISO-8601 UTC form, or undefined if
 * it is unparseable. Syndicated feeds carry dates in whatever their format
 * mandates — RSS 2.0 `<pubDate>` is RFC-822 ("Wed, 01 Jul 2026 12:00:00
 * GMT"), Atom `<published>` is RFC-3339, and offsets are common in both.
 * Those strings are only *numerically* comparable via Date.parse; compared
 * as text, RFC-822 sorts by day-of-week name and any two formats sort into
 * separate clusters. Every foreign date is therefore normalized here, at the
 * boundary where it enters, so nothing downstream has to know it was foreign.
 */
export function toIsoUtc(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FOLLOWABLE = ['http:', 'https:', 'mailto:'];
/** An absolute link a reader can follow without running anything. */
export function isFollowableUrl(value: string): boolean {
  return URL.canParse(value) && FOLLOWABLE.includes(new URL(value).protocol);
}
/** Untrusted link data needs URL validation as well as HTML attribute escaping. */
export function escapeHref(value: string): string {
  try {
    if (!FOLLOWABLE.includes(new URL(value, 'https://link.invalid/').protocol)) return '#';
    return escapeHtml(value);
  } catch { return '#'; }
}

// ── Text that must survive the trip to other people's readers (studio#15) ──

/**
 * Characters XML 1.0 forbids: C0 controls other than tab, LF and CR,
 * U+FFFE/U+FFFF, and unpaired surrogates. One of these in `feed.xml` is a
 * well-formedness error that takes a subscriber's *whole* feed down in libxml2
 * and most reader stacks — while `fast-xml-parser`, ours, tolerates it, so our
 * own tests would never notice.
 */
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const xmlSafe = (s: string) => s.replace(XML_INVALID, "");

/**
 * Authored text as publish keeps it: XML-safe, and without this client's
 * internal sentinels (U+E000–U+E005, tk.ts and transclusion.ts), which are
 * "never produced by normal authoring" only until someone pastes one.
 */
export const authoredText = (s: string) => xmlSafe(s).replace(/[\uE000-\uE005]/g, "");

export function escapeXml(s: string): string {
  return xmlSafe(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wrap HTML for a CDATA section, splitting any `]]>` occurrences. */
export function cdata(s: string): string {
  return "<![CDATA[" + xmlSafe(s).replaceAll("]]>", "]]]]><![CDATA[>") + "]]>";
}

/**
 * Rewrite relative src/href attribute URLs in rendered HTML against the
 * blyg's base origin URL — feed descriptions must be self-contained (§2.6).
 */
export function absolutizeHtml(html: string, base: string): string {
  const origin = new URL(base).origin;
  return html.replace(/(src|href)="([^"]*)"/g, (m, attr, url) => {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith("//") || url.startsWith("#")) return m;
    if (url.startsWith("/")) return `${attr}="${origin}${url}"`;
    return `${attr}="${base}${url}"`;
  });
}

/** Relative time for page bylines: "2h ago", "3d ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/**
 * A date as the author's readers should see it (session 28).
 *
 * `timeZone` is **required**, not defaulted, and that is the point: every call
 * site has to say which zone it means, so a new one cannot quietly inherit UTC
 * the way all 28 of them did before. An empty string means UTC explicitly.
 *
 * Rendering only. Nothing on the wire is formatted through here — feed dates
 * are RFC-822 and item documents are ISO-8601 UTC, both produced elsewhere and
 * both unaffected by this setting.
 *
 * An invalid zone falls back to UTC rather than throwing: the setting is
 * validated when it is saved, but a database row is not a type, and a blyg
 * whose every page 500s because of a bad string in settings would be a worse
 * failure than a date in the wrong zone.
 */
export { formatDateIn } from "./dates.ts";

/** Is this a timezone the runtime actually knows? Used to validate the setting on save. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return true; // empty means UTC
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Is this media row's key used as a path in the HTML, relative or absolute? Keys are random, so a full-key match cannot hit another file. */
export function placedIn(html: string, key: string): boolean {
  return html.includes(`/${key}`) || html.includes(`"${key}`);
}

/**
 * Attachments to append after the content (studio#24). An image the studio
 * placed in the text (`inline`) is shown only where its line is, so deleting
 * the line removes it; appending it as well showed it twice. Only uploads that
 * never touched the text — another tool's POST /api/media — are appended, and
 * only when the text does not already show them.
 */
export function unplacedMedia<T extends { r2_key: string; inline?: number }>(media: T[], html: string): T[] {
  return media.filter((m) => m.inline !== 1 && !placedIn(html, m.r2_key));
}

/** The item's media as published: what the text shows plus what is appended. Inline images whose line was deleted are gone. */
export function visibleMedia<T extends { r2_key: string; inline?: number }>(media: T[], html: string): T[] {
  return media.filter((m) => m.inline !== 1 || placedIn(html, m.r2_key));
}
