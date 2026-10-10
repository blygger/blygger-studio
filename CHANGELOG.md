# Changelog — Blygger Studio

Client releases, newest first. **The client version is not the protocol version**
(README § Versioning): an entry here says what this program does, and names the
protocol version it implements rather than changing it. Protocol versions are
released separately, as `/spec/{version}/` documents in
[`blygger-spec`](https://github.com/blygger/blygger-spec).

Every entry states **Migrations** explicitly, because that is the one line an
operator needs before deciding how careful an upgrade has to be. Upgrade
instructions are in the README under
[Releases and upgrading](README.md#releases-and-upgrading).

This file starts at 0.4.1, the first tagged release. Everything before it is in
the [program devlog](https://github.com/blygger/blygger-spec/blob/main/DEVLOG.md) —
sessions 1–26, which is where the client's history lives because the client did
not have its own repo until session 26.

---

## Unreleased

**Migrations: none.**

- **Cloudflare Workers AI** (studio#8, after Aneesh Sathe's local patch). A
  `workers-ai` provider in `models.json` runs `@cf/…` models on the Worker's
  own `ai` binding, with no API key; Gemma 4 26B, Llama 4 Scout, Llama 3.3 70B
  and Mistral Small 3.1 are listed, and any `@cf/…` id can be typed in. The
  binding is commented out in `wrangler.jsonc` and in what `npm run init`
  writes: uncomment it to offer these models. Nothing runs on it until a model
  is chosen in Settings: still no default model and no fallback. Reasoning a
  model inlines into its answer is removed, and Gemma 4 is asked not to think.
- **OpenAI-compatible endpoints.** An `openai-chat` provider calls any Chat
  Completions endpoint at its `base_url` (OpenRouter, Groq, Together,
  Cloudflare's OpenAI-compatible endpoint, a local Ollama), with its key in a
  Worker secret named by `key_secret`. Add one in `models.local.json`; README §
  AI models has an example. The build now refuses a manifest whose provider
  could not be called: an unknown api, a missing key secret or base URL, a
  base URL that is not https or carries credentials, or a `key_secret` naming
  `OWNER_PASSWORD` or `COOKIE_SECRET`.
- Both spend the daily AI budget like every other provider.
- **API:** in `GET /api/ai/models`, a provider's `key_secret` is now optional
  (absent for Workers AI and keyless endpoints) and a Workers AI provider
  carries `binding`. `configured` means the key is set, the binding is bound,
  or neither is needed.
- Tests never reach real, billed Workers AI (`remoteBindings: false`).

## 0.39.0 — 2026-10-09

**Migrations: `0026_read_state.sql`** (a `read_state` table and five triggers).
Apply it before deploying: `wrangler d1 migrations apply <database> --remote`.

- **Read state for imported items** (Aneesh Sathe, #44 and #45). Reading
  entries show an unread dot. Opening an entry marks it read, and a select mode
  marks several read or unread at once, or the whole feed read. Read state is
  stored per imported item with the version you read, so a new version of an
  item shows as unread again. Marking unread leaves a tombstone, so a stale
  "read" from a client that was offline cannot undo it. It stays in the studio:
  nothing about it reaches the feed, the item documents or other blygs.
- **API:** `PUT` and `DELETE /api/reading/{sub}/{remoteId}/read`, the batch
  routes `POST /api/reading/read` and `POST /api/reading/unread` (up to the
  batch limit in one write), and `readVersion` on `GET /api/reading`. A change
  advances the `reading` revision in `GET /api/changes`. Read state is deleted
  along with its imported item or subscription.
- **A new scope, `reading:state`**, for marking read and unread. A reader app
  that only syncs read state does not need `owner:manage`, which can also
  delete subscriptions, and `owner:manage` does not include read state. Existing
  grants are unchanged; a client that wants read state asks for the new scope.

## 0.38.0 — 2026-10-09

**Migrations: none.**

- **Two extensions come with every release, both off.** Until now releases
  compiled in no extensions, so trying the 0.37.0 mechanism meant building
  from source. Two browser-only ones now ship, each turned on in Settings →
  extensions:
  - **Reading time** puts an estimate at the end of each reading entry's
    byline ("· 4 min", the word count on hover). Words count at 230 a minute,
    Han, kana and Hangul characters at 500.
  - **Inspect** adds "inspect" to an entry's ⋯ sheet: the record this Studio
    holds for it (id, kind, version, state, content hash, `stub_of`,
    `forked_from`, transclusions) and its JSON with the bodies left out, with
    a copy button. It reads your own item or the imported copy through the
    existing API and fetches nothing from the item's origin.

  Neither has a server half or routes, and a test keeps anything that does
  out of `extensions.json`. An operator who wants neither can put
  `{"remove": ["inspect", "reading-time"]}` in `extensions.local.json`. The
  Settings card now appears on every node.

## 0.37.0 — 2026-10-09

**Migrations: none.**

- **Studio extensions** (Aneesh Sathe, blygger-studio#52). A way to run UI
  experiments on a real node without them becoming the reference design.
  An extension is first-party TypeScript in `extensions/<name>/`, compiled in
  only when the operator lists it in a gitignored `extensions.local.json`, and
  then enabled per node in Settings → extensions. Releases compile none in, and
  with none enabled the Studio's markup is unchanged. Extensions get slots on
  the reading entry (byline, ⋯ sheet rows, a sheet of their own) and a page at
  `/studio/ext/<name>` linked from More. Server routes are owner reads only, at
  `GET /api/ext/<name>/…`, behind the owner API's auth, scope and budget
  middleware, and 404 while disabled. Nothing reaches the wire. Read the
  security model in `docs/extensions.md` before compiling one in: an
  extension's UI holds the owner's session. New setting: `extensions` (empty).
- **Fresh installs deploy again** (ruthvik-947, blygger-studio#46). Since 0.28,
  `npm run init` wrote a config without `nodejs_compat`, so a new install's
  first deploy failed with `No such module "node:crypto"`. Init now writes it,
  and CI checks that init's config and `wrangler.jsonc` agree on every runtime
  setting. An install that hit the error can add
  `"compatibility_flags": ["nodejs_compat"]` to its own `wrangler.jsonc`.
- **Autosave keeps one write in flight** (Kyle Mathews, blygger-studio#47).
  Typing that outpaces the backend now merges into the latest pending save
  instead of queueing every snapshot; generate, publish, restore and delete
  still run in order after the saves before them. TanStack DB paced mutations
  replace the hand-written promise queues. Upgrades React DB to 0.5.7 and
  Query DB Collection to 1.4.2.
- **Shared item and hopper reads** (Kyle Mathews, blygger-studio#55). Opening
  an editor makes one item request, and hopper collections share identical
  requests instead of each fetching the same response. A discarded draft no
  longer shows a false read-error banner.

## 0.36.1 — 2026-10-07

**Migrations: none.**

- **Webmention receiver: repeat claims and the verification queue.** The hourly
  caps count rows, and a repeat claim for a source/target pair already stored
  adds none, so the same POST could be sent without limit, each time spending
  two outbound fetches and flipping a verified mention back to pending. A pair
  claimed again within a minute is now refused with a 429, and the stored row
  is left alone. A second cap refuses new claims while 30 are awaiting
  verification (rows touched in the last ten minutes, so a row whose
  verification died ages out). Both 429s now carry their own `Retry-After`
  (the remaining cooldown, or five minutes) instead of a flat hour. The
  per-host, per-domain and global hourly caps and the 30-day prune of failed
  rows (0.4.1) are unchanged.

## 0.36.0 — 2026-10-07

**Migrations: none.**

- **A generated block at the end of a post renders as a block.** A scope
  followed by a single trailing newline (or preceded by a leading one) was
  taken as sharing a paragraph with prose, so its disclosure rendered inline.
  The edges of the document now count as blank lines, whitespace and one
  newline included. `publish_blyg.py` had worked around this by stripping the
  final newline; the workaround is no longer needed.
- **Author URL in settings.** `author.url` in item documents was always the
  blyg's own address. A new `author_url` setting (Settings → profile) sets it;
  blank keeps the old behaviour. Must be an absolute http(s) URL.
- **`[[id]]` links take a heading as their text.** When the target opens with
  a heading (a thread's H1 is its title by convention) the link reads as that
  heading, in plain text; otherwise the quoted excerpt is used as before.
  Frozen into `content_html` at publish, so existing posts are unchanged until
  republished.

## 0.35.1 — 2026-10-07

**Migrations: none.**

- **An absolute `page` is used as it is.** §16.6e lets a blyg's permalinks
  live outside its mount (Soapbox's are WordPress post URLs), but every link
  built from `page` glued it onto the origin, giving
  `https://site/blyg/https://site/archives/…`. That covered reading-view
  source links, quote attribution, stub citations, and the target of every
  mention sent to such a blyg, so a mention to Soapbox would have failed on
  arrival. Found subscribing the official blyg to robertpeake.com.

Protocol: implements 0.3 (eleventh revision), plus the reader half of the
§16.6e 0.4 shape.

## 0.35.0 — 2026-10-07

**Migrations: 0025** (`subscriptions.surface`, plus the subscriptions change
trigger recreated to watch it). Apply it before deploying.

**Reads templated blygs** (spec §16.6e, decision #51; v0.4-plan.md §7.5
M1–M3). A blyg's manifest may now say where its feed, archive index, item
documents and pins live, as absolute or origin-relative URLs and RFC 6570
templates (`item` with `{id}`, `pin` with `{id}` and `{n}`). This is what
lets a WordPress site publish a blyg. The first is Robert Peake's Soapbox at
robertpeake.com/blyg/.

- **Subscribing** stores the locations the manifest declares (NULL means the
  default paths), and the daily manifest read refreshes them. That read now
  happens even for subscriptions you have renamed; your name is still never
  overwritten.
- **Every remote item or pin URL goes through one helper** (`src/surface.ts`):
  the importer, imported history and diffs, stale-quote checks, fork discovery
  and fork lineage, and quote attribution. For an origin you do not subscribe
  to, the default path is tried first and the manifest is read only when that
  fails.
- **Resolution follows `rel="blyg"` to a manifest at any path.** If the
  linked URL is itself a manifest, that is the manifest; otherwise
  `blyg.json` is appended as before. A blyg's identity is the manifest's URL
  minus its last path segment.
- **Mention verification accepts a templated sender.** When an item document
  was served from outside `{origin}items/{id}.json`, the verifier reads the
  sender's own `blyg.json` (a third fetch) and accepts only an exact match
  with its `item` template. A missing manifest, or a URL matching neither,
  fails the claim.
- **Fixed: the verifier took WordPress's oEmbed link for the item document.**
  It accepted any `rel="alternate"` whose type *began* with
  `application/json`, so `application/json+oembed`, which WordPress lists
  first, won. It now requires `application/json` exactly (parameters
  aside).

Our own surface is unchanged and emits no template keys.

Protocol: implements 0.3 (eleventh revision), plus the reader half of the
§16.6e 0.4 shape.

## 0.34.1 — 2026-10-07

**Migrations: none.**

Three studio fixes from Venkat's click-through of 0.34.0.

- **Mentions: the item heading opens its public page.** Responses are shown
  there, so that is where the heading goes, in a new tab. A small "edit" link
  beside it opens the editor, which is where the heading used to go.
- **The top bar's "public page ↗" follows the editor.** While you edit a
  published item it opens that item's page; everywhere else it still opens
  the blyg's home page.
- **Mentions say the public page lags.** Public pages are cached at the edge
  for about a minute (0.33.0, #41), so showing or hiding responses takes that
  long to appear. A note under each item now says so.

Also: the deploy-manifest test no longer assumes every node is on its own
Cloudflare account. The official blyg shares the personal account with
venkateshrao.

Protocol: implements 0.3 (eleventh revision).

## 0.34.0 — 2026-10-06

**Migrations: none.**

**The studio's data layer is rebuilt on shared sources** (Kyle Mathews,
blygger-studio#43). Each kind of record (items, hoppers, reading entries,
subscriptions, mentions and the rest) now has one source per browser tab,
and every list, editor and preview reads from it. An edit made in the editor
shows in the lists at once and rolls back everywhere if the save fails.
Nothing about the API changes.

- **Responses are checked before they are used.** Every response the studio
  loads is parsed with validators generated from the API contract; a
  response that does not match fails that read, keeps the last good rows on
  screen and can be retried.
- **The SDK exports those validators** as `@blygger/sdk/schemas`. The
  addition is additive; the SDK version stays 0.2.0.
- TanStack packages updated: `@tanstack/react-db` 0.5.5,
  `@tanstack/query-db-collection` 1.4.0, `@tanstack/query-core` 5.104.1.

Protocol: implements 0.3 (eleventh revision).

## 0.33.0 — 2026-10-06

**Migrations: none.** **Config: add a block to your own deployment config**
for the public HTML cache (below). Without it the studio works as before,
with only the browser half of the change.

**Public pages are cached at the edge for 60 seconds** (Kyle Mathews,
blygger-studio#41). The homepage, archive, fragment and thread pages, pinned
version pages and public collection pages are served from Cloudflare's
shared cache through a separate `PublicHtml` entrypoint; the studio, the API,
media and every wire file stay uncached. Browsers get a content ETag and
`Cache-Control: no-cache`, so a reload costs a bodyless 304 when nothing
changed. An edit or withdrawal can take up to a minute to reach readers. A
static export run right after an edit can pick up the cached page too.
Enable it by adding this next to `compatibility_date` in your Wrangler
config (the template already has it), and use Wrangler 4.107.0 or later:

```jsonc
"cache": { "enabled": false },
"exports": {
  "PublicHtml": { "type": "worker", "cache": { "enabled": true } }
},
```

After deploying, a second request for a public page should show
`Cf-Cache-Status: HIT`.

**One long subscription URL no longer stops all outgoing Webmentions**
(Kyle Mathews, blygger-studio#42). Delivery looked up each target's origin
with a SQL `LIKE` pattern, which D1 caps at 50 bytes; one subscription with
a longer URL made the lookup throw for every pending mention. Pending
mentions retry on the next delivery pass.

**Search accepts long words.** The same 50-byte cap made a search for a
pasted URL fail. Search now matches words of any length, still ignoring
ASCII case, and treats `%` and `_` as ordinary characters.

Protocol: implements 0.3 (eleventh revision).

## 0.32.3 — 2026-10-06

**Migrations: none.**

**A fork no longer carries `[[id]]` links that re-resolve in the forker's
context** (blygger-spec decision #63, spec §5.6 rule 6 in the 0.3 eleventh
revision). Forking already flattened a thread's quotes from the pinned
document (0.20.0), but inline `[[id]]` links in the copied prose were kept
as written. On publish they resolved against the forker's own blyg and
imports, so a link to an origin the forker had not imported failed publish,
and one that resolved could point somewhere other than what the source
linked. Each link now becomes an ordinary markdown link with the text and
absolute address that the pinned version rendered, in forked fragments and
threads alike. `[[id]]` inside code is left as written. If a link's rendered
anchor cannot be found (the target declares its own `page`), the fork is
rebuilt from the pinned HTML, as it already was when quotes did not line up.

Protocol: implements 0.3 (eleventh revision).

## 0.32.2 — 2026-10-06

**Migrations: none.** Upgrade promptly: the first item is a security fix.

**Mention verification checks the full address, path included** (blygger-spec
decision #61, spec §15.4 step 2 in the 0.3 eighth revision; found by Aneesh
Sathe's conformance toolkit, findings F1 and F4).

- **Two blygs on one host can no longer verify in each other's name.** The
  verifier compared only scheme, host and port, so a document served under
  `example.com/alice/` could claim to be `example.com/carol/`. It now requires
  the item document to have been fetched from exactly
  `{origin}items/{id}.json` for the origin and id it declares.
- **A pinned copy of a stub no longer verifies after the stub is withdrawn.**
  A pin file's address is never the live document's, so a mention whose
  source resolves to a pin fails. Honest senders are unaffected: a source is
  the item's page, whose alternate link names the live document.
- **A mention target on our host but outside our mount is refused** (§15.3).
  On a path-mounted blyg, `example.com/f/{id}/` is not ours when we live at
  `example.com/blyg/`.

Mentions verified under the old rule keep their status until they are re-sent
or re-verified.

**TK output and sources** (decision #60, settling blygger-studio#5).

- **A generation source is only what the instruction names.** A `![[id]]`
  that appears only in a scope's output is no longer recorded in
  `generated[].sources`, because the generator never read it.
- **Publish warns about an unrequested quote in generated text.** An
  own-line `![[id]]` left in TK output still becomes a real quote at publish,
  as in 0.20.1. When the instruction did not name that id, usually because a
  model echoed it, the publish response now says so, since the quoted origin
  was also notified.

**`page` stability is now tested** (decision #56): an item's `page` is the
same across edits and on its withdrawal endcap.

Protocol: implements 0.3 (eighth revision).

---

## 0.32.1 — 2026-10-06

- **Migration 0024 applies on Cloudflare.** As shipped in 0.32.0 it failed on `wrangler d1 migrations apply --remote` with `incomplete input`, because each trigger opened with a `CASE … END;` guard and D1's remote executor ends a trigger at the first `END;`. Local tests apply migrations another way and passed. The guards are now `SELECT RAISE(…) WHERE NOT EXISTS(…)`, which behaves the same; a new test rejects the old shape in any migration. Nothing was applied by the failed attempt, so if you tried 0.32.0, apply again.
- **Migrations: 0024_change_state.sql** (the corrected file). Apply before deploying. Do not deploy 0.32.0.

## 0.32.0 — 2026-10-06

- **Fewer D1 reads (#40, Kyle Mathews).** Studio polls `GET /api/changes`, a set of per-domain revision counters kept by database triggers, and reloads a collection only when its counter moved. `feed.xml` is rendered into the `MEDIA` bucket and served from there with an `ETag` and `304`s, rebuilt in the background when the feed's revision changes (stale-while-revalidate: a reader can get the previous feed while the new one builds). Design, operations and the verification record are in `docs/d1-polling-cache-*.md`.
- **Three crons:** `* * * * *` keeps the saved feed current (it needs **Settings → Canonical site URL**), `*/15 * * * *` polls subscriptions and retries mentions as before, and `0 0 * * *` runs the daily URL repair and mention pruning. A config that still lists only `*/15 * * * *` keeps working: its tick at 00:00 UTC runs the daily work too.
- Before restoring a database backup, read `docs/d1-polling-cache-operations.md`: run `scripts/reset-change-epoch.sql` after the restore.
- **Migrations: 0024_change_state.sql.** Adds the `change_state` row and its triggers. Apply before deploying.

## 0.31.0 — 2026-10-06

- **One response action: `stub`.** A stub is a quote post, a reply, commentary on an excerpt or an inline reply, depending on whether your words go above or below the quote and whether it quotes the whole post or a passage; with no words of your own it is a repost. *Quote selection* is gone from the reading view's ⋯ menu, along with the floating pill and selecting text in an entry to quote it: technically it was always a stub with a passage under the quote.
- **A stub opens quoting the whole post**, whatever its length. 0.30.0 quoted a long post's opening passage, which was rarely the passage wanted.
- **Passages are chosen in the stub editor.** A line under the stub header says what the draft is doing, and *quote a passage instead* shows the post: select a passage and press *quote only this*, which writes it under `![[id]]` as `>` lines. *Quote whole post* takes it out again. Once there is a passage, the next one is added after the cursor as its own quote (*add as another quote*), so a stub can be a running commentary with several passages; *replace the first quote* is beside it. Every passage is checked against the same snapshot publish checks.
- **How stubs work**: an explanation with the four shapes as a table and the `>` syntax opens with a new stub until *don't show this again* is ticked (remembered per device), and from a link on the stub header any time. The syntax page's stub section says the same.
- `POST /api/items` with `mode: "response"` still accepts `selection`, for other clients. Without one, the draft quotes the whole item.
- Migrations: none.

## 0.30.1 — 2026-10-06

- **Live preview no longer throttles editing.** `POST /api/preview` renders a draft and stores nothing, but 0.28 counted it against the owner's write budget (120 a minute); the editor sends one on every pause in typing, so ordinary composing hit "API work budget exceeded" and the preview stalled. It now spends the read budget (1,200 a minute). Real writes stay bounded.
- **The daily sync runs when a feed is unchanged.** A blyg subscription's poll returned on `304 Not Modified` before its daily index sync and manifest-name refresh, so an origin that honours ETags was never re-synced after its first poll; if that first sync failed (as during 0.28.0–0.28.2's DNS-check outage), its index and name stayed stale indefinitely. A 304 now runs the sync when it is due, and a degraded subscription reconciles on one too.
- Migrations: none.

## 0.30.0 — 2026-10-05

The first release since 0.28.2: 0.28.3 and 0.29.0 were deployed but never released, so their entries below ship here too.

- **Subscription names follow their source.** A blyg's manifest title is re-read with the daily index sync, and an RSS feed's channel title on every poll; a name the owner gave is never overwritten (`PATCH` with a `title` makes it the owner's, `title: null` hands it back). Existing blyg subscriptions follow their source; existing RSS ones keep their names. The subscription resource gains `title_follows_source`.
- **Resync all feeds**: a button in the reading header, and `POST /api/subscriptions/poll`, polls every subscription that is not paused, now, degraded ones included.
- Discarding a draft confirms with a green "Draft discarded" toast instead of a red "not found" (the compose list refetched the deleted item). Toasts can be dismissed.
- Stubbing a long item quotes its opening passage instead of starting from an empty quote line that the preview reported as an error.
- The composer counts a thread's characters without the fragment limit, and a compose-list row that only quotes or links shows what it quotes.
- **Migrations: 0023_subscription_title_source.sql.** Adds `subscriptions.title_auto`. Apply before deploying.

## 0.29.0 — 2026-10-05

- **The `[[` / `![[` picker is a panel with real search.** It searched only a 70-character excerpt and the id, so on a node with ~1,400 candidates almost nothing was findable. `GET /api/search` now matches every word anywhere in an item's text, in SQL, with `source=all|mine|imported`, `sub=<subscription>`, `sort=newest|oldest`, paging and a total; rows gain `source`, `kind`, `subscription_id` and `source_title` (`badge` is kept for older clients). What it offers is unchanged: only what publish will accept.
- The picker opens as a non-modal panel at the right (docked at the bottom on a phone, with the draft scrolled into view above it): link or quote named in its header, a source radio, sort, a subscription menu under *imported*, and rows with excerpt, source, kind, age and version. Where you type to search is a new setting, Settings → writing: *automatic* (the default) keeps typing in the editor with a mouse and gives the picker its own search box on a touch screen, where it fills the screen until you pick or cancel; or always *the editor*; or always *the picker*. Source and sort are remembered per device.
- The reading list's swipe hint is hidden on mouse devices (#36, Aneesh Sathe).
- Migrations: none.

## 0.28.3 — 2026-10-05

- **Feed polling and Webmentions work again.** 0.28.0's outbound DNS check called `fetch` with `redirect: 'error'`, which the Workers runtime rejects outright, so on a deployed node every check threw: every subscription poll failed, outgoing mentions stayed queued and incoming ones went unverified. The tests stubbed `fetch` and accepted the mode. The check now uses `redirect: 'manual'` and still fails closed on anything but a 200; a new test refuses `'error'` the way the edge does. Polls, queued mentions and verification resume on their own at the next cron tick after upgrading.
- Migrations: none.

## 0.28.2 — 2026-10-05

- A thread's published `content_html` bakes each transcluded item's HTML verbatim again, as §5.2 and §10.2 specify. 0.28.0 ran the bake through the import sanitizer, which put sanitizer output into the protocol bytes other origins import. Sanitizing stays at every render instead: the public thread pages and version history already sanitize the stored HTML, and the editor's transclusion preview now sanitizes its own output. Threads published under 0.28.0–0.28.1 keep their bytes (published versions are immutable).
- The client access page described a password change as revoking every client authorization. Since 0.28.0 it only logs out Studio sessions; rotating the cookie secret is what revokes them. The page now says so.
- Migrations: none.

## 0.28.1 — 2026-10-05

- Imported HTML keeps the content of tags the 0.28.0 allowlist does not name. 0.28.0 deleted them together with everything inside, so an image inside `<picture>` (Substack's feed markup), text inside `<font>` and `<video>` fallback text all vanished from reading views and transclusion bakes. Unlisted tags are now unwrapped. Active, foreign and raw-text elements (`script`, `style`, `textarea`, `noscript`, `svg`, `math`, `iframe` and the like) are still dropped whole, because unwrapping their content would turn it into live markup.
- Migrations: none.

## 0.28.0 — 2026-10-05

- Bound owner/per-grant REST/MCP work, delegated aggregate work, AI calls with an owner reserve, anonymous client storage and request bodies (migration 0022). Reclaim abandoned unapproved registrations after a configurable grace.
- Keep unused draft uploads private with authenticated no-store previews; published media keeps serving the same bytes through later versions and withdrawal (§5.4). Choosing the avatar needs `owner:publish`. Stub and fork citation links accept only http(s), on write and on render; author links accept http(s) or mailto, and `site_url` only http(s), with stored rows filtered on read. Sanitize remote transclusion bakes and legacy displays, and validate/escape attribution links.
- Check revocation during refresh-token introspection and atomic grant recording. Show full native callback destinations on consent and suppress remote fetch exception text.
- Restrict outbound fetches to public destinations unless explicitly enabled for LAN use; cap streamed bodies and recheck redirects. DNS rebinding remains a deployment gap.
- Sanitize imported editorial HTML at private/public rendering boundaries, prevent stale draft deletion after publication, and patch quadratic Markdown linkification.

**Migrations: 0021_oauth.sql, 0022_security_budgets.sql.** Apply after 0.27.0's 0020. Adds OAuth provider tables, a shared rate limiter,
client authorizations, and revocation state. Enable `nodejs_compat` before deployment.

- Upgrade compatibility: existing owner login cookies are invalidated once. Log in
  again after upgrading. SDK 0.2.0 owner clients must replace a plain `auth` string
  with `headers.Cookie` or a scheme-specific auth callback; bearer clients also use
  a scheme-specific callback. Protected routes require HTTPS except on loopback.
- Clients can use scoped OAuth grants or named manual bearer tokens for REST and MCP.
  The owner approves permissions and manages grants from Studio's Client access page.
- MCP exposes the existing API operations with the same scope checks. The generated
  JavaScript SDK supports owner cookies and bearer tokens in browsers and Node.js.
- Refresh replay, signing-secret changes, and explicit revocation invalidate grants.
  Owner-password reset invalidates browser sessions and preserves delegated tokens.
  Native refresh cleanup can also invalidate another grant's refresh token for the
  same client and owner. Other grants' access tokens retain their own revocation state.
- Mounted discovery is available. Host-root `.well-known` routes remain deferred.
- Security oracles include source-linked laws, model checks, browser probes, a
  controlled two-isolate race, and mutations that verify the enforcement checks.

---

## 0.27.2 — 2026-10-05

**Migrations: none.** `/api` change, additive: `POST /api/items/{id}/generate`
also returns `content_md`, the whole working copy with the scope's new output
spliced in, as saved.

**Generating a TK scope no longer throws away the rest of the draft.** Since
0.10.0, pressing *generate* in the editor replaced the whole draft with just
the scope's output. The server had spliced and saved the full text correctly,
but the editor then autosaved its truncated copy over it. The editor now uses
the returned `content_md`. The studio keeps no history of draft saves, so text
lost this way can come back only from a published version: if the post had
been published before the generate, *discard changes* (or restoring from its
history) brings back the published text. An unpublished draft's surrounding
text is gone.

---

## 0.27.1 — 2026-10-05

**Migrations: none.** The same program as 0.27.0, released.

The release workflow had failed on every tag since 0.21.2, so 0.21.2 through
0.27.0 have no release downloads. The cause was two problems in the test
plumbing, not in what ships. A browser test wrote a screenshot to a path that
exists only on the maintainer's machine. And since 0.26.0, the mutation check
built its temporary tree without `build/models.json`. Both are fixed. Operators
upgrading by tag should take this release; the notes for 0.21.2 to 0.27.0
below still describe what changed.

---

## 0.27.0 — 2026-10-05

**Migrations: 0020** (`items.highlight_override`, nullable). Apply it before
deploying. `/api` changes, both additive: settings gain
`highlight_generated_default`, and items gain `highlight`
(`default` | `show` | `hide`) on read and on `PATCH /api/items/{id}`.

**Highlight generated portions on public pages.**

- **Setting.** Settings → theme has a checkbox: *Highlight generated portions
  by default*. It is off by default, so upgrading changes nothing anyone sees.
- **Look.** When it's on, text written by `[TK]` generation (`blyg-tk-gen`)
  shows in a lightly tinted box with a thin outline. A generated block wears a
  small robot badge on its bottom-left edge, following Brady Dale's convention
  on bradydale.com, and an inline span gets the robot before its first word.
- **Themes.** Every theme names its own tint and outline colour (`genBg`,
  `genRule`), and the automatic light and dark defaults have their own pair.
- **Per post.** A post can override the default from its editor's TK card:
  default, on or off.
- **Presentation only.** The default lives in `style.css`, and a post's own
  choice is a `gen-on` or `gen-off` class on its `<article>`. `content_html`,
  the item document and the feed are unchanged.

**The robot says what the author disclosed.** Hover over the robot badge, or
tap or click it, and a small box opens. It says the author marked the text as
machine-generated, and that this is self-reported and not verified. Under that
it lists the model or models, when the text was generated, and how many of the
blyg's own items it drew on, all taken from the version's `generated[]`.

- **Version-level details.** The details cover the whole version, as §5.7
  does, so a post with several generated passages says the details cover all
  of them.
- **Quoted text.** A generated span inside a quoted item points to that item
  instead.
- **Version carousel.** It carries each version's disclosure along with its
  text, so the box stays accurate after a swap.
- **Mechanics.** The box is one fixed-position element per page, so a feed
  card can't clip it. Escape or a click elsewhere closes it. With scripts off,
  the robot is still drawn, it just doesn't open anything.

---

## 0.26.1 — 2026-10-04

**Migrations: none.** `POST /api/subscriptions` with `confirm: true` now replies
before the initial backfill finishes, so the subscription it returns has not
been polled yet.

**Subscribing no longer hangs on confirm.**

- Confirming a subscription used to copy the source's whole archive, one item at
  a time, before replying. On a large blyg the button sat there for a long time
  and gave no sign that anything was happening. The archive is now copied in the
  background, and its items show up in reading as they arrive. If the copy is
  cut short, the next scheduled poll (within 15 minutes) finishes it.
- The sheet's buttons say `checking…` and `subscribing…` while they wait, and
  the sheet closes as soon as the subscription exists.

**Reading opens on the feed.** Feed and Sources are peer tabs at the top of
reading, where `← sources` used to be: `/reading` is now every source's
timeline, and the sources list moved to `/reading?view=sources` (`/subs` still
redirects there). Every reading screen has the same head under every lens:
the tabs, a title with its count, its own actions and ＋ subscribe. Before,
Background and Smart Feed dropped the back link and the count, so the page
jumped when you switched to them, and ＋ was only on the sources list.

**Subscribing twice to the same source is refused.** A second subscription
imported every item again, and a stub of any of those items then failed with
"ambiguous id imported from multiple sources". `POST /api/subscriptions` now
answers 409 `already subscribed to …` on both the first step and the confirm
step, matching on the resolved origin or feed URL (so a blyg's `feed.xml` added
as plain RSS counts too). This does not remove duplicates a node already has:
delete the extra one from its source inspector.

**The Smart Feed lens says "Coming soon."** It is a placeholder, and it read
as if it worked.

**Every reading card shows where it lives.** A muted citation line under the
body (`↗ host/path`, shortened the way the ⋯ sheet shows it) opens the entry's
source in a new tab. It appears on every card that has a URL, in every
timeline and on the hopper page. Before this, the link was only in the ⋯ sheet,
or on the title when the entry opened with a heading.

---

## 0.26.0 — 2026-10-04

**Migrations: none.** `/api` changes, all additive: settings gain `ai_model_tk`,
`ai_model_changelog`, `ai_model_feed` and `feed_prompt`; new `GET /api/ai/models`.
`ai_model` still works for one release: it reads as the TK model, and writing it
sets both the TK and changelog models.

**A model for each AI function, from three providers.**

- **Settings → AI models** has a model picker per function: TK generation,
  changelog notes and feed scoring, plus a disabled *authoring* row reserved
  for agentic authoring. Your existing model carries over to the first two.
- **The list comes from `models.json`**, which you can edit. Put your changes
  in a gitignored `models.local.json` (same shape) so `npm run upgrade` never
  conflicts, then redeploy. *other…* takes any model id; its provider is
  inferred from the prefix (`claude-`, `gpt-`, `gemini-`). Prebuilt release
  workers carry the shipped list only.
- **Anthropic, OpenAI and Google models all work**, each called directly over
  HTTP like the existing Anthropic call. Set the key for each provider you use:
  `AI_PROVIDER_KEY` (Anthropic), `OPENAI_API_KEY` or `GOOGLE_AI_KEY`. Settings
  shows which keys are set, never their values.
- **Smart feed prompt:** Settings gains a prompt for the future Smart Feed,
  a rubric your AI agent will score new items against. It is saved now and not
  yet used; the agent that reads it, with your signals, is still to be designed.

Shipped list (checked against each provider's model page 2026-10-04): Claude
Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5; GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna;
Gemini 3.1 Pro (preview), Gemini 3.8 Flash, Gemini 3.1 Flash-Lite.

Protocol: implements 0.3, unchanged. `generated[].model` was always free text,
so a non-Anthropic model id is valid on the wire as it stands.

---

## 0.25.0 — 2026-10-04

**Migrations: 0019** (the `interactions` table, with a backfill). Apply it before
deploying: `npx wrangler d1 migrations apply DB --remote`. `/api` changes, all
additive: `GET /api/reading` takes `kind=thread|fragment`; new `GET /api/interactions`
(paged, filterable by `kind`) and `GET /api/thumbs`.

**Scaffolding for better reading.** This release telegraphs where reading is
going: a feed your own AI agent sorts and filters from a prompt you write. The
agent is not designed or built yet. What ships is the record it will need.

- **Reading lenses.** Every reading screen has a lens bar: All, Threads,
  Fragments, Background and Smart Feed. Threads and Fragments filter whatever is
  open, a source, a hopper or everything, and the sources list counts follow the
  lens. Background and Smart Feed are placeholders, marked with dashed outlines:
  Background is for procedural staleness updates once the `ignyr` changelog
  directive is designed into the protocol; Smart Feed is for the agent-ranked feed.
- **Interaction log.** A private, append-only record of what you do with other
  people's items: thumbs up, down and cleared, hopper adds and removals, and the
  stubs, forks and quotes you publish. Each act is logged when it becomes real on
  the server, never on a click you abandon, and is keyed by origin and id so it
  survives an unsubscribe. The migration backfills it from current thumbs, hopper
  memberships and your published versions. It is never published.
- **more → signals.** Your current likes and dislikes, and the activity log,
  newest first.

Protocol: implements 0.3, unchanged. Nothing in this release is on the wire
(decisions #11 and #12: AI, identity and editorial convenience never are).

---

## 0.24.0 — 2026-10-04

**Migrations: 0018** (adds `hoppers.description`). Apply it before deploying:
`npx wrangler d1 migrations apply DB --remote`. `/api` change: hoppers gain
`description`, and `PATCH /api/hoppers/{id}` accepts it (an empty string clears it).

**Public hoppers are now findable.** A public hopper has had its own page since
v0.2, but nothing on the site linked to it.

- **Collections:** the homepage and archive list your public hoppers, each with
  its item count and description. A hopper never appears in your feed, as before
  (decision #12).
- **The hopper page wears the site's header and masthead**, says how many items
  it holds from how many sources, and carries a description, title and social
  metadata like every other public page.
- **Fixed:** the page's "Home" link pointed at the host root, which on a
  path-mounted blyg is not the blyg.
- **Description:** each hopper takes an optional one-line description in its
  settings, shown on the public page and in Collections.

Protocol: implements 0.3, unchanged.

---

## 0.23.0 — 2026-10-04

**Migrations: none.** `/api` change: `GET /api/freshness` entries gain `behind`, and the
list now comes stalest first. Additive; regenerate the SDK if you use it.

**Stale quotes move out of compose into a new *updates* tab.**

- The warning banner at the top of compose is gone. It listed every thread
  whose quotes had fallen behind, which read as a to-do list, and acting on
  each alert as it came would publish a flood of trivial versions.
- **updates** sits after *mentions* in the tab bar. It lists the same threads,
  stalest first, each with how far behind it is: "4 versions behind · 2 stale
  quotes", and "needs editing" when a republish would fail.
- Staleness is the versions a thread's stale quotes have missed, summed. One
  quote three versions behind and another one behind make a thread four behind.
- The page states the norm it is built for: refresh items in batches, stalest
  first, when they have drifted far enough, rather than one version per alert.
  The same ordered queue is meant for a future maintenance agent.

Protocol: implements 0.3, unchanged.

---

## 0.22.0 — 2026-10-04

**Migrations: none. No API, contract or data changes** — this release touches
the studio's front end and the static files the Worker serves for it.

**The studio is redesigned for the phone**, after the owner console of
aneeshsathe.com ("Thicket Console"): a top bar, a bottom tab bar (a left rail
on wide screens), cards, pill controls and bottom sheets. Every existing
control and confirmation keeps its wording.

- **It wears your theme.** The reading theme in Settings now paints the studio
  as well as the public pages — one setting, the same six themes plus Auto.
- **Five tabs:** reading, compose, hoppers, mentions, more. *More* holds
  settings, syntax, the public page, log out, and the update notices.
- **Reading works like NetNewsWire:** a list of sources (all, my blyg, your
  hoppers, every subscription with its status and count) opens into each
  source's timeline. A source's ⓘ panel pauses, resyncs, lists in the
  blogroll or deletes it — `/subs` now redirects to reading. Entries keep every
  action; the rarer ones live under ⋯. Select text in an entry and a *quote
  selection* button appears. Swipe a source ← for its panel, → to pause;
  swipe an entry → for 👍, ← to stub.
- **Compose and the editor:** filters over your items (drafts, unpublished
  changes, public, withdrawn); rows that expand to quick edit and act; a
  *published* banner with **copy + link** (the text plus its permalink, for
  pasting into other apps) and **share…**; on phones the editor swaps between
  draft and preview, with its actions in a bottom bar.
- **New writing tools, all in the browser:** *link from clipboard* strips
  tracking parameters and links the selected words; pasting a URL over
  selected text links it; *scan text* points you at your phone's own text
  scanning (iPhone: long-press → Scan Text; Android: the keyboard's scan or Lens
  button, or Google Lens). An **optional**, per-device setting adds on-device
  photo scanning with Tesseract.js, loaded from jsDelivr only when used.
- **Every browser `confirm`/`prompt`/`alert` is now an in-app sheet.**
- **Installable:** a web app manifest and a service worker that caches only the
  app shell (never `/api`), so the studio can live on a phone's home screen.

---

## 0.21.2 — 2026-10-04

**Migrations: none.**

**Five fixes found by the conformance toolkit** (blygger-spec#11, by Aneesh
Sathe), each reproduced on 0.21.0.

- **A feed that drops every new entry no longer strands a reader** (#27). Any
  gap in the feed window now triggers the index diff, as §13.2 says. Before,
  the reader also needed a new entry in the feed, and otherwise stayed stale
  until the daily sync.
- **A stub's version agreement matches its target by origin as well as id**
  (#28). A local item sharing a remote target's id could overwrite
  `stub_of.version` with its own version.
- **Forking an older client's thread keeps the author's own `>` lines** (#29).
  Lines after a quote directive are treated as an attached excerpt only when
  the pinned bake is marked partial.
- **A fork of a remote pin cites the pinned page when the origin serves one**
  (#30), as a fork of our own pin already did. The JSON file stays the
  citation when there is no page, since pinned pages are optional (§8.4).
  Existing forks keep the citation frozen when they were made.
- **`feed.xml` carries `<dc:creator>`** when the author name is set (#31,
  §7's SHOULD).

Protocol: implements 0.3, unchanged.

---

## 0.21.1 — 2026-10-04

**Migrations: none.**

**Blyg feeds subscribe in strict RSS readers.** Contributed by akashtattva (#33).

- `feed.xml` renders in a fixed number of database queries instead of several
  per item. Live feeds were slow enough that some readers timed out and called
  them invalid.
- Public pages advertise the feed with an absolute URL and the blyg's title, so
  pasting a blyg's address into a reader finds it.
- The feed carries an `atom:link rel="self"`, and its `<description>` falls back
  to the site title when the bio is empty.
- The feed and the public pages now share one loader for quote provenance, so
  they cannot disagree about whose quote a blockquote is.

Protocol: implements 0.3, unchanged.

---

## 0.21.0 — 2026-10-03

**Migrations: none.**

**Every changelog note is confirmed before a new version publishes**, and the
studio can write one for you.

- When you publish version 2 or later with a note, a *Version N* dialog shows
  the note under **Change** for a last edit, with **Confirm** and **Cancel**.
  This happens whether you typed the note, made it with *draft note*, or let
  the studio draft it. **Cancel** publishes nothing.
- A new setting, **Automatically generate changelog notes when publishing a new
  version** (Settings, under the AI model; off by default because it uses your
  AI key), drafts a note from the change whenever you publish with the note
  field empty. You see the draft in the same dialog before anything is
  published.
- A note confirmed exactly as the model drafted it is marked
  `"generated": true` in the changelog (§16.6c). Once you edit it, the words
  are yours and carry no mark.
- Version 1 never asks, since there's no earlier version to describe. With the
  setting off and an empty note, publishing works as before, with no dialog.
- The dialog covers every way to publish a new version of an existing item:
  the full editor, quick edit, and *publish*/*republish* in the item list.

## 0.20.2 — 2026-10-03

**Migrations: none.**

- **The feed can no longer be broken by a pasted character** (studio#15, part 3).
  Characters XML 1.0 forbids (C0 controls other than tab and newline, U+FFFE and
  U+FFFF, and unpaired surrogates) used to pass straight into `feed.xml`. One of
  them makes most feed readers reject the *whole* feed. They are now filtered
  wherever the feed is written. Publish also strips them, along with this
  client's internal marker characters, from the published text; your working
  copy keeps what you typed.
- **Excerpts never cut a character in half** (studio#15, part 2). Feed titles,
  citation excerpts and card previews used to be able to end in half an emoji,
  which readers show as �. Truncation now cuts between whole characters.
  Charset-aware imports (part 1) are still open.
- **`npm test` passes on an operator's install** (studio#1). Two tests asserted
  that `wrangler.jsonc` was still the shipped template, so every correctly
  configured install failed them. That check now runs only in this repository's
  CI (`npm run check:template`).
- **Local migrations have a reserved range** (studio#10). Number your own
  migrations from `9000_`; upstream will never use `9000_`–`9999_`. See the
  README section "If you fork this". CI enforces the range on this repository.

## 0.20.1 — 2026-10-03

**Migrations: none.**

- **A `![[id]]` left on its own line in TK output becomes a quote at publish
  again.** This is a provisional ruling (session 33): the protocol notes read
  it as a real transclusion, and 0.17.0's change that made it inert (studio#5)
  is reverted until the spec settles it. Code stays exempt (§10.1).
- **"TK transcludes are not yet implemented"** replaces "unresolvable source"
  when a `[TK]` scope names an imported item or a thread. Those ids are valid;
  using them as generation sources arrives with remote generation sources
  (decision #44). A draft, a withdrawn item, or an unknown id still gets an
  "unresolvable source" error that says why.

## 0.20.0 — 2026-10-03

**Migrations: none.**

**A fork starts from the pinned document, not from its directives** (decision
#57, spec §16.6f). Forking a thread used to copy its `![[id]]` directives,
which then resolved again in *your* blyg when you published. You could get a
later version of a quote, a publish failure for a source you don't subscribe
to, or quote-mentions sent to other people on your behalf. Now:

- Your fork's own prose is copied exactly. Each quote becomes an ordinary,
  editable blockquote of the text the pinned version baked, closed by a
  *quoted from* line that links the quoted item. Nested quotes become nested
  blockquotes, and a partial quote keeps its passage.
- The fork inherits no `transclusions[]` and sends no quote-mentions. If you
  want a live quote, write the `![[id]]` yourself.
- Generated text stays disclosed. It comes back as `[TK]impyrt=…[/TK]`, with
  the model where the source recorded one, so the fork republishes it as
  generated. This also fixes fragment forks, which dropped `generated[]`
  before.
- If the source's markdown and its pinned HTML don't line up, the fork is
  rebuilt entirely from the pinned HTML. Exact prose gives way before a
  disclosure does.



**Migrations: none.**

- **The composer autosaves** (studio#23), like the full editor. Before this,
  text typed on the home page reached the server only through *save draft*,
  *publish*, *Full Editor* or an in-app navigation, so a crashed tab or a closed
  laptop lost it. The first save, which creates the draft, waits for a
  three-second pause and at least eight characters, so a stray keystroke
  doesn't leave an empty item behind. After that, edits save 400 ms after you
  stop typing.
- **Image alt text keeps escaped characters** (studio#6). `![a \* b](…)` now gets
  `alt="a * b"`, the same as the text outside an image. Before this the escape
  disappeared, because markdown-it 14 represents escapes and entities as a token
  type the default image renderer skipped.



**Migrations: apply `0017_imported_lineage.sql`.** It adds two nullable columns
to `imported_items` and changes no stored values.

**Imports keep what an item answers and descends from** (studio#12). The
importer used to keep a subscribed item's `transclusions` but drop its
`stub_of` and `forked_from`. Both are now stored verbatim, including their
`cited` citations, and exposed on imported items (`stub_of_json`,
`forked_from_json`). A reader can show lineage from local data without
re-fetching each document, and a citation now survives import on another node.
Rows imported earlier fill in when their origin next publishes a version.

**Responses to plain web pages say what they answer** (decision #55, spec
§16.1a). A stub of a feed entry used to cite only the host
(`simonwillison.net`). It now records the feed's name as `source` and the
entry's title as `excerpt`, frozen when the stub is made, as §5.9 specifies for
`stub_of`. Through the API, `PATCH /items/{id}` accepts `cited` on a `{url}`
stub: `retrieved` is required, and `excerpt` is clamped near 200 characters.



**Migrations: none.**

**The bracket and TK grammar now apply only where they should.** Five reports
from studio issues, all in the same code that turns `[[id]]`, `![[id]]` and
`[TK]` into HTML:

- **Code is plain text** (#4; spec §10.1, decision #54). `![[id]]`, `[[id]]`
  and `[TK]…[/TK]` inside a code span or a code block (fenced with ``` or ~~~,
  indented, or inside a list item) are no longer transcluded, linked or treated
  as generation scopes. You can write about the syntax in a blyg, and an example
  id in code no longer fails publish. Code blocks are found with the same
  markdown parser that renders the text, so the two always agree.
- **Inside generated text, `![[id]]` is never a quote** (#5, decision #20). An
  own-line `![[id]]` inside TK output that spans several lines, or inside
  hand-written output, is no longer transcluded or sent a mention.
- **Links never nest** (#13). `[see [[id]]](url)` becomes one anchor whose text
  is the target's label. In an autolink or a bare URL, your `[[id]]` stays part
  of the URL. In an image's alt text it stays literal.
- **The preview resolves links inside generated blocks the way publish does**
  (#14). An unknown id there is now reported in the preview instead of failing
  only at publish.
- **No internal marker characters reach the HTML** (#3). Generated text that
  linkify absorbs into a URL, or that sits in image alt text, now appears as
  plain text. The item's `generated[]` still discloses it.



**Migrations: apply `0016_media_inline.sql`.** It adds `media.inline` and marks
existing images that are already referenced in their item's text as inline.

**No built-in AI model.** This matters only if you have set the
`AI_PROVIDER_KEY` Worker secret (without it, generation has never run and
still reports the missing key). If you set a key and left Settings' model field
blank, generation used to fall back to Claude Opus 5, billed to your key. Now
*generate* and *draft note* ask you to choose one instead (for example
`claude-sonnet-5-5`). Which model you pay for is your decision, so the package
no longer makes it.

**Images belong to the text they are in** (studio#24, and Venkat's report).

- An image uploaded in the Studio is placed in the text and now appears only
  there. Before this it also appeared again at the bottom of the post, and
  stayed on the page after you deleted its line. Deleting the line now removes
  it from the page, the feed and the item's `media` list.
- Images uploaded by other tools through `POST /api/media` are not placed in the
  text, so they are still shown below the post.
- **Removing an attachment.** The editor's attachments list says where each image
  stands (in the text, not shown, or shown below the post), and any image not in
  the text has *remove* (`DELETE /api/media/{id}`). Files that a published
  version still shows are kept, because a media URL must keep serving the same
  bytes (§5.4); the image only leaves the item. Files nothing published shows
  are deleted.
- **Leaving the page while an image is uploading now asks first.** Leaving
  mid-upload saved the "uploading…" placeholder into the draft and left the
  image at the bottom of the page. Any such placeholder left from an abandoned
  page is removed when the editor opens.

**The full editor fills the window.** The draft field used to be a fixed height
inside a pane that stretched to the preview's length, which left the lower half
blank. It now takes the whole pane, and on a desktop the panes start at most of
the window's height.

**`$` in generated text and headings publishes as written** (studio#2). Two
splices used string replacements, so `$&`, `` $` ``, `$'` and `$$` were expanded
as patterns. Both now insert the text verbatim.



**Migrations: none.**

**History for what you read** (decision #40, the reader half). An entry from a
blyg subscription in *reading* now has a *history* toggle. It shows the item's
changelog, read from its origin when you open it: every version's note and
date, which versions are pinned, and which notes the publisher's studio drafted
(`changelog[].generated`).

*See the change* shows a word diff of the markdown between two versions. It is
offered only between versions the origin serves publicly: adjacent pins, and
the last pin against the current version. An unpinned version's text is
withheld at its source (§5.2), and nothing here offers or attempts it.

API: `GET /imports/{sub}/{id}/history` and `GET /imports/{sub}/{id}/versions/{v}`,
both fetched from the origin on demand. The diff is a small dependency-free
word diff (`src/word-diff.ts`) that aligns paragraphs before words, so a long
thread does not become a quadratic comparison.

## 0.14.0 — 2026-10-03

**Migrations: apply `0015_note_generated.sql`.** It adds one column with a
default of 0 and changes no stored values.

**The studio can draft a version's changelog note** (decision #40, spec §16.6c).
In the editor, *draft note* describes the change between the published version
and your working copy. The draft goes into the note field, and you can keep it,
edit it, or replace it before publishing.

- **The depth rule is enforced, not just requested.** When the previous version is
  unpinned, its text is private, so a note may describe the change but must not
  quote that text (§5.2). The prompt says so, and the studio also checks the
  result: a draft that reproduces six or more consecutive words found only in the
  previous version is refused. Between two pinned versions nothing is withheld,
  so the check does not apply.
- **A note you publish unedited is marked `"generated": true` in the changelog.**
  Once you edit it, the words are yours and carry no mark. History in the editor
  shows a *generated* chip on such notes.
- Drafting happens before publish and never inside it, so publishing still needs
  no network. Drafting uses the model and key configured for TK generation.
- **Fixed:** the editor's note field now clears after a publish. Before this, the
  previous note stayed in the field and was sent again with the next publish.

## 0.13.0 — 2026-10-03

**Migrations: none.**

**Text generated somewhere else can be disclosed as generated** (decision #37,
spec §5.7 rule 7). Paste the text, select it in the editor, and click *mark
selection as generated*. You can also type the wrap yourself:

```
[TK]impyrt=the pasted text[/TK]
[TK]impyrt claude-opus-5=the pasted text[/TK]
```

The text publishes as written, in a `blyg-tk-gen` span, with a `generated[]`
entry whose `sources` is empty ("no sources declared"). `model` appears only if
you wrote one, and there is never an `at`: the studio cannot know when someone
else's model produced the text. There is no "external" marker, because the
claim is that the prose is machine-generated, not where the model ran.

An `impyrt` scope's provenance comes from its own grammar, not from the
position-indexed record that generated scopes use. So adding or reordering other
scopes cannot move its disclosure onto the wrong span. It is never regenerated,
and a `![[id]]` inside it is not read as a source reference.

## 0.12.0 — 2026-10-03

**Migrations: none.**

**Stale quotes are visible, and one click refreshes them.** A thread bakes each
quote at the version it held when it published. When the quoted item changes
later, the thread keeps the old words, which is correct (§10.4). Until now
nothing told you it had happened.

- **Compose** lists every published thread whose quotes are behind, with links.
- **The thread editor** has a *quoted snapshots* panel. Each quote shows the
  version baked and the version now available. For a quote from another blyg,
  the panel asks that blyg directly for its current version (decision #33).
  A quote can also be shown as unable to refresh: the source was withdrawn, or
  an excerpt's passage is gone from the new version.
- **Refresh** republishes the thread with the same words and new quotes. A quote
  whose source is ahead of your import resyncs that subscription first. The new
  version's `content_hash` is unchanged, so readers can tell a re-bake from an
  edit (#38). The thread gets a new feed entry, and the sources whose version
  changed get mentions. Refresh is never automatic.
- Refresh refuses when the working copy has unpublished edits. It also refuses
  when republishing would drop a generated-text disclosure that the published
  version carried.

API: `GET /freshness`, `GET /items/{id}/freshness`, `POST /items/{id}/refresh`
(see `docs/api.md` § Quote freshness). The publish handler and refresh share one
code path, so a refresh runs the same lineage check and error mapping.

## 0.11.1 — 2026-10-03

**Migrations: apply `0014_public_page_indexes.sql` after the earlier migrations.**

The public homepage loads published card content, pin numbers, images, and
citation sources in batches. It reuses the avatar and newest published content
for page metadata. Pin links on other public pages now read only pin numbers,
not entire version histories. The rendered HTML and public protocol stay the same.

Indexes support the public item order, pinned versions, item media, and legacy
citation source lookups. The migration changes no stored values. Regression
checks bound query count and rows read with large histories and unrelated data.

## 0.11.0 — 2026-10-02

**Migrations: none from 0.10.0. From 0.8.x, apply `0013_signal_poll_index.sql`
(added in 0.10.0).** Upgrading from 0.8.x or earlier? Read
**[docs/upgrading-to-0.11.md](docs/upgrading-to-0.11.md)** first: it covers
both upgrade paths, path-mounted blygs, how to check the result, rollback,
and the API changes third-party tools need.

Implements protocol 0.3. Public pages, feeds, item documents and the static
export stay compatible with every other blyg.

### If you are coming from 0.8.x: what 0.9 and 0.10 changed

0.9.0 and 0.10.0 were contributed by **Kyle Mathews**
([#21](https://github.com/blygger/blygger-studio/pull/21),
[#22](https://github.com/blygger/blygger-studio/pull/22)), the largest change to
this client since it was split out of `blygger-spec`.

- **The Studio is a React app.** Compose, the editors, reading, subscriptions,
  hoppers, mentions and settings were rebuilt with React, TanStack Router and
  DB, and Base UI. The layout, themes and features are the ones you know. Views
  refresh every 15 seconds while open. The old server-rendered Studio and its
  inline scripts are gone. **Source installs now have a build step.** `npm
  install` runs it, and so do the `deploy` scripts.
- **Saving is safer.** A failed save keeps what you typed, instead of reloading
  the stored draft over it. Publishing waits for the save, autosaves no longer
  overlap, and leaving the editor saves first, staying put if the save fails.
- **`/api` is a documented, validated contract.** 39 operations, defined once
  and published as OpenAPI 3.1 (`/api/openapi.json` for a signed-in owner), with
  a generated JavaScript/TypeScript SDK that runs in browsers, Node and Workers.
  Routes are resource-shaped: POST creates, PATCH edits only the fields you
  send, PUT pins. Bodies are validated strictly. **Several pre-0.9 routes were
  removed with no aliases**; the upgrade guide has the old-to-new table. Auth is
  unchanged: one owner session cookie.
- **Releases carry downloads.** Each GitHub release has a Worker archive with
  migrations built in, so you can deploy with no build, plus the OpenAPI file,
  the SDK package, a manifest and SHA-256 checksums.
- **Tests.** Browser tests on desktop and mobile Chromium (126 now), API
  property tests against independent models, upgrade tests that run the real
  0.8.3 `npm run upgrade`, and checks on the extracted release downloads.

### New in 0.11.0

- **Images resolve correctly between blygs.** Studio published image paths like
  `/blyg/media/x.png` inside an item's `content_html`. A subscriber imported that
  HTML and resolved the path against its own host, so the image was broken in
  their reading feed and in any thread that quoted it. The RSS feed was already
  correct, because §7 requires absolute URLs there. Now:
  - publishing writes absolute URLs into `content_html`, as `[[id]]` links already
    did (§16.2). The markdown source is untouched;
  - importing resolves a fetched item's relative URLs against the source blyg;
  - a quoted snapshot is resolved against its own blyg before it is baked into a
    thread, so it can never be pointed at yours;
  - items already imported are repaired in the background, up to 200 per poll.
  Versions published before 0.11.0 keep their old HTML, because published
  versions are frozen. Subscribers on 0.11.0 repair them on their side.
- **Thread cards on the public feed show the thread.** A card used to be a
  plain-text excerpt with the "thread" label run into the first sentence. It now
  shows the top of the thread's own page, with the same formatting, quotes and
  their provenance lines, and indentation, cut at a fixed height with a fade.
  "THREAD · 2 quoted" is its own label line. Titles, link previews, RSS
  headlines and archive rows still name a thread in its author's own words.
- **Insert an image anywhere while writing.** In both the composer and the
  editor:
  - the attach button inserts at the cursor instead of at the end;
  - typing `/image` on a line by itself opens the picker for that spot;
  - you can paste or drop an image.
  A placeholder holds the spot while the upload runs. `/image` is handled in the
  editor and never reaches the stored text.
- **Releases are cut from tags.** A `v{version}` tag starts the release
  workflow; merging to `main` no longer does, despite what 0.9.0 says below.
- Fixed two start-up races in the browser test harness that failed CI
  intermittently.

## 0.10.0 — 2026-10-01

**Migrations: apply `0013_signal_poll_index.sql`.**

Studio is now a React SPA with TanStack Router, TanStack DB, and Base UI.
Route loaders preload SDK reads. Active views poll the D1-backed API every
15 seconds, pause in hidden tabs, and refresh on focus. Reading loads 25 entries
at a time. Saves stay ordered, failed writes keep local edits, and navigation
waits for pending draft saves. Cached reads never replace unsaved editor text.

The UI keeps the existing themes, navigation, authoring, reading, subscriptions,
hoppers, mentions, settings, history, uploads, bracket search, and TK controls.
Mounted installations load assets within `{mount}/studio/`. The Worker embeds
the assets, so downloaded Worker installations need no extra binding or build.
All old Studio renderers, inline scripts, and SDK compatibility adapters are
removed. Public pages, protocol output, and subscription cron remain unchanged.

Item lists now include optional pinned-version references without loading
history bodies. A signal-order index reduces repeated scans during polling.
SDK 0.1.1 includes this additive response field. CI covers
SPA state, desktop/mobile browser flows, mounted forwarding, draft recovery,
API oracles, source upgrades, and extracted release downloads.

## 0.9.0 — 2026-09-30

**Migrations: none.**

Studio reads and writes through an authenticated OpenAPI Hono API and a
Hey API-generated JavaScript/TypeScript SDK. The existing UI keeps its layout,
and public Blygger protocol output keeps its behavior. Reading batches page bodies, and item
reads keep D1 query counts bounded. The owner API uses resource routes, strict
Zod request validation, boolean preferences, structured item references, and
offset pagination. Partial edits validate before an atomic write. Replaced
private routes are removed, and Studio uses the new routes throughout.
Empty threads retain correct pinned links. Long version histories no longer
share one D1 result row. Reads tolerate malformed stored JSON without changing
it. Mentions page beyond their old caps, and hopper previews load three bodies.
Dependency installation builds the SDK for upgrades from 0.8.3.

Merges to main now publish GitHub releases automatically. Downloads include the
OpenAPI spec, a Worker bundle with migrations and generic deployment config,
and an installable SDK package. A manifest and SHA-256 checksums accompany them.
CI checks versions, contracts, SDK generation, Worker behavior, browser flows,
and extracted release artifacts before publication.

Editors serialize saves and retain current text when a save fails. Publishing
stops after a failed save. A response for older text cannot reload over newer
edits. Independent lifecycle, pagination, and PATCH oracles protect the owner
API, with SDK, browser recovery, mounted routing, and upgrade tests in CI.
Release checks install the SDK in Node and browser projects and verify its
TypeScript declarations. Native generator settings emit Node-compatible imports.
Mutation controls check the production path. Restart tests check persisted
D1/R2 state, and response-loss tests cover committed writes.

## 0.8.3 — 2026-09-29

**Migrations: none.**

**A blyg no longer titles itself "blyg".** The default value of a blyg's title
was the literal string `blyg`, which meant every operator who skipped that
settings field published under the same name. Two unrelated live nodes were
doing exactly that, and the directory at blygger.com listed both as "blyg" —
then briefly held a third submission as a suspected impersonation, queueing a
stranger because of our default.

The default is now derived from the deployment's own address, which is unique
because domains are: a blyg at `blyg.example.com` titles itself `example.com`
until its operator says otherwise. A leading `blyg.` or `www.` is dropped —
neither says whose blyg it is. Your own title, once set, always wins; emptying
it returns to the derivation rather than to a blank.

Deliberately not a made-up human name. "Example's Blyg" would be the client
asserting something its operator never said.

`npm run init` now also writes `site_url` while it has the domain in hand, so a
freshly provisioned blyg has correct absolute URLs and a distinctive title from
its first publish. Re-running init never overwrites a title you have set.

There is an advisory for other client authors at
[blygger.org/start/](https://blygger.org/start/#advisory-do-not-ship-a-generic-default-title):
a default identical across installations destroys information, and the
deployment usually already knows a truer answer.

**`npm run upgrade` now moves between releases, not to the tip of `main`.** The
two halves of the version story disagreed: the studio's update alert compares
against the GitHub releases feed, while the upgrade script merged `main`. An
operator could upgrade, land on unreleased commits, and still be told they were
current — and `CLIENT.version` on `main` between releases is the *previous*
release's number, so "what am I running?" had no meaningful answer. It merges
the newest `v*` tag now, which is the only thing that carries a changelog entry
and therefore the only thing that can tell you whether there are migrations.
Tracking `main` remains a legitimate choice; it is just not what the script
does, and the README says so.

---

## 0.8.2 — 2026-09-29

**Migrations: none.** Presentation only; no published document changes.

**A thread is named in its author's own words.** A thread's `content_html`
contains other people's writing, baked in as transclusion blockquotes. That is
right on the thread's own page, where a quote is shown as a quote with a
provenance line under it. It was wrong everywhere the client had to *name* the
thread in one line, because flattening that HTML to text drops the structure
that made the attribution legible.

Measured on a live node before the fix: of 19 published threads, **5 opened
with a transclusion** — which is the shape the stub action prefills, so it is
the common case. For those five, the browser tab, the search-result heading,
the social card, the RSS headline and the feed-page excerpt were all someone
else's sentence presented as the author's. Others ran the author's prose
straight into a quote mid-excerpt with no boundary, so a card read as one
continuous paragraph by one person when it was two people.

Fixed in one place and used by all four surfaces: the feed card, the page
`<title>`/`og:title`/description, the RSS headline and the archive row. A
thread's card also gained a **quote count** (`⧉2`), which is what now says the
item is longer than the teaser; and a thread that quotes without adding
anything of its own names what it answers instead of borrowing the quoted
sentence.

Nothing here changes the wire. `content_html`, the item document, the feed
description and the static export all keep the quotes, and the thread's own
page still renders them in full with their provenance.

**Also fixed:** a thread mixing whole and partial transclusions mis-paired its
provenance lines, because the injector matched the class attribute as a literal
string — so a partial quote got no line and every following line shifted onto
the wrong quote.

---

## 0.8.1 — 2026-09-29

**Migrations: none.** `versions.transclusions` is JSON text, so the new member
below needs no schema change and every document published before this release
stays valid and unchanged.

**Partial transclusion — quote a passage instead of the whole item.**
Spec §16.4, decision #49. The medium had three registers of borrowing and only
two of them were writable: transclude the whole item for commentary (the stub),
or fork from a pin for a derivative. Quoting a passage as the thing you are
responding to — the common blogging norm — was the missing rung.

**The grammar is adjacency.** A `![[id]]` directive immediately followed, with
no blank line, by a markdown blockquote is a partial transclusion, and the
blockquote is the passage:

```
![[7c9wk2mhq0v3xj8tn5rzfd41bg]]
> Stigmergy is what a protocol looks like from inside, and the
> reason it looks like nothing at all is the point.

Commentary begins after a blank line.
```

A blank line detaches it. That is deliberate and it is why there is no new
sigil: transcluding an item whole and then quoting a bit of it yourself has
been writable since 0.1, and nothing anyone has already written changes meaning.

**The passage must really be in the target.** At publish, the selection must be
a substring of the target snapshot's text content at the version being baked —
tags stripped, whitespace collapsed within a block, block boundaries kept as
line breaks — else a publish error, exactly like an unresolvable directive. A
quote that welds two of the source's paragraphs into one sentence is refused,
because the source has a break there and the quote does not.

**In the studio.** Highlight a passage in the reading view and press
`quote ↗`: you land in the editor with the directive and the passage already
attached, and the passage is checked while you are still choosing it rather
than at publish. Stubbing a long item now prefills an empty quote line instead
of the whole-item form — a suggestion, not a rule; delete the line and the
whole form publishes as before.

**On the page**, a partial quote says *"excerpt of v2"* where a whole
transclusion says *"snapshot of v2"*. Without that a reader cannot tell a part
from the whole: a short quote and a short item look the same.

**On the wire**, the `transclusions[]` entry gains an OPTIONAL `selector` in
the W3C text-quote shape (`exact`, with short `prefix`/`suffix`). **A reader
that ignores it entirely stays conformant** — the passage is baked into
`content_html` like any other transclusion, the relation is still
`transclusion`, staleness is unchanged, and mention verification ignores it as
it ignores `cited`. The bake carries `class="blyg-transclusion blyg-partial"`,
and the second class is how a reader knows this is a part.

This is a 0.3 revision, not a new protocol version: nothing a reader or a
receiver does changes. `PROTOCOL_VERSION` stays `"0.3"`.

**Also fixed:** a thread mixing whole and partial transclusions mis-paired its
provenance lines, because the injector matched the class attribute as a literal
string. Only reachable with a partial in the thread, so no published document
is affected — but the failure mode was attributing one origin's words to
another's, which is worth naming.

---

## 0.8.0 — 2026-09-29

**Migrations: one — `0012_responses_default.sql`.** It adds a nullable
per-item override for the responses list; the backfill is written so that an
upgrade changes nothing that is currently visible on your pages (see below).
Run `npm run upgrade`, or apply migrations and deploy as usual.

**No wire changes.** Everything in this release is presentation, studio
behaviour or packaging. `PROTOCOL_VERSION` is unchanged and no published
document is affected.

### Reading

**A two-pane reader.** Sources on the left, one stream on the right, with
per-source filtering and "Add feed" at the top. Subscriptions left the nav
because the list of them is now where you read them — the page stays, and owns
pause, resume, resync, delete, blogroll membership and poll diagnostics, all of
which the sidebar deliberately does not try to hold.

**Reading entries show the item's address, not an "open" label.** Several
origins stubbing one item were indistinguishable from each other: the body is
what they share and the origin is what they do not.

**The entry's controls are split by what they do.** Composition (`stub`,
`fork`, and the new `link post`, which starts a fragment containing `[[id]]`)
sits apart from the rest (`copy [[id]]`, `copy url`, the address). `stub ↗`
remains the one control that means "I am responding".

### Titles

A titled item is now named the same way on every surface that names it. A
leading heading becomes the linked title on the feed page, in the studio
reader, on the permalink, **and** — new here — in the archive listing and in
the page's own `<head>`. Before this, the archive ran the heading into the body
("On Protocols Protocols are the thin layer…") and so did every social card.
Items remain titleless on the wire (§5.3): all of this is derivation from the
item's own first block, never a new field.

### Social cards

The head has carried `description`, `og:*` and `twitter:card` since 0.4.1. This
release fixes what they *said*: `og:title` is the declared heading where there
is one (and carries no site suffix — `og:site_name` is the tag that says
where), and the description is taken from what follows the heading rather than
repeating it. The pinned-version page and the archive gained an `og:image`;
a pinned page uses the blyg's avatar rather than the item's current
attachments, because its whole promise is the bytes from when it froze.

### Studio chrome

**The nav is a top menu.** Sections are real targets with a hover state and a
filled current tab; `public page` and `log out` are a separate group. Below
640px the bar collapses behind a hamburger.

**A mobile pass over every studio and public page at phone width.** Horizontal
overflow is gone (a single pasted URL used to set the page's minimum width, so
every page scrolled sideways), tap targets are ~44px where they were 18–26px,
and the reading sidebar collapses behind a control that names the source you
are filtered to.

Both collapses are gated on a marker that only a scripted browser sets, so a
browser with JavaScript off gets the full navigation rather than a button that
does nothing.

### Settings

**A timezone for displayed dates.** A Worker's clock is UTC, so an evening post
could show tomorrow's date. The picker is filled by your *browser's* list of
zones and preselects your device's. The wire is unchanged and tested — feed
dates stay RFC-822 in GMT and item documents ISO-8601 UTC; this is what a human
reads on the page.

**A global default for whether items show their responses, overridable per
item.** The old column was two-valued, so "off" and "no opinion" were the same
row and a default could never take effect. Migration 0012 adds the override.
**The backfill is conservative on purpose:** existing explicit opt-ins become
hard overrides and everything else inherits a default that is off, which
reproduces exactly what your pages show today. An upgrade that newly exposed
other people's responses on someone's pages would be a bad day.

**Update alerts, on by default.** The studio compares its own `CLIENT.version`
against the public releases feed and says when you are behind. Nothing about
your deployment is sent — it is a version comparison against a feed, not a
check-in. Dismissable, and switchable off in settings.

### Packaging

**`npm run init` and `npm run upgrade`.** `init` provisions a new deployment
idempotently, picks the Cloudflare account explicitly even when there is only
one, and never sees your owner password (`COOKIE_SECRET` is generated and piped
on stdin). `upgrade` shows what is coming, calls out changed migrations, keeps
your `wrangler.jsonc` on conflict, and gates on typecheck and tests before
offering to deploy.

**The shipped client names no deployment.** The committed `wrangler.jsonc`
carried two Cloudflare accounts, three D1 databases, bucket and worker names,
zones with route patterns, and a comment describing a live production API
surface — a copy of this repo inherited all of it. None of it was a credential
and all of it was already public, so this removes nothing from the world; what
it does is make the artifact honest. Configure your instance in
`wrangler.jsonc` and nothing under `src/`; if you ever have to edit `src/` to
configure an instance, that is a bug in this client, because it breaks your
upgrade path. Please report it.

---

## 0.7.0 — 2026-09-28

**Migrations: none.** Studio UI only; nothing on the wire changes and no
published document is affected.

**The `[[` picker now exists, in all three composers.** `[[id]]` has rendered and
resolved since 0.6.0, but the only way to find an id for one was to know it:
the picker lived inside the thread editor and fired only on `![[` at the start of
a line, while `[[id]]` is legal **inline and in a fragment**. The one construct
you can write anywhere was the one construct with no way to look anything up.

- The palette is now shared by the quick composer, the fragment editor and the
  thread editor, and it distinguishes the two bracket forms: `![[` with only
  whitespace before it on the line inserts a directive over the whole line;
  `[[` anywhere inserts a link in place and leaves the rest of the sentence
  alone. The `!` guard that separates them is the client-side spelling of the
  negative lookbehind the renderer already uses, so an inline `![[` — which
  inside a `[TK]` scope means a source reference — still opens nothing.
- **The directive form is offered in the thread editor only**, because only a
  thread resolves transclusions at publish. In a fragment `![[id]]` publishes as
  literal text, so a picker there would have written a line that does nothing.
  `[[id]]` resolves for both kinds and is offered everywhere.
- One panel serves both forms and both use the same candidate list, because
  `[[id]]` resolves through the same order as the directive — the same set of
  ids, by construction rather than by coincidence.
- A hint line in the palette names which form you are in and what it will do.

**Removed: the palette's dead search box.** It looked like the query field, took
focus and keystrokes, and was wired to nothing — the query has always been the
text you are typing in the editor. It is replaced by the hint line above. This
is half of the "picker has no search" report; the other half, paging past the
first 20 candidates, is still open.

**The thread editor had no discard button at all.** `threadEditPage` computed
`discardBtn` — both branches, with the comment explaining the distinction — and
then never interpolated it, so a thread draft could not be discarded and a
thread's unpublished changes could not be thrown away. The fragment editor
rendered the same control correctly, and every case in the discard test block
used the fragment editor, so the whole control could go missing from half the
studio with the suite green. Fixed, with thread cases added and
`noUnusedLocals` turned on so a control that is built and then dropped is a
compile error rather than a silent gap.

**The picker pages, and says how many there are.** `/fragments/search` capped
at 20 silently, so a blyg with more than 20 quotable items had a picker that
just stopped — indistinguishable from having nothing more to offer. The
response now carries `total`/`offset`/`limit`, the palette states "showing 20
of 63" (or "26 matches, all shown"), and ArrowDown at the bottom of a partial
list fetches the next page instead of sticking. Clicking the count line does
the same. This closes the rest of the reported picker bug.

**Reading entries link out.** Every entry rendered its body and linked to
nothing, so the most ordinary next move — read the whole thing where it lives —
had no affordance and meant copying an origin out of the byline. Each entry now
carries `open ↗`, derived from `sourceTitleAndUrl`, the same rule the stub
gesture already used: the origin's declared `page` wins (§2.3.2, decision #29),
the `f/`·`t/` convention is only a fallback, an L0 entry points at the anchor
its feed supplied, and an own entry points at our own public page. Always a new
tab — the studio holds unsaved composer text. A withdrawn own item offers no
link, because sending a reader to an endcap as "open" promises the text and
delivers its absence.

**Nav order: reading now leads.** Then compose, hoppers, mentions,
subscriptions, settings, syntax. The order follows the shape of a session
rather than the order the features were built in — you arrive to read, and most
writing is a response to something read. Subscriptions moved down beside
settings because it configures the reading feed rather than being a place you
work. The order was never asserted, so it is now.

**A draft can change its mind about what it is.** `PUT /api/items/:id` now
accepts `kind` on a never-published draft, and both editors offer "make this a
thread" / "make this a fragment". The composer's toggle always worked by
deleting the draft and recreating it — safe only because the text lives in the
textarea it was typed into — so past the Full Editor door, where the draft has
attachments, TK scopes and a save history, choosing the wrong kind meant
retyping. The row changes in place instead.

- **Never-published only**, guarded in the handler and again in the SQL. Once
  an item is published its `kind` is a field readers have and history records;
  moving it would make the archive disagree with itself. A **withdrawn** item
  is published by this test — its endcap and its versions are both out there.
- **A stub thread is refused (409), not silently converted.** Only threads
  carry a citation, and a stub is a claim the author made about what they are
  responding to; dropping it as a side effect of a kind switch would discard
  that claim. The error names "clear the stub" as the way through, which is a
  button already in the editor.
- Switching a long thread to a fragment is allowed and publish still enforces
  the 1000-char cap, so the editor's counter shows you are over rather than the
  switch pretending the text is fine.

**`copy [[id]]` in the reader (decision #50).** `[[id]]` has been publishable
since 0.6.0 and pickable from inside a composer since earlier in this release,
but it was unreachable from the one place authors actually meet other people's
items: the reading feed. Raised as a possible collision with decision #27
("one affordance, no lighter sibling") and ruled otherwise — #27's forbidden
sibling was a *response* gesture that did not declare itself, and #32 ruled
`[[id]]` declares nothing, so this is a different act: citing without
responding.

- It is named for what it does, and it sits in the byline beside `open ↗`
  where a copy-permalink would. It is **not** in the actions row with
  `stub ↗` and `fork ↗`: `stub ↗` remains the one affordance meaning "I am
  responding", and a peer in that row would say otherwise by position alone.
  #50 makes that placement semantic rather than cosmetic, so it is pinned by
  tests.
- Offered only where the link would resolve at publish, by `resolveTarget`'s
  order: our own published items, and imported non-L0 blyg items that are
  current or pin-retained. An L0 row has no item document and no version, so it
  gets `open ↗` and nothing else — offering a link there would hand you a
  construct that fails your whole publish later.
- It copies the construct, `[[id]]`, not the bare id: an id alone would make
  you remember a grammar you came to the reader to look up. Where
  `navigator.clipboard` is unavailable (an insecure context), the text appears
  in a selected field instead of failing silently.

**Verification:** 578 tests, `tsc --noEmit` clean, and everything above
exercised by hand against a local node — each bracket form in each composer,
arrow-key paging past the 20-item boundary (no duplicates, selection held), the
thread editor's restored discard button, the reader's new link, and a draft
switched from fragment to thread in place with its text intact, and a real
click on `copy [[id]]` putting `[[<id>]]` on the clipboard.

## 0.6.1 — 2026-09-28

**⚠️ Migrations: one — `0011_outbound_target_version.sql`.** The first release
that needs a database step, which is what that line in every entry is for:

```bash
npx wrangler d1 migrations apply <your-db> --remote
```

**A republish no longer re-notifies every origin it quotes.** Spec 0.3 §15.2 says
a republish re-sends "only for references that are new or whose target version
changed", and adds that "the reference client records the target version per
outbound reference for this purpose" — which was not true. `mentions_out` is keyed
`(item_id, target)` and held only *our* version, so `enqueueOutbound` reset every
row to `pending` on every publish: fixing a typo in a thread re-notified every
blyg it quoted. Harmless at two nodes, rude at eleven, and the spec vouched for
behaviour that did not exist.

- The queue now stores `target_version`, and delivery state resets only when the
  row is new, when the target's version actually changed, or when the caller
  forces it. The comparison is null-safe (`IS NOT`), because a `{url}` stub has
  no target version and two nulls must read as *unchanged* — otherwise a stub of
  a plain web page would re-send on every republish forever.
- **Withdrawal forces a re-send**, and is the only caller that may. §15.7 owes
  the receiver one notification precisely *because* nothing about the target
  changed: it re-verifies, finds a withdrawn document, and marks the mention
  gone. Without the override the new rule would have swallowed the one mention a
  withdrawal exists to send.
- Rows written before the migration have a null target version; a null-to-value
  transition counts as a change, so each pre-existing row re-sends at most once.
  §15.2 allows that explicitly — "a sender that re-sends everything on every
  republish is conformant but noisy" — and one noisy round beats a silent wrong
  answer.

Decision #33's staleness probe needs the same stored fact and is still unbuilt;
the roadmap asks for them together, and this is the half the spec freeze needed.

**Verification:** 531 tests, `tsc --noEmit` clean.

## 0.6.0 — 2026-09-28

**The three constructs the 0.3 freeze was waiting on.** Protocol 0.3 records
them in its §16 as *ruled but not built* — the project's rule is that testing
precedes prose (#21), so the spec text follows this release rather than leading
it. Level moves to **2**, which 0.3 §3 defines as this specification.

- **`[[id]]` is a plain internal link** (§16.2). Inline anywhere in a document,
  resolved at publish by the same order a `![[id]]` directive uses, rendered as
  an ordinary anchor to the target's own page — absolute, because `content_html`
  travels to subscribers. An unresolvable link fails the publish, like an
  unresolvable directive. It is **silent on the wire**: no `transclusions[]`
  entry, no Webmention, no class. In a medium where every other way of citing
  notifies the other side, this is the one that does not, deliberately.
- **`cited` carries a reference's human half** (§16.1). A frozen
  `{source, author?, excerpt?, url, retrieved}` inside `stub_of`, each **remote**
  `transclusions[]` entry, and `forked_from`, on live and pinned documents. It is
  additive and optional: own-origin transclusions are byte-identical to before,
  so every 0.2 document is still a valid 0.3 one. It is self-asserted and never
  authoritative — never read by mention verification, never rendered into
  `content_html`, and a reader that ignores it stays conformant. Why it exists:
  a reference carries identity and no words, so a reader whose target has
  disappeared was shown an id and nothing else, and seven client
  implementations would each have had to invent a label cache.
  - **This also fixes a stale byline.** The provenance line under a baked remote
    quote was rendered from a live join against the subscription, so renaming or
    deleting a subscription silently rewrote what an already-published document
    said about its source. It now reads the frozen citation. A citation that
    changes after publication was never a citation.
  - An **imported** document's own `cited` values are retained verbatim rather
    than recomposed from local guesses. Nothing renders them yet — the
    second-degree reference view does not exist — but a citation discarded on
    import could never be recovered.
- **`generator_url` in the manifest** (§16.6a): one absolute URL to this
  client's source, derived from `CLIENT` exactly as `generator` is. SHOULD, never
  MUST, and readers may not gate on it. It exists because five of the seven
  live client implementations have no locatable repository, and a manifest is
  the one place every blyg is required to be public — so it is the only channel
  through which a directory could ever point an operator at a release page.
- **`level` 1 → 2.** Live nodes were publishing 0.3 constructs while announcing
  level 1. Readers may not gate on the level (§3.2), so this is honesty rather
  than compatibility — it was wrong in the only way a self-report can be, by
  understating what is there.

**Migrations: none.** `cited` rides the reference objects and the two citation
columns migrations 0008 and 0010 already added.

**Verification:** 528 tests, `tsc --noEmit` clean. Documents published before
this release are unchanged and still conformant; nothing is rewritten in place.

## 0.5.0 — 2026-09-28

**A blyg can now decline to receive Webmentions.** Protocol 0.3, unchanged —
§15 is OPTIONAL at every level, and this release is the client catching up to
that. Until now `blygger-studio` had no way to express it: `buildManifest` took
a `webmention: false` option that no caller ever passed, so every deployment
served the endpoint whether its operator wanted one or not. That is the wrong
default to impose on somebody who stood a node up by following a start page.

- **Settings → "Accept Webmentions"**, on by default, so nothing changes for an
  existing node until its operator changes it. Unchecked, the endpoint is
  *withdrawn rather than guarded*: the manifest omits its `webmention` key,
  pages omit both the `<link rel="webmention">` element and the `Link` header,
  and a POST gets **404** — the same answer a static export gives, rather than a
  403 that would imply an endpoint with a policy.
- **A setting, not an `Env` var**, because it has to survive the way these nodes
  actually upgrade: a re-clone carries `wrangler.jsonc` across by hand, and a D1
  setting is never in that path.
- **Sending is unaffected.** A blyg that does not receive mentions still sends
  them when it quotes, stubs or forks someone — the two halves were always
  independent and stay so. Responses already collected stay in the studio.
- `accept_mentions` accepts a boolean, or the strings `"on"`/`"off"`, and
  **rejects anything else with 400** instead of storing it. Any stored value but
  `"off"` reads as on, so a silently-accepted typo would re-open the endpoint an
  operator meant to close.

**Migrations: none** — settings are key/value rows in an existing table.

**Verification:** 515 tests, `tsc --noEmit` clean.

## 0.4.1 — 2026-09-28

**Security hardening of the Webmention endpoint. Recommended for every live node,
and the reason this release exists.** `POST {mount}/webmention` is the only
unauthenticated public endpoint in this program, and as of this month the origins
that advertise it are published in a public directory — so the defaults shipped
here are the ones strangers now find. Protocol 0.3, unchanged. Level 1, unchanged.

- **Rate limit now also counts the registrable domain**, not just the source host,
  at 120/hour. The existing per-host cap of 60/hour was defeated by wildcard DNS:
  `a.spam.example` and `b.spam.example` are different hosts, so a flooder paid one
  DNS label per 60 accepted claims. Both caps apply; the domain cap is the higher
  of the two on purpose, because the domain grouping is a documented heuristic and
  a hosting suffix it does not know about would otherwise cap every site behind
  that suffix collectively.
- **A global cap of 300 accepted claims/hour on the endpoint as a whole.** No
  per-source limit bounds a total: fifty domains sending 119 each sat inside every
  previous cap while spending up to ~11,900 outbound fetches at URLs strangers
  chose — on the deployer's Cloudflare account. Once this cap binds, further new
  claims in that window are refused, so the refusal now carries `Retry-After`.
- **`failed` inbound claims are deleted after 30 days**, on the existing cron.
  They previously accumulated forever, which made an endpoint anyone can POST to
  into an unbounded write surface. `verified`, `gone` and `pending` rows are
  untouched — `gone` in particular is kept deliberately, so that a responder who
  withdraws and republishes is recognized as the same relationship.

**Migrations: none.** Every cap counts columns that already exist, so upgrading is
a redeploy with no database step.

**Verification:** 512 tests, `tsc --noEmit` clean.

## 0.4.0 — 2026-09-28 (untagged)

The rename and the split, recorded here for continuity; there is no tag, because
this changelog did not exist yet.

- This client moved out of `blygger-spec/worker/` into its own repository with all
  59 of its commits, and was renamed **`blyg-ref` → `blygger-studio`**, the name
  people were already using for it in public.
- `CLIENT` (name + version) became a constant of its own, deliberately decoupled
  from `BRAND`: the brand is the protocol's vocabulary, and a client renaming
  itself must not read as a protocol change. This release is the first where the
  client version and the protocol version differ.
- Both outbound user-agent strings are now derived from `GENERATOR`. They had been
  written by hand and had drifted to `blyg-ref/0.2` and `blyg-ref/0.3` on a 0.3.0
  client.
- **Nodes reporting `blyg-ref/0.3.0` are this same software under its old name.**
  Nothing about such a deployment is wrong or broken; it is simply behind, and as
  of 0.4.1 it is behind on the Webmention hardening above.

**Migrations: none.**
