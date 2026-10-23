// Protocol surface builders: item JSON, manifest, archive index, feed.xml
// — v0.1-plan §2.3–2.6. These shapes are protocol; do not change casually.

import { manifestHopperEntry } from "./hopper-feed-shape.ts";
import { listBlogrollSubscriptions, listPublicHoppers } from "./importer/store.ts";
import { excerpt, excerptFromHtml } from "./markdown.ts";
import { loadProvenance } from "./public-feed.ts";
import { authorOwnHtml, forkLineage, injectProvenance, respondsToLabel, stubCitation, transclusionProvenance } from "./pages.ts";
import { parseStoredCite, parseStoredFork, parseStoredStub } from "./stub.ts";
import {
  authoredKind,
  feedEvents,
  getMedia,
  lastUpdated,
  listVersionMedia,
  listPublic,
  listVersions,
  publishedVersion,
} from "./model.ts";
import type { ItemRow, ScopeProvenance, Settings, Transclusion, VersionRow } from "./types.ts";
import { BRAND, FEED_WINDOW, GENERATOR, GENERATOR_URL, PROTOCOL_LEVEL, PROTOCOL_VERSION, WEBMENTION_PATH } from "./types.ts";
import { absolutizeHtml, cdata, escapeXml, rfc822, unplacedMedia, visibleMedia } from "./util.ts";

/**
 * Canonical origin for this deployment — the blyg's base URL, always ending
 * in "/". settings.site_url wins when set; otherwise derived from the request
 * origin + the deployment mount (decision #14: "" mount = domain root).
 */
export function siteOrigin(settings: Settings, requestUrl: string, mount: string): string {
  // A stored value from before 0.27's write check may be any string; only an
  // http(s) URL can stand for this blyg's origin.
  if (settings.site_url && URL.canParse(settings.site_url) && ["http:", "https:"].includes(new URL(settings.site_url).protocol)) {
    return settings.site_url.endsWith("/") ? settings.site_url : settings.site_url + "/";
  }
  return new URL(requestUrl).origin + mount + "/";
}

/**
 * Attach a reference's frozen human half for the wire (§5.9, decision #30).
 *
 * `stub_of` and `forked_from` keep their cites in the columns migrations 0008
 * and 0010 gave them, and gain `cited` here at serialization; a remote
 * `transclusions[]` entry carries its own, inside the entry, because that is
 * where a per-reference fact belongs in an array. Both routes freeze at the
 * moment the reference was made and neither is ever recomposed on read.
 */
function withCited<T extends object>(ref: T | null, citeJson: string | null): T | null {
  if (!ref) return null;
  const cite = parseStoredCite(citeJson);
  return cite ? { ...ref, cited: cite } : ref;
}

/** This client's `page` for its own items (§2.3.2): what item JSON declares, and where a hopper feed links one. */
export function ownPagePath(isThread: boolean, id: string): string {
  return `${isThread ? "t" : "f"}/${id}/`;
}

function author(settings: Settings, origin: string) {
  return { name: settings.author_name, url: settings.author_url || origin };
}

/** §2.3 item JSON. Only the latest published version's content is served. */
export async function buildItemJson(db: D1Database, settings: Settings, item: ItemRow, origin: string) {
  const isWithdrawn = item.kind === "withdrawn";
  const latest = await publishedVersion(db, item);
  const contentMd = isWithdrawn ? "" : (latest?.content_md ?? "");
  const contentHtml = isWithdrawn ? "" : (latest?.content_html ?? "");
  const media = isWithdrawn ? [] : await listVersionMedia(db, item.id, item.version);
  const changelog = (await listVersions(db, item.id)).map((v) => ({
    version: v.version,
    at: v.published_at,
    note: v.note,
    ...(v.pinned === 1 ? { pinned: true } : {}),
    // §5.2 / #40: the studio wrote this note. Only with a note to describe.
    ...(v.note_generated === 1 && v.note ? { generated: true } : {}),
  }));
  // Thread items additionally carry transclusions provenance (§2.9); a
  // withdrawn thread's endcap empties it to [] alongside content_md/media.
  const isThread = isWithdrawn ? (await authoredKind(db, item)) === "thread" : item.kind === "thread";
  const transclusions: Transclusion[] | undefined = isThread
    ? isWithdrawn
      ? []
      : (JSON.parse(latest?.transclusions ?? "[]") as Transclusion[])
    : undefined;
  // TK generation provenance (tk-core-plan.md §3.1): optional, valid for
  // both kinds; withdrawal empties it alongside content_md/content_html,
  // same as the other content-linked fields.
  const generated: ScopeProvenance[] | undefined =
    !isWithdrawn && latest?.generated_json ? (JSON.parse(latest.generated_json) as ScopeProvenance[]) : undefined;
  // §2.2 stub citation: published on the version, so a withdrawal endcap —
  // which stores none — simply stops carrying it, and a withdrawn stub
  // stops verifying on the far side (§2.3.6). Threads only.
  const stubOf = isWithdrawn ? null : withCited(parseStoredStub(latest?.stub_of ?? null), latest?.stub_cite ?? null);
  // §2.4 lineage. Unlike every field above it, this one survives withdrawal:
  // the endcap empties what the item *said* (content, media, transclusions,
  // its stub citation), because those are the published work and the work is
  // being taken back. Where the item came from is not the work — it is a fact
  // about the item's origin, in the same class as `created` and `page`, which
  // the endcap also keeps. It costs nothing to keep and a withdrawn fork that
  // denied its parentage would be the protocol telling a small lie.
  const forkedFrom = withCited(parseStoredFork(item.forked_from), item.fork_cite);
  return {
    blyg: PROTOCOL_VERSION,
    id: item.id,
    kind: item.kind,
    origin,
    // §2.3.2 (decision #29): the origin-relative permalink, so a reader never
    // has to *infer* it from the f/·t/ convention this client happens to use.
    // Emitted for withdrawn items too — an endcap's page is 200 forever, and a
    // mention may legitimately target it.
    page: ownPagePath(isThread, item.id),
    author: author(settings, origin),
    created: item.created,
    updated: item.updated,
    version: item.version,
    content_md: contentMd,
    content_html: contentHtml,
    content_hash: latest?.content_hash ?? "",
    media: visibleMedia(media, contentHtml).map((m) => ({ url: m.r2_key, mime: m.mime, alt: m.alt ?? "" })),
    ...(transclusions !== undefined ? { transclusions } : {}),
    ...(stubOf ? { stub_of: stubOf } : {}),
    ...(forkedFrom ? { forked_from: forkedFrom } : {}),
    ...(generated !== undefined ? { generated } : {}),
    changelog,
  };
}

/** §2.8 pinned version file — permanent, survives edits and withdrawal. */
export function buildPinnedVersionJson(settings: Settings, item: ItemRow, row: VersionRow, origin: string) {
  const isThread = row.transclusions !== null;
  return {
    blyg: PROTOCOL_VERSION,
    id: item.id,
    kind: isThread ? "thread" : "fragment",
    version: row.version,
    at: row.published_at,
    note: row.note,
    pinned: true,
    origin,
    author: author(settings, origin),
    content_md: row.content_md,
    content_html: row.content_html,
    content_hash: row.content_hash,
    ...(isThread ? { transclusions: JSON.parse(row.transclusions as string) as Transclusion[] } : {}),
    // A pin carries its own citation (§2.2): the frozen artifact says what it
    // was responding to, at the version it was responding to.
    ...(parseStoredStub(row.stub_of) ? { stub_of: withCited(parseStoredStub(row.stub_of), row.stub_cite) } : {}),
    // Lineage travels with the pin too, and safely: `items.forked_from` is
    // written once at fork time and has no setter, so a frozen document can
    // never come to disagree with the live item about where it came from.
    ...(parseStoredFork(item.forked_from) ? { forked_from: withCited(parseStoredFork(item.forked_from), item.fork_cite) } : {}),
    ...(row.generated_json ? { generated: JSON.parse(row.generated_json) as ScopeProvenance[] } : {}),
  };
}

/** §2.4 manifest. */
export async function buildManifest(db: D1Database, settings: Settings, origin: string, opts: { webmention?: boolean } = {}) {
  // Relative media path, resolved to the row's `r2_key` (`media/{id}.{ext}`).
  // Emitting the bare id produced a manifest `avatar` that always 404s, since
  // `/media/:file` matches the full key including the extension (session 19).
  const avatarRow = settings.avatar_media_id ? await getMedia(db, settings.avatar_media_id) : null;
  const avatar = avatarRow?.r2_key;
  const hasBlogroll = (await listBlogrollSubscriptions(db)).length > 0;
  // §6.1 `hoppers` (PROPOSED, pending Fable; fable-round-queue item 14): the
  // public, slugged hoppers, only while the hopper_feeds setting is on and
  // only when there is one, so every other manifest stays byte-identical.
  const hoppers = settings.hopper_feeds
    ? (await listPublicHoppers(db)).filter((h): h is typeof h & { slug: string } => !!h.slug).map(manifestHopperEntry)
    : [];
  return {
    blyg: PROTOCOL_VERSION,
    level: PROTOCOL_LEVEL,
    generator: GENERATOR,
    // §6.1 (decision #34): where this client's source lives. A directory can
    // then reach a client's release page from a manifest alone, which is the
    // only channel that exists for telling five of seven implementations'
    // operators anything — most have no locatable repo.
    generator_url: GENERATOR_URL,
    site: origin,
    title: settings.site_title,
    author: {
      name: settings.author_name,
      bio: settings.author_bio,
      ...(avatar ? { avatar } : {}),
      links: settings.author_links,
    },
    feed: "feed.xml",
    items: "items/index.json",
    updated: await lastUpdated(db),
    // §2.2: OPTIONAL, origin-relative; present only when the blogroll is non-empty.
    ...(hasBlogroll ? { blogroll: "blogroll.opml" } : {}),
    // v0.3 §2.3.1: present only when this deployment can actually receive.
    // A static export omits it — the exported tree has no endpoint behind it,
    // and advertising one would promise delivery nothing could keep.
    // §15.1: advertised "only when mentions are accepted". `opts.webmention`
    // is the caller's override (a static tree accepts none); the setting is the
    // operator's, and either one is enough to withhold the key.
    ...(opts.webmention === false || !settings.accept_mentions ? {} : { webmention: WEBMENTION_PATH }),
    ...(hoppers.length ? { hoppers } : {}),
  };
}

/** §2.5 archive index — every published item + withdrawn endcap, no window. */
export async function buildArchiveIndex(db: D1Database) {
  const items = await listPublic(db);
  return {
    updated: await lastUpdated(db),
    items: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      created: i.created,
      updated: i.updated,
      version: i.version,
    })),
  };
}

/** Feed entry title: edit note if present + ~60 chars of plain text; withdrawal events say "withdrawn". */
export function feedTitle(item: ItemRow, note: string | null, excerptText: string): string {
  if (item.kind === "withdrawn") return "withdrawn";
  return note ? `${note} — ${excerptText}` : excerptText;
}

function latestTransclusions(latest: Pick<VersionRow, "transclusions"> | null): Transclusion[] {
  if (!latest?.transclusions) return [];
  return JSON.parse(latest.transclusions) as Transclusion[];
}

/** §2.6 feed.xml: RSS 2.0 + blyg namespace, per-version GUIDs, 50-entry window. */
export async function buildFeedXml(db: D1Database, settings: Settings, origin: string): Promise<string> {
  const events = await feedEvents(db, FEED_WINDOW);
  const built = await lastUpdated(db);
  // Root-relative path of the canonical origin ("" for a root mount) — keeps
  // injected provenance links consistent with `origin` after absolutizeHtml.
  const originPath = new URL(origin).pathname.replace(/\/$/, "");
  // Batched loads: the old per-event publishedVersion / media / provenance
  // queries turned one feed render into ~200 sequential D1 roundtrips
  // (~29s on live nodes — past every reader's timeout, so SmartRSS and
  // friends reported "invalid feed"). Same bytes out, fixed query count.
  const liveItems = events.filter(({ item }) => item.kind !== "withdrawn");
  const livePairs = JSON.stringify([...new Map(liveItems.map(({ item }) => [item.id, { id: item.id, version: item.version }])).values()]);
  const withdrawnIds = JSON.stringify([...new Map(events.filter(({ item }) => item.kind === "withdrawn").map(({ item }) => [item.id, { id: item.id, version: item.version }])).values()]);
  const [latestRes, mediaRes, prevRes] = await db.batch([
    db.prepare(`SELECT v.item_id, v.content_md, v.content_html, v.transclusions, v.stub_of, v.stub_cite FROM json_each(?) s JOIN versions v
      ON v.item_id = json_extract(s.value, '$.id') AND v.version = json_extract(s.value, '$.version')`).bind(livePairs),
    // Each live item's latest version's own attachments (migration 0031).
    db.prepare(`SELECT vm.item_id, m.r2_key, m.alt, m.inline FROM json_each(?) s JOIN version_media vm
      ON vm.item_id = json_extract(s.value, '$.id') AND vm.version = json_extract(s.value, '$.version')
      JOIN media m ON m.id = vm.media_id ORDER BY m.created ASC, m.rowid ASC`).bind(livePairs),
    db.prepare(`SELECT v.item_id, v.transclusions FROM json_each(?) s JOIN versions v
      ON v.item_id = json_extract(s.value, '$.id') AND v.version = json_extract(s.value, '$.version') - 1`).bind(withdrawnIds),
  ]);
  const latestById = new Map<string, { content_md: string; content_html: string; transclusions: string | null; stub_of: string | null; stub_cite: string | null }>();
  for (const v of latestRes.results as unknown as Array<{ item_id: string; content_md: string; content_html: string; transclusions: string | null; stub_of: string | null; stub_cite: string | null }>) {
    latestById.set(v.item_id, v);
  }
  const mediaById = new Map<string, Array<{ r2_key: string; alt: string | null; inline?: number }>>();
  for (const m of mediaRes.results as unknown as Array<{ item_id: string; r2_key: string; alt: string | null; inline: number }>) {
    const list = mediaById.get(m.item_id) ?? [];
    list.push(m);
    mediaById.set(m.item_id, list);
  }
  const withdrawnKind = new Map<string, boolean>();
  for (const r of prevRes.results as unknown as Array<{ item_id: string; transclusions: string | null }>) {
    withdrawnKind.set(r.item_id, Boolean(r.transclusions));
  }
  // Same loader as the public pages: the feed and the HTML page can never
  // disagree about whose quote this is.
  const provenance = await loadProvenance(
    db,
    liveItems
      .filter(({ item }) => item.kind === "thread")
      .map(({ item }) => latestTransclusions({ transclusions: latestById.get(item.id)?.transclusions ?? null })),
  );
  // §7 (C-7-08): the standard RSS byline, whenever the item's author.name is
  // present. Every item carries the blyg's one author, so it is the same line
  // on each entry; the opaque author object never appears in the XML.
  const creator = settings.author_name ? `      <dc:creator>${escapeXml(settings.author_name)}</dc:creator>\n` : "";
  const itemsXml: string[] = [];
  // Per §2.3, only the latest version's content is published — feed entries
  // for older publish events carry the event's version/note but render the
  // item's *latest* content (see DEVLOG session 2).
  for (const { item, version } of events) {
    const isWithdrawn = item.kind === "withdrawn";
    const latest = isWithdrawn ? null : latestById.get(item.id) ?? null;
    const latestMd = latest?.content_md ?? "";
    const isThread = isWithdrawn ? (withdrawnKind.get(item.id) ?? false) : item.kind === "thread";
    const rawHtml = latest?.content_html ?? "";
    let html = isWithdrawn
      ? ""
      : absolutizeHtml(
          isThread ? injectProvenance(rawHtml, await transclusionProvenance(db, latestTransclusions(latest), originPath, provenance)) : rawHtml,
          origin,
        );
    if (!isWithdrawn) {
      for (const m of unplacedMedia(mediaById.get(item.id) ?? [], html)) {
        html += `<p><img src="${origin}${m.r2_key}" alt="${escapeXml(m.alt ?? "")}"></p>`;
      }
    }
    // A citation travels with the work: an RSS reader showing this item should
    // show what it answers, in the same injected-presentation layer as
    // transclusion provenance (which has been in the description since 0.1).
    if (!isWithdrawn && isThread && latest?.stub_of) {
      html = absolutizeHtml(stubCitation(latest, settings.timezone, { compact: true }), origin) + html;
    }
    // Lineage rides along for the same reason, and for both kinds — a fork is
    // a fragment as often as a thread.
    if (!isWithdrawn && item.forked_from) {
      html = absolutizeHtml(forkLineage(item, settings.timezone, { compact: true }), origin) + html;
    }
    // A feed headline names the item, so it names it in the author's own words.
    // `rawHtml` for a thread contains other people's text baked in as quotes
    // (§10); flattening that to 60 characters is how a stub that opened with a
    // quote got an RSS headline that was the quoted person's sentence. Same
    // derivation as the page title and the feed card — see pages.ts
    // authorOwnHtml for the measurement that prompted it.
    const excerptText = isWithdrawn
      ? ""
      : isThread
        ? excerptFromHtml(authorOwnHtml(rawHtml), 60) || respondsToLabel(latest)
        : excerpt(latestMd, 60);
    itemsXml.push(
      `    <item>
      <guid isPermaLink="false">blyg:${item.id}:v${version.version}</guid>
      <link>${origin}${isThread ? "t" : "f"}/${item.id}/</link>
      <title>${escapeXml(feedTitle(item, version.note, excerptText))}</title>
      <description>${isWithdrawn ? "" : cdata(html)}</description>
      <pubDate>${rfc822(version.published_at)}</pubDate>
${creator}      <blyg:id>${item.id}</blyg:id>
      <blyg:kind>${item.kind}</blyg:kind>
      <blyg:version>${version.version}</blyg:version>
      <blyg:created>${item.created}</blyg:created>
      <blyg:item>${origin}items/${item.id}.json</blyg:item>
    </item>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:blyg="${BRAND.nsUri}" xmlns:atom="http://www.w3.org/2005/Atom"${creator ? ' xmlns:dc="http://purl.org/dc/elements/1.1/"' : ""}>
  <channel>
    <title>${escapeXml(settings.site_title)}</title>
    <link>${origin}</link>
    <description>${escapeXml(settings.author_bio || settings.site_title)}</description>
    <atom:link href="${escapeXml(`${origin}feed.xml`)}" rel="self" type="application/rss+xml" />
    <lastBuildDate>${rfc822(built)}</lastBuildDate>
    <blyg:level>${PROTOCOL_LEVEL}</blyg:level>
    <blyg:manifest>${origin}blyg.json</blyg:manifest>
${itemsXml.join("\n")}
  </channel>
</rss>
`;
}
