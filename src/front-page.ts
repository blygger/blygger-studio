import type { ItemRow } from "./types.ts";

/**
 * A static front page (session 47, Venkat; ROADMAP row 65). The owner may
 * choose one published thread to show at the mount root, as WordPress does
 * with a static front page. The latest-items page then lives at
 * `{mount}/{posts_path}/`, and it is served there whether or not a front page
 * is set, so a link to it survives the owner switching back.
 *
 * Presentation only: the thread keeps its permalink, item document, feed entry
 * and index entry. Nothing here reaches the wire.
 */
export const DEFAULT_POSTS_PATH = "posts";

/** The links section's lists (threads, external links) each hold at most this many. */
export const MAX_LINKS = 30;

/**
 * Segments the public surface or the studio already uses under the mount, plus
 * `feed`, `rss` and `atom`: feed readers probe those expecting XML, and on
 * WordPress `/feed/` is the RSS feed. Dotted names (`feed.xml`, `blyg.json`)
 * are refused by the shape rule.
 */
export const RESERVED_PATHS: readonly string[] = [
  "api", "archive", "atom", "auth", "f", "feed", "h", "items", "media", "mcp", "rss", "studio", "t", "webmention",
];

export const PATH_SHAPE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Why `path` cannot be the posts page's address, or null when it can. */
export function postsPathError(path: string): string | null {
  if (!PATH_SHAPE.test(path)) return "postsPath must be 1–40 lowercase letters, digits or hyphens, starting with a letter or digit";
  if (RESERVED_PATHS.includes(path)) return `posts_path cannot be "${path}": the blyg already uses it`;
  return null;
}

/** True when a thread can be shown as the front page: published, live, a thread. */
export function canBeFrontPage(item: ItemRow | null): item is ItemRow {
  return !!item && item.status === "public" && item.kind === "thread";
}

/**
 * The thread the root shows, or null for the latest items. A front page that
 * has since been withdrawn or deleted falls back quietly; the studio warns.
 */
export async function resolveFrontPage(db: D1Database, settings: { front_page: string }): Promise<ItemRow | null> {
  if (!settings.front_page) return null;
  // A direct read rather than model.getItem: model.ts imports this module's default.
  const item = await db.prepare("SELECT * FROM items WHERE id = ?").bind(settings.front_page).first<ItemRow>();
  return canBeFrontPage(item) ? item : null;
}
