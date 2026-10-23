# Hopper feeds

> **PROPOSED, not in force, pending a Fable ruling** (fable-round-queue item 14).
> The proposed normative text is in blygger-spec `protocol-v0.4.md` (§6.1
> `hoppers`, §12.1 step 7, §12.2, §13.5, §13.5a) on the `proposal/hopper-feeds`
> branch, with the write-up in `docs/proposals/hopper-feeds-proposal.md`. If the
> ruling changes a shape, this build changes to match.

Everything here sits behind one setting, **`hopper_feeds`**, off by default
(Settings, Network, *collection feeds*). With it off, a node behaves exactly as
before: no hopper feed route, no new links on hopper pages, no `hoppers` key in
`blyg.json`, and no hopper match when subscribing.

Every URL shape, name and constant lives in `src/hopper-feed-shape.ts`.

## Publish side

### The feed: `{mount}/h/{slug}/feed.xml`

RSS 2.0 for one **public** hopper (`src/hopper-feed.ts`). A private hopper, an
unknown slug and the setting being off all answer the same 404, so a private
hopper leaks nothing, not even that it exists.

- **Channel:** title `{hopper name} — {site title}`, link to the hopper page,
  description the hopper's description or the page's own fallback ("A collection
  on …"), an `atom:link rel="self"`.
- **No `blyg:` namespace anywhere** (§13.5a rule 2), the owner's own items
  included. A hopper entry carrying `blyg:id` would make the hopper feed a second
  blyg feed for the same origin and collide in rollup. The owner's items reach
  blyg readers through `feed.xml`.
- **The whole list, no window** (rule 3): one `<item>` per current member,
  newest-added first. Members the hopper page shows are the members the feed
  carries (one loader, `loadHopperMembers`), except one withdrawn at its origin
  with no retained pin, which has rolled to null (§13.4) and leaves the feed.
- **Each entry is curation** (rule 4):
  - `<guid isPermaLink="false">hopper:{slug}:{member origin}:{id}</guid>`. Public
    slugs are frozen (migration 0006), so the guid is stable.
  - `<link>`: the held snapshot's declared `page`, else the origin's item
    document (`item` template, else `{origin}items/{id}.json`). Never a
    constructed `f/`/`t/` permalink (#85). An L0 member links to its entry URL.
    An own item links to its own `page`.
  - `<description>`: an excerpt (280 characters), a link to the item, and "via
    {hopper} on {site}". Never the held snapshot. Memberships hold no curator
    note yet; one would lead the body.
  - `<pubDate>`: when the item joined the hopper.
  - `dc:creator` from the member's `author.name`, when it has one.
  - `<source url="{member origin's feed}">{source title}</source>` on every member
    that is not the owner's own.

```xml
<item>
  <guid isPermaLink="false">hopper:picks:https://a.example/blyg/:01j9x…</guid>
  <link>https://a.example/blyg/posts/one/</link>
  <title>Heading One</title>
  <description><![CDATA[<p>Words that carry the argument…</p>
<p><a href="https://a.example/blyg/posts/one/">A Blyg ↗</a> · via <a href="https://example.com/blyg/h/picks/">Picks</a> on <a href="https://example.com/blyg/">My Blyg</a></p>]]></description>
  <pubDate>Sat, 05 Sep 2026 00:00:00 GMT</pubDate>
  <dc:creator>Ann Author</dc:creator>
  <source url="https://a.example/blyg/feed.xml">A Blyg</source>
</item>
```

### Discovery

While the setting is on, the hopper page's `<link rel="alternate"
type="application/rss+xml">` points at the hopper feed instead of the blyg's,
its meta line gains an **RSS** link, and its head carries `<link rel="blyg">` to
the manifest, so §12.1 step 4 finds the manifest from the hopper page under any
mount.

### The manifest's `hoppers` key (§6.1)

```json
"hoppers": [{ "title": "Picks", "page": "h/picks/", "feed": "h/picks/feed.xml" }]
```

Public, slugged hoppers only, origin-relative paths, and only while the setting
is on and at least one hopper is public, so every other manifest is
byte-identical. `PROTOCOL_VERSION` is unchanged. A static export keeps only the
hoppers named with `--hoppers`, and exports their feeds.

### The blyg's own feed is unchanged

`feed.xml` never carries a hopper member (decision #12). A test holds it
byte-identical with the setting on and off.

### Caching

The hopper feed goes through the same edge cache as public HTML
(`src/html-cache.ts`): its key carries the public revision, which moves with the
`hoppers`, `items`, `subscriptions` and `settings` change domains. A membership
change, a hopper taken private, or the setting turned off reads a fresh entry
at once, and a 404 is never cached.

## Subscribe side

### §12.1 step 7, hopper match

`resolve(url, fetch, { hoppers })` in `src/importer/resolve.ts`. When steps 2–5
resolve a manifest that has `hoppers`, the input URL (query and fragment
stripped, before step 1's trailing slash) is compared with each entry's `feed`
and `page`, resolved against the identity origin; a page matches with or without
its slash. A match on an entry with a `feed` resolves to `{ origin, manifest,
hopper_feed }`; a page-only entry, or no match, resolves as the whole blyg. No
extra fetch. Skipped entirely while the setting is off.

The subscribe sheet then offers the hopper, with **subscribe to the whole blyg
instead** (`whole_blyg: true` on `POST /api/subscriptions`).

### §12.2 identity

A hopper subscription is "a subscription to a list at an origin, not a second
origin". Migration **0033** adds `subscriptions.hopper_feed` (NULL = not a
hopper subscription). The row stores:

- `origin`: the blyg's **identity origin**, the same value a whole-blyg
  subscription to it has;
- `hopper_feed` and `feed_url`: the hopper feed's URL as the manifest names it;
- `surface`: where the manifest lives when it is not `{origin}blyg.json`, as for
  a blyg, so the daily check can find it on a templated or unconventional mount
  (no separate manifest column);
- `kind: "rss"`, because its entries are L0 rows.

The unique key is **(origin, hopper_feed)** for hopper rows (a partial unique
index). The whole-blyg half, one subscription per origin with `hopper_feed`
NULL, stays where it is today: the subscribe route's 409 (`findSubscription`).
A unique index over it would abort the migration on a node that still holds a
duplicate subscription from before 0.26.1, when the route started refusing
them. So two hoppers of one blyg and the whole blyg can all be subscribed at
once, and a second subscribe to the same hopper is refused with 409.

The title is `{hopper} — {blyg}`, which the channel title keeps current.

**Every lookup that means "the whole blyg at this origin" excludes hopper rows**
(`hopper_feed IS NULL`), so a hopper subscription never supplies a title,
provenance line, citation, link target or transclusion source:

| Where | What it means |
|---|---|
| `src/importer/store.ts` `findSubscription` | the subscribe 409: a blyg or feed already followed |
| `src/importer/store.ts` `listBlogrollSubscriptions` | `blogroll.opml` and the blogroll section: hopper subscriptions are never listed, not even under their blyg |
| `src/public-feed.ts` `loadProvenance` | provenance title and page under a baked remote quote |
| `src/pages.ts` `transclusionProvenance` (fallback query) | the same, uncached |
| `src/stub.ts` `composeStubCite`, `citedUrl` | a stub's or transclusion's frozen `cited` (source, author, excerpt, url) |
| `src/fork.ts` remote fork | the fork citation's source title |
| `src/authoring.ts` `scopeSummariesWithSources` | "draws on {blyg}" in the TK panel |
| `src/api.ts` quote-origin link | the link to a quoted remote item |
| `src/read-api.ts` mention source | the holder and the subscription for an inbound mention's source |
| `src/mentions/send.ts` `remoteTarget` | an outbound mention's target page |
| `src/transclusion.ts` `resolveTarget` | `![[id]]`, `[[id]]` and TK sources |
| `src/interactions.ts` `withLabels` | the label of a signalled or hoppered target |
| `src/ui/opml.ts` `subscribedKeys` | OPML import's "already subscribed": a hopper's feed counts, its origin does not |

Unchanged, because they already mean the blyg: `kind = 'blyg'` lookups
(`src/surface.ts`, `src/mentions/send.ts`, `src/api.ts` quote refresh), and the
picker and URL repair, which take `l0 = 0` rows only. The interaction log still
records a hopper entry's origin, since grouping by origin is the point there.

### Polling (§13.5a rules 5–6)

Entries import as L0 rows scoped to the subscription (their synthetic ids are
derived from the hopper feed, not the shared origin): excerpts and links, never
a transclusion, link or TK source, never a mention target. Each entry keeps its
own author, from its `dc:creator`, and is never attributed to the hopper's
owner (rule 5). Each poll reconciles against the whole list: **an entry that
has disappeared is dropped**, unlike a plain L0 feed, whose entries scroll out
of a window and are kept.

On the daily manifest sync (keyed by origin and hopper feed: the manifest's
`feed` entries resolved against the subscription's origin), if the manifest no
longer lists the hopper's feed,
polling stops: the subscription is paused, flagged `hopper-unlisted`, and its
entries are dropped as withdrawn. It is never turned into a subscription to the
whole blyg. A manifest that cannot be read changes nothing.
