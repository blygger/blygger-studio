// Public hopper page — v0.2-plan.md §4.2 task 11. Curation display only
// (decision #12): local snapshots + source attribution + origin links,
// never a re-emission of anyone else's content on our own feed.

import { hopperFeedPath, hopperFeedTitle, hopperPagePath } from "../hopper-feed-shape.ts";
import { getItem } from "../model.ts";
import { parseSurface, pinUrl } from "../surface.ts";
import { layout, blygPage, ownItemCard } from "../pages.ts";
import type { HopperRow, ImportedItemRow, ItemRow, Settings, SubscriptionRow } from "../types.ts";
import { escapeHtml, escapeHref } from "../util.ts";
import { sanitizeHtml } from "./sanitize.ts";
import { getImportedItem, getSubscription, listHopperItems, OWN_SUBSCRIPTION } from "./store.ts";
import { blygItemUrl } from "./util.ts";

/** A hopper member: something read (an imported item and its source), or one of the owner's own items. */
export type HopperItemView = { row: ImportedItemRow; sub: SubscriptionRow } | { own: ItemRow };

/** A member as the page and the hopper feed both see it, with when it was curated. */
export type HopperMember = HopperItemView & { added_at: string };

/**
 * The members a public hopper shows, newest `added_at` first. One loader for
 * the page and its feed (src/hopper-feed.ts), so the two cannot disagree about
 * what is in a collection: own items once published and not after withdrawal,
 * imported items whose snapshot and subscription still exist.
 * `accept` filters before `limit` counts, so a capped feed still fills.
 */
export async function loadHopperMembers(
  db: D1Database,
  hopperId: string,
  opts: { limit?: number; accept?: (member: HopperMember) => boolean } = {},
): Promise<HopperMember[]> {
  const memberships = await listHopperItems(db, hopperId);
  const subCache = new Map<string, SubscriptionRow | null>();
  const items: HopperMember[] = [];
  for (const m of memberships) {
    if (opts.limit !== undefined && items.length >= opts.limit) break;
    let member: HopperMember | null = null;
    if (m.subscription_id === OWN_SUBSCRIPTION) {
      const own = await getItem(db, m.remote_id);
      if (own?.status === "public") member = { own, added_at: m.added_at };
    } else {
      const row = await getImportedItem(db, m.subscription_id, m.remote_id);
      if (!row) continue;
      let sub = subCache.get(m.subscription_id);
      if (sub === undefined) {
        sub = await getSubscription(db, m.subscription_id);
        subCache.set(m.subscription_id, sub);
      }
      if (sub) member = { row, sub, added_at: m.added_at };
    }
    if (member && (!opts.accept || opts.accept(member))) items.push(member);
  }
  return items;
}

/** The page's one-line description; the hopper feed's channel description uses the same words. */
export function hopperDescription(settings: Settings, hopper: HopperRow, items: HopperItemView[]): string {
  return hopper.description || `A collection on ${settings.site_title}: ${hopperSummary(settings, items)}.`;
}

function hopperSummary(settings: Settings, items: HopperItemView[]): string {
  const read = items.filter((m) => !("own" in m)) as { row: ImportedItemRow; sub: SubscriptionRow }[];
  const own = items.length - read.length;
  const sources = new Set(read.map(({ sub }) => sub.id)).size;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const fromSources = `from ${plural(sources, "source", "sources")}`;
  // Named, not "mine": the page speaks about the blyg, in no one's voice.
  const author = settings.author_name || settings.site_title;
  return !own
    ? `${plural(items.length, "item", "items")} ${fromSources}`
    : read.length
      ? `${plural(items.length, "item", "items")}: ${own} by ${author} and ${read.length} ${fromSources}`
      : `${plural(own, "item", "items")} by ${author}`;
}

export async function publicHopperPage(db: D1Database, settings: Settings, hopper: HopperRow, items: HopperItemView[], mount: string, origin: string): Promise<string> {
  const blocks: string[] = [];
  for (const member of items) {
    if ("own" in member) {
      blocks.push(await ownItemCard(db, member.own, mount, settings.timezone));
      continue;
    }
    const { row, sub } = member;
    const withdrawn = row.state === "tombstone";
    const subLabel = escapeHtml(sub.title || sub.origin);
    if (withdrawn && row.pinned_version_retained === null) {
      blocks.push(`<article class="fragment withdrawn">
<p>Withdrawn by origin — no longer citable.</p>
<p class="provenance">from <a href="${escapeHref(sub.origin)}">${subLabel}</a></p>
</article>`);
      continue;
    }
    const html = await sanitizeHtml(row.content_html);
    // L0 content already embeds its own source link inline; blyg imports get a constructed permalink on the origin.
    const sourceLink = row.l0 ? "" : blygItemUrl(sub.origin, row.kind, row.remote_id, row.page);
    const pinNote = withdrawn
      ? `<p class="provenance">withdrawn by origin — retained via a pinned version: <a href="${escapeHref(pinUrl(sub.origin, parseSurface(sub.surface), row.remote_id, row.pinned_version_retained!))}">v${row.pinned_version_retained}</a></p>`
      : "";
    const attribution = `<p class="provenance">from <a href="${escapeHref(sub.origin)}">${subLabel}</a>${sourceLink ? ` — <a href="${escapeHref(sourceLink)}">source ↗</a>` : ""}</p>`;
    blocks.push(`<article class="fragment">
${html}
${pinNote}
${attribution}
</article>`);
  }
  // The site's own header and masthead, like every other public page. The old
  // bare `<a href="/">Home</a>` pointed at the host root, which on a
  // path-mounted blyg (venkateshrao.com/blyg/) is not the blyg at all.
  const summary = hopperSummary(settings, items);
  const description = hopperDescription(settings, hopper, items);
  // The hopper's own feed, only while the experimental setting is on
  // (src/hopper-feed.ts); otherwise the page advertises the blyg's feed as before.
  const feed = settings.hopper_feeds && hopper.slug ? `${origin}${hopperFeedPath(hopper.slug)}` : null;
  const rssLink = feed ? ` · <a class="collection-feed" href="${escapeHref(feed)}">RSS</a>` : "";
  const body = await blygPage(db, settings, mount, `<header class="collection-head">
<h2>${escapeHtml(hopper.name)}</h2>
${hopper.description ? `<p class="collection-desc">${escapeHtml(hopper.description)}</p>\n` : ""}<p class="meta">A collection · ${escapeHtml(summary)} · <a href="${mount}/">${escapeHtml(settings.site_title)}</a>${rssLink}</p>
</header>
${blocks.join("\n") || "<p>Nothing here yet.</p>"}`);
  return layout(`${hopper.name} — ${settings.site_title}`, body, mount, {
    description,
    url: `${origin}${hopperPagePath(hopper.slug ?? "")}`,
    siteName: settings.site_title,
    // §12.1 step 7 / §13.5a: rel="blyg" lets step 4 find the manifest from
    // this page under any mount, so a reader can match the hopper there.
    ...(feed
      ? { feedUrl: feed, feedTitle: hopperFeedTitle(hopper.name, settings.site_title), blygManifest: `${origin}blyg.json` }
      : { feedUrl: `${origin}feed.xml`, feedTitle: settings.site_title }),
  });
}
