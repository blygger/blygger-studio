/*
 * OPML subscription import (studio#63): the pure half. Parsing runs in the
 * browser (DOMParser) and the import walks the list through the ordinary
 * createSubscription route, one request at a time, so there is no server route
 * of its own. Folders are flattened (no hopper mapping) and nothing reaches the
 * public blogroll unless the owner asks.
 *
 * Nothing here touches DOM globals at import time, so the UI-state suite can
 * test it under node with its own XML parser.
 */

/** The slice of a DOM Element the parser reads. A real Element satisfies it. */
export interface XmlElement {
  readonly localName: string;
  getAttribute(name: string): string | null;
  readonly children: ArrayLike<XmlElement>;
}
/** The slice of a DOM Document the parser reads. */
export interface XmlDocument {
  readonly documentElement: XmlElement | null;
  getElementsByTagName(name: string): ArrayLike<unknown>;
}
export type ParseXml = (text: string) => XmlDocument;

export interface OpmlFeed {
  title: string;
  xmlUrl: string;
  htmlUrl?: string;
}
export interface OpmlResult {
  feeds: OpmlFeed[];
  /** Outlines carrying an xmlUrl that were not taken: a non-feed type, a URL that is not http(s), or a repeat. */
  skipped: number;
}
export class OpmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpmlError';
  }
}

const browserParse: ParseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');

/** Some exporters write a bare `&` inside a URL, and HTML entities XML does not define. */
export function repairEntities(text: string): string {
  return text.replace(/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/g, '&amp;');
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', oacute: 'ó', iacute: 'í', uacute: 'ú', ntilde: 'ñ',
  ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß', ccedil: 'ç',
};
/**
 * Titles are often escaped twice (`&amp;#8217;` in the file, `&#8217;` after
 * XML parsing). Decode that second layer; leave an unknown name as written.
 */
export function decodeTitle(text: string): string {
  return text
    .replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return HTML_ENTITIES[name] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(el: XmlElement, ...names: string[]): string {
  for (const name of names) {
    const value = el.getAttribute(name);
    if (value !== null && value.trim()) return value.trim();
  }
  return '';
}
function httpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
const FEED_TYPES = new Set(['rss', 'atom']);
const failed = (doc: XmlDocument) => doc.getElementsByTagName('parsererror').length > 0 || !doc.documentElement;

/**
 * Read an OPML file into a flat, de-duplicated list of feeds. Outlines with an
 * xmlUrl and `type="rss"` (or no type) are feeds; every outline is recursed
 * into, so a folder's feeds are found whether or not the folder has a URL.
 * Throws OpmlError for a file that is not OPML.
 */
export function parseOpml(text: string, parseXml: ParseXml = browserParse): OpmlResult {
  const source = text.replace(/^﻿/, '');
  if (!source.trim()) throw new OpmlError('The file is empty.');
  let doc = parseXml(source);
  if (failed(doc)) doc = parseXml(repairEntities(source));
  if (failed(doc)) throw new OpmlError('The file is not well-formed XML, so it cannot be read as OPML.');
  const root = doc.documentElement!;
  if (root.localName.toLowerCase() !== 'opml') throw new OpmlError(`This is not an OPML file (its root element is <${root.localName}>).`);
  const body = Array.from(root.children).find((el) => el.localName.toLowerCase() === 'body');
  if (!body) throw new OpmlError('This OPML file has no <body>, so it lists no feeds.');
  const feeds: OpmlFeed[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const walk = (parent: XmlElement, depth: number) => {
    if (depth > 64) return;
    for (const el of Array.from(parent.children)) {
      if (el.localName.toLowerCase() !== 'outline') continue;
      const raw = attr(el, 'xmlUrl', 'xmlurl', 'xmlURL');
      if (raw) {
        const type = attr(el, 'type').toLowerCase();
        const xmlUrl = httpUrl(raw);
        const key = xmlUrl ? feedKey(xmlUrl) : '';
        if ((type && !FEED_TYPES.has(type)) || !xmlUrl || seen.has(key)) skipped++;
        else {
          seen.add(key);
          const htmlUrl = httpUrl(attr(el, 'htmlUrl', 'htmlurl', 'htmlURL')) ?? undefined;
          const title = decodeTitle(attr(el, 'title') || attr(el, 'text')) || new URL(xmlUrl).hostname;
          feeds.push(htmlUrl ? { title, xmlUrl, htmlUrl } : { title, xmlUrl });
        }
      }
      walk(el, depth + 1);
    }
  };
  walk(body, 0);
  return { feeds, skipped };
}

/** One spelling per feed: scheme, `www.`, case of the host and a trailing slash do not tell feeds apart. */
export function feedKey(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.port ? `:${u.port}` : ''}${path}${u.search}`;
  } catch {
    return url.trim();
  }
}
/**
 * The keys of what the owner already follows: each subscription's feed and
 * origin. A hopper subscription's origin is the blyg's (§12.2, proposed), but
 * following one hopper is not following the blyg, so only its feed counts.
 */
export function subscribedKeys(subs: readonly { origin: string; feed_url: string; hopper_feed?: string | null }[]): Set<string> {
  const keys = new Set<string>();
  for (const sub of subs) {
    keys.add(feedKey(sub.feed_url));
    if (!sub.hopper_feed) keys.add(feedKey(sub.origin));
  }
  return keys;
}

/* ---------------- the paced import ---------------- */

/** What one createSubscription (or blogroll PATCH) attempt came to. */
export type Attempt =
  | { kind: 'ok'; id?: string }
  | { kind: 'exists'; message?: string }
  | { kind: 'throttled'; retryAfterMs: number }
  | { kind: 'failed'; reason: string };
export type RowStatus =
  | { state: 'pending' }
  | { state: 'working'; note?: string }
  | { state: 'added'; note?: string }
  | { state: 'exists' }
  | { state: 'failed'; reason: string }
  | { state: 'stopped' };
export interface ImportSummary {
  added: number;
  exists: number;
  failed: number;
  stopped: number;
}
export interface ImportOptions {
  subscribe: (feed: OpmlFeed) => Promise<Attempt>;
  /** Runs after a subscription is created (the optional blogroll PATCH). */
  afterAdd?: (id: string) => Promise<Attempt>;
  /** Rows to settle without a request, as "already subscribed". */
  known?: (feed: OpmlFeed) => boolean;
  onRow: (index: number, status: RowStatus) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between write requests. */
  spacingMs?: number;
  /** Throttled answers tolerated per request before the row fails. */
  maxRetries?: number;
  /** Longest Retry-After honoured; longer ones wait this long and try again. */
  maxWaitMs?: number;
  shouldStop?: () => boolean;
}

/**
 * Seconds or an HTTP date (RFC 9110 §10.2.3); a missing or unreadable value
 * waits a whole budget window.
 */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number {
  const fallback = 60_000;
  if (!header) return fallback;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? fallback : Math.max(0, at - now);
}

export const IMPORT_SPACING_MS = 1000;

/**
 * Subscribe to each feed in turn: one write in flight, a pause between writes,
 * and a 429 waited out for as long as its Retry-After says before the same row
 * is tried again. A 409 is "already subscribed", not a failure.
 */
export async function runImport(feeds: readonly OpmlFeed[], options: ImportOptions): Promise<ImportSummary> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const spacing = options.spacingMs ?? IMPORT_SPACING_MS;
  const maxRetries = options.maxRetries ?? 5;
  const maxWait = options.maxWaitMs ?? 120_000;
  const summary: ImportSummary = { added: 0, exists: 0, failed: 0, stopped: 0 };
  let wrote = false;
  const write = async (index: number, call: () => Promise<Attempt>): Promise<Attempt> => {
    for (let tries = 0; ; tries++) {
      if (wrote) await sleep(spacing);
      wrote = true;
      const result = await call();
      if (result.kind !== 'throttled') return result;
      if (tries >= maxRetries) return { kind: 'failed', reason: 'rate limited: the write budget stayed exhausted' };
      const wait = Math.min(Math.max(result.retryAfterMs, spacing), maxWait);
      options.onRow(index, { state: 'working', note: `rate limited, retrying in ${Math.ceil(wait / 1000)} s` });
      await sleep(wait);
    }
  };
  for (const [index, feed] of feeds.entries()) {
    if (options.shouldStop?.()) {
      options.onRow(index, { state: 'stopped' });
      summary.stopped++;
      continue;
    }
    if (options.known?.(feed)) {
      options.onRow(index, { state: 'exists' });
      summary.exists++;
      continue;
    }
    options.onRow(index, { state: 'working' });
    let result: Attempt;
    try {
      result = await write(index, () => options.subscribe(feed));
    } catch (error) {
      result = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
    if (result.kind === 'exists') {
      options.onRow(index, { state: 'exists' });
      summary.exists++;
    } else if (result.kind === 'failed' || result.kind === 'throttled') {
      options.onRow(index, { state: 'failed', reason: result.kind === 'failed' ? result.reason : 'rate limited' });
      summary.failed++;
    } else {
      let note: string | undefined;
      if (options.afterAdd && result.id) {
        let extra: Attempt;
        try {
          extra = await write(index, () => options.afterAdd!(result.id!));
        } catch (error) {
          extra = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
        if (extra.kind !== 'ok') note = 'not added to the blogroll';
      }
      options.onRow(index, note ? { state: 'added', note } : { state: 'added' });
      summary.added++;
    }
  }
  return summary;
}
