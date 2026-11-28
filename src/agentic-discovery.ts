/*
 * The built-in digest's discovery (blygger-spec docs/agentic-digest-plan.md
 * §8 law 4, bounded by Venkat, session 92): once a day, which blygs the reader
 * has met but does not follow have posted lately. It reads the blygger.com
 * directory and at most 13 feeds, and writes what it found to met_origins
 * (migration 0066), so every edition and every `remote` entry is decided
 * without the network. Owned by test/agentic-outside.oracle.test.ts.
 */
import type { FetchLike } from "./importer/http.ts";
import { parseFeed } from "./importer/feed.ts";
import { normalizeOrigin } from "./stub.ts";

export const DIRECTORY_URL = "https://blygger.com/blygs.json";
/** Discovery spends at most this many fetches: the directory, then feeds. */
export const DISCOVERY_FETCHES = 14;
/** An origin is active when it holds an item created this recently. */
export const ACTIVE_MS = 14 * 24 * 3600 * 1000;
export const NEW_BLYGS_SHOWN = 5;

/** Within the active span ending at `now`: after its start, not after `now`. */
export const isFresh = (at: number, now: number) => at > now - ACTIVE_MS && at <= now;

/** A directory listing: its feed, when it names one, and its last post's time (0 when it gives none, which is never fresh). */
type Listing = { feed: string | null; lastPost: number; title: string | null };

/** The directory's blygs by origin; none when it cannot be read. */
async function readDirectory(fetchFn: FetchLike): Promise<Map<string, Listing>> {
  const out = new Map<string, Listing>();
  try {
    const res = await fetchFn(DIRECTORY_URL);
    if (!res.ok) return out;
    const body = JSON.parse(await res.text()) as { blygs?: { origin?: unknown; feed?: unknown; title?: unknown; activity?: { lastPost?: unknown } }[] };
    for (const b of Array.isArray(body.blygs) ? body.blygs : []) {
      const origin = normalizeOrigin(b.origin);
      if (!origin || out.has(origin)) continue;
      const lastPost = typeof b.activity?.lastPost === "string" ? Date.parse(b.activity.lastPost) : NaN;
      out.set(origin, { feed: typeof b.feed === "string" ? b.feed : null, lastPost: lastPost || 0, title: typeof b.title === "string" ? b.title : null });
    }
  } catch {
    // An unreadable directory lists nothing; the reading's origins are still read.
  }
  return out;
}

/** How often the reading meets each origin: held items' stubs, forks, quotes and links, and verified mentions' sources. */
async function meetings(db: D1Database): Promise<Map<string, number>> {
  const rows = await db.prepare(`
    SELECT json_extract(stub_of_json, '$.origin') AS o FROM imported_items WHERE state = 'current' AND stub_of_json IS NOT NULL
    UNION ALL SELECT json_extract(forked_from_json, '$.origin') FROM imported_items WHERE state = 'current' AND forked_from_json IS NOT NULL
    UNION ALL SELECT json_extract(t.value, '$.origin') FROM imported_items ii, json_each(ii.transclusions_json) t WHERE ii.state = 'current' AND ii.transclusions_json IS NOT NULL
    UNION ALL SELECT json_extract(l.value, '$.origin') FROM imported_items ii, json_each(ii.links_json) l WHERE ii.state = 'current' AND ii.links_json IS NOT NULL
    UNION ALL SELECT source_origin FROM mentions_in WHERE status = 'verified'`).all<{ o: unknown }>();
  const met = new Map<string, number>();
  for (const { o } of rows.results) {
    const origin = normalizeOrigin(o);
    if (origin) met.set(origin, (met.get(origin) ?? 0) + 1);
  }
  return met;
}

/** Every origin the reader follows, as a subscription names it. */
export async function followedOrigins(db: D1Database): Promise<Set<string>> {
  const rows = await db.prepare("SELECT origin FROM subscriptions").all<{ origin: string }>();
  return new Set(rows.results.flatMap((r) => normalizeOrigin(r.origin) ?? []));
}

type Sample = { id: string; created: number };

/**
 * A feed's newest item, not withdrawn, created in the active span before
 * `now`; of items created at the same moment, the smaller id. Nothing when
 * there is none, or the feed does not answer or parse.
 */
async function newestItem(fetchFn: FetchLike, url: string, now: number): Promise<Sample | undefined> {
  let text: string | null;
  try {
    const res = await fetchFn(url);
    text = res.ok ? await res.text() : null;
  } catch {
    return;
  }
  const feed = text === null ? null : parseFeed(text);
  if (!feed?.ok) return;
  const active = feed.entries.flatMap((e) => (e.blyg && e.blyg.kind !== "withdrawn" ? [{ id: e.blyg.id, created: Date.parse(e.blyg.created ?? "") }] : []))
    .filter((e) => isFresh(e.created, now));
  if (!active.length) return;
  const created = Math.max(...active.map((e) => e.created));
  return { id: active.filter((e) => e.created === created).map((e) => e.id).sort()[0]!, created };
}

/**
 * Discover the met blygs that are newly active and store them in met_origins,
 * replacing the last discovery. The queue: met origins neither followed nor
 * `ownOrigin`, less listed ones whose lastPost is missing or not under 14
 * days old, most met first, then newest lastPost, then origin; each costs one
 * feed fetch, until the budget is spent or enough are found.
 */
export async function discoverBlygs(db: D1Database, fetchFn: FetchLike, now: number, ownOrigin: string): Promise<void> {
  const [directory, met, followed] = await Promise.all([readDirectory(fetchFn), meetings(db), followedOrigins(db)]);
  const own = normalizeOrigin(ownOrigin);
  // In origin order, so the stable sort below leaves ties there.
  const origins = [...new Set([...met.keys(), ...directory.keys()])].filter((o) => o !== own && !followed.has(o)).sort();
  // Unlisted origins rank after every listed one, whose last post is fresh.
  const lastPost = (o: string) => directory.get(o)?.lastPost ?? 0;
  const queue = origins
    .filter((o) => !directory.has(o) || isFresh(lastPost(o), now))
    .sort((a, b) => (met.get(b) ?? 0) - (met.get(a) ?? 0) || lastPost(b) - lastPost(a));
  const samples = new Map<string, Sample>();
  let reads = 0;
  for (const origin of queue) {
    if (reads >= DISCOVERY_FETCHES - 1 || samples.size >= NEW_BLYGS_SHOWN) break;
    reads++;
    const sample = await newestItem(fetchFn, directory.get(origin)?.feed ?? `${origin}feed.xml`, now);
    if (sample) samples.set(origin, sample);
  }
  const at = new Date(now).toISOString();
  await db.batch([
    db.prepare("DELETE FROM met_origins"),
    ...origins.map((o) => {
      const sample = samples.get(o);
      return db.prepare("INSERT INTO met_origins (origin, met, listed, title, sample_id, sample_created, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(o, met.get(o) ?? 0, directory.has(o) ? 1 : 0, directory.get(o)?.title ?? null, sample?.id ?? null, sample ? new Date(sample.created).toISOString() : null, at);
    }),
  ]);
}
