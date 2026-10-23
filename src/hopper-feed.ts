// Per-hopper RSS 2.0 feed, `{mount}/h/{slug}/feed.xml`: curation, not reposting.
//
// PROPOSED, pending a Fable ruling (fable-round-queue item 14); served only
// while the `hopper_feeds` setting is on. Shapes live in hopper-feed-shape.ts.
//
// Every entry, the owner's own items included, takes one shape: an excerpt,
// who wrote it, a "via" line, and a link to where the item lives. There is no
// blyg: namespace anywhere in this document. An entry carrying blyg:id would
// make this a second blyg feed for the same origin, and a reader's rollup
// would collide; the blyg's own feed.xml is the only one. Nothing here is
// emitted on that feed either (decision #12).

import {
  HOPPER_EXCERPT_CHARS,
  hopperFeedPath,
  hopperFeedTitle,
  hopperGuid,
  hopperPagePath,
} from "./hopper-feed-shape.ts";
import { hopperDescription, loadHopperMembers, type HopperMember } from "./importer/pages.ts";
import { blygItemUrl, sourceTitleAndUrl } from "./importer/util.ts";
import { excerptFromHtml } from "./markdown.ts";
import { publishedVersion } from "./model.ts";
import { authorOwnHtml } from "./pages.ts";
import { clampText, leadingHeading } from "./preview.ts";
import { ownPagePath } from "./protocol.ts";
import { itemUrl, parseSurface } from "./surface.ts";
import type { HopperRow, Settings } from "./types.ts";
import { cdata, escapeHtml, escapeXml, rfc822 } from "./util.ts";

interface Entry {
  title: string;
  link: string;
  excerpt: string;
  creator: string | null;
  /** RSS 2.0 `<source>`: every member not the publisher's own (§13.5a rule 4). */
  source: { url: string; title: string } | null;
  guid: string;
  added_at: string;
}

/**
 * Headline and excerpt from an item's HTML, in its author's own words: baked
 * quotes of other people are left out (authorOwnHtml), a leading heading is
 * the title, and the excerpt is taken from what follows it.
 */
function titleAndExcerpt(html: string): { title: string; excerpt: string } {
  const own = authorOwnHtml(html);
  const { title, rest } = leadingHeading(own);
  return {
    title: title ? clampText(title, 70) : excerptFromHtml(own, 60),
    excerpt: excerptFromHtml(title ? rest : own, HOPPER_EXCERPT_CHARS),
  };
}

function authorName(json: string | null): string | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { name?: unknown } | null;
    return typeof parsed?.name === "string" && parsed.name.trim() ? parsed.name.trim() : null;
  } catch {
    return null;
  }
}

async function entryFor(db: D1Database, settings: Settings, slug: string, member: HopperMember, origin: string): Promise<Entry | null> {
  if ("own" in member) {
    const item = member.own;
    const latest = await publishedVersion(db, item);
    const { title, excerpt } = titleAndExcerpt(latest?.content_html ?? "");
    return {
      title: title || (item.kind === "thread" ? "A thread" : "A fragment"),
      // Our own item's declared `page`, exactly what its item JSON says.
      link: `${origin}${ownPagePath(item.kind === "thread", item.id)}`,
      excerpt,
      creator: settings.author_name || null,
      source: null,
      guid: hopperGuid(slug, origin, item.id),
      added_at: member.added_at,
    };
  }
  const { row, sub } = member;
  // §13.5a rule 3 / §13.4: a member withdrawn with no retained pin has rolled
  // to null and leaves the feed (the page keeps a placeholder for it). One
  // retained through a pin is still held, so it stays, as on the page.
  if (row.state === "tombstone" && row.pinned_version_retained === null) return null;
  const derived = titleAndExcerpt(row.content_html);
  let link: string;
  let title = derived.title;
  if (row.l0) {
    // A legacy feed's item has no page and no item document; its link is the
    // one its own feed gave, rendered as the leading anchor at import.
    const l0 = sourceTitleAndUrl(row, sub.origin);
    link = l0.url;
    title = l0.title || title;
  } else {
    // The snapshot's declared `page`, else the origin's item document: never
    // an f/ or t/ permalink guessed from this client's own convention (#85),
    // the same rule outbound mentions follow (mentions/send.ts remoteTarget),
    // without its network fallback: a feed render makes no fetch.
    link = row.page
      ? blygItemUrl(sub.origin, row.kind, row.remote_id, row.page)
      : itemUrl(sub.origin, parseSurface(sub.surface), row.remote_id);
  }
  const sourceTitle = sub.title || sub.origin;
  return {
    title: title || "Untitled",
    link,
    excerpt: derived.excerpt,
    creator: authorName(row.author_json),
    source: { url: sub.feed_url || sub.origin, title: sourceTitle },
    guid: hopperGuid(slug, sub.origin, row.remote_id),
    added_at: member.added_at,
  };
}

/** The feed document for one public, slugged hopper. The caller decides whether it may be served. */
export async function buildHopperFeedXml(db: D1Database, settings: Settings, hopper: HopperRow & { slug: string }, origin: string): Promise<string> {
  const slug = hopper.slug;
  const pageUrl = `${origin}${hopperPagePath(slug)}`;
  // The page's own members and description: one loader for both (importer/pages.ts).
  const members = await loadHopperMembers(db, hopper.id);
  const entries: Entry[] = [];
  // §13.5a rule 3: every current member, no window. The feed is the list,
  // and a subscriber drops what leaves it.
  for (const member of members) {
    const entry = await entryFor(db, settings, slug, member, origin);
    if (entry) entries.push(entry);
  }
  // §13.5a rule 4: an excerpt with a link to where the item lives, then
  // "via {hopper name} on {site title}". Hopper memberships hold no curator
  // note today; one would lead the body when they do.
  const via = `via <a href="${escapeHtml(pageUrl)}">${escapeHtml(hopper.name)}</a> on <a href="${escapeHtml(origin)}">${escapeHtml(settings.site_title)}</a>`;
  const body = (e: Entry) =>
    `${e.excerpt ? `<p>${escapeHtml(e.excerpt)}</p>\n` : ""}<p><a href="${escapeHtml(e.link)}">${escapeHtml(e.source?.title ?? settings.site_title)} ↗</a> · ${via}</p>`;
  const items = entries.map((e) => `    <item>
      <guid isPermaLink="false">${escapeXml(e.guid)}</guid>
      <link>${escapeXml(e.link)}</link>
      <title>${escapeXml(e.title)}</title>
      <description>${cdata(body(e))}</description>
      <pubDate>${rfc822(e.added_at)}</pubDate>
${e.creator ? `      <dc:creator>${escapeXml(e.creator)}</dc:creator>\n` : ""}${e.source ? `      <source url="${escapeXml(e.source.url)}">${escapeXml(e.source.title)}</source>\n` : ""}    </item>`);
  const built = entries[0]?.added_at ?? hopper.created;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeXml(hopperFeedTitle(hopper.name, settings.site_title))}</title>
    <link>${escapeXml(pageUrl)}</link>
    <description>${escapeXml(hopperDescription(settings, hopper, members))}</description>
    <atom:link href="${escapeXml(`${origin}${hopperFeedPath(slug)}`)}" rel="self" type="application/rss+xml" />
    <lastBuildDate>${rfc822(built)}</lastBuildDate>
${items.join("\n")}
  </channel>
</rss>
`;
}
