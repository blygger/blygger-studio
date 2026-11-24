// The byline (`author`, §5.5 / #11) as the studio stores and serves it (multi-author-plan §4, M1).
import type { Settings } from "./types.ts";

/** The byline a publish freezes into its version (multi-author-plan §4): the blyg's author today. */
export function bylineFor(settings: Settings, origin: string) {
  return { name: settings.author_name, url: settings.author_url || origin };
}
/** A version's stored byline; one published before bylines were stored is served from settings, as it always was. */
export function servedAuthor(stored: string | null | undefined, settings: Settings, origin: string): { name: string; url: string } {
  if (stored) {
    try { return JSON.parse(stored) as { name: string; url: string }; } catch { /* an unreadable row falls back */ }
  }
  return bylineFor(settings, origin);
}
