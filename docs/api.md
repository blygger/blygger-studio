# Owner API

The owner API lives at `{mount}/api`: `/api` for a root node and `/blyg/api` for a node mounted at `/blyg`. On a mounted node, host-root `/api` still answers as a deprecated alias (0.49.12, for two releases), with `Deprecation` and a successor `Link` header; use `{mount}/api`.
The public Blygger protocol remains separate.
Sign into Studio before calling the API from a browser on the same origin.
Delegated clients use scoped bearer tokens. See [Client access](client-access.md)
for OAuth, manual tokens, and browser access.

Shared Zod definitions validate JSON bodies, path parameters, and query parameters.
They also define resource responses and generate the OpenAPI 3.1 contract.
Resource projectors validate their output with these schemas.
Contract tests validate successful responses against the same definitions.
Hey API generates the SDK directly from the contract, without changes to generated code.

## Capability discovery

`GET {mount}/api/capabilities` accepts an owner session or any valid delegated grant.
The response contains `contractVersion`, canonical `endpoints`, available
`operations` by ID, and `extensions` with separate declared, compiled, enabled,
and caller-granted states. This includes grants with only `reading:state`.
The generated SDK exposes `getCapabilities`.

OpenAPI describes the whole static contract. Capability discovery and MCP tool
lists reflect the current node and caller. An operation appears when the caller
can supply at least one permitted input. Some fields require extra scopes:
response visibility and generated highlighting need `owner:publish` alongside
`owner:draft`, and selecting an avatar needs it alongside `owner:manage`.
Attaching new media to a published item also needs `owner:publish`. Returning an
existing duplicate does not. The server checks these rules on each execution.
A discovery result cannot authorize a later call after an extension is disabled.

Operation declarations also name effects and work budgets. Rendering a preview
stores no domain state and spends the read budget. Link classification can
store probe results and spends the write budget while requiring `owner:read`.
Owner grant administration stays session-only and has no delegated MCP tools.

## Shared execution

REST and MCP verify their own credentials, then invoke the same operation runner.
The runner applies scopes, conditional permissions, live feature checks, work
budgets, and input validation. Domain operations return typed outcomes. Each
transport maps them to its own response. Resource-dependent rules stay with the
state they govern, including upload duplication and published-item attachment
permissions.

REST multipart and MCP Base64 decoders supply the same media byte input. MCP
creates no internal REST request. Publication, refresh, warnings, and deferred
mention delivery run through the same operation as Studio's REST call.

## Collection read batches

`POST {mount}/api/read-batch` groups independent reads of one operation. It
requires `owner:read`, accepts 1–50 requests, and returns results in input order.
The current opt-in operations are `getItem`, `listMentionGroups`, `listMentions`,
and `getMentionSummary`. Existing collection endpoints remain available.

```ts
const results = await unwrap(BlyggerApi.batchRead({ client, body: {
  operation: 'getItem',
  requests: [{ path: { id: firstId } }, { path: { id: secondId } }],
} }));
```

Each child accepts optional `path` and `query` records of strings. Its existing
operation validates those arguments and returns `{ status, body, headers }`.
An outer HTTP 200 means the envelope ran; inspect each child's status for
not-found, invalid-input, expired-cursor, or rate-limit failures. `Retry-After`
and scope challenges are retained in child headers. Envelope failures use the
normal API error response. Writes, recursive batches, and arbitrary URLs are
not accepted.

The envelope and every child spend the caller's read budget. Child operations
run through the same permission and validation checks as direct requests.
Each cursor remains bound to its own collection, filters, and generation;
the whole envelope is not a transaction or a cross-collection snapshot.

Within one envelope, ready prepared `all()` and object `first()` calls are sent
through D1's `batch()` in microtask-sized groups, without a timer window, SQL
rewrites, or result caching. This includes the existing per-read admission
statements: packing calls does not combine or waive logical charges. Dependent
queries still run in later rounds. Explicit D1 batches and other methods retain
their native execution behavior.

Each physical D1 batch is a transaction. If it fails, that group's statements
roll back and its waiting reads fail together; earlier completed groups remain
committed. The adapter never retries failed batches or admission writes.

Studio batches ready reads by operation with DataLoader, without caching batch
results. Browser dispatch uses microtasks, not timers: synchronous peers share
a batch, while reads that become ready after dispatch use a later batch.
Different request headers or credential settings use separate batches.
Cancelling one read preserves its peers; cancelling every consumer aborts the
shared fetch. Concurrent freshness checks share pending work only, and Studio
writes clear that pending check before their subsequent refreshes.

## HTTP responses

Private API responses use `Cache-Control: no-store`, including preflight and errors
rejected before dispatch. Browser bearer requests can read `ETag`, `Retry-After`, `Allow`,
`Location`, and `WWW-Authenticate` when those headers apply. Wrong-method
responses identify supported methods in `Allow`.

Public JSON, RSS, OPML, CSS, and stable asset URLs support ETags and conditional
GET/HEAD. Save the returned ETag and send it as `If-None-Match` on a later read.
A matching current representation returns 304 without a body. Resource and
access checks precede validation, so a validator does not bypass private media
access or make an absent resource available.

Validators cover complete response bytes. A pinned document can get a new ETag
when live author or origin metadata changes, even when its markdown hash stays
the same. OAuth discovery keeps its native public cache policy, and signing keys
revalidate. Token responses use `no-store`.

New uploads use `{mount}/media/{id}/{sha256}.{ext}`. The server checks the complete
stored key and digest before serving bytes. Uploads remain private and `no-store`
until a public use exposes them. A digest URL retained by a published version
uses `public, max-age=31536000, immutable`; detach, withdrawal, restoration, and
discarding a draft owner preserve its row and bytes.

Legacy `{mount}/media/{id}.{ext}` URLs keep serving with ETags and
`public, no-cache`. A duplicate upload can return that existing legacy URL.
Current avatars and later attachments that no published version retains also
revalidate, since their public use or storage can end. Stable Studio asset URLs
keep revalidation because a deployment replaces their bytes.

## Private representations

Private requests and resources use camelCase fields, such as `contentMd`,
`stubOf`, and `avatarMediaId`. Private JSON and multipart inputs reject unknown
top-level fields, including old storage-key spellings. Upload attachment targets use `itemId`.
Item `kind` identifies fragment or thread, while `status` identifies draft,
public, or withdrawn state. Historical withdrawal versions retain their own
withdrawn kind.

Imported metadata fields such as `author`, `media`, `transclusions`, `stubOf`,
`forkedFrom`, and `generated` contain structured values. Each damaged stored
column falls back independently to null. Remote objects retain unknown nested
members and their original member names.

Media `url` values are absolute URLs at the canonical deployment mount. Use
them directly. Media `id` remains the identifier for attachment commands.

Private failures contain `code`, `message`, and optional `details`. For example,
a stale item command returns `code: "revision-conflict"` with the rejected
revision in `details.expectedRevision`. Input errors put issues in
`details.issues`. Native OAuth errors retain the OAuth error fields.

## Resources and operations

All paths below are relative to `{mount}/api`. OpenAPI paths are relative to its canonical API server URL; the SDK base URL includes this API path.
Consult `openapi.json` for every field and response.

| Resource | Read | Write |
| --- | --- | --- |
| Items | `GET /items`, `GET /items/{id}` | `POST /items`, `PATCH /items/{id}`, `DELETE /items/{id}` |
| Versions | `GET /items/{id}/versions`, `GET /items/{id}/versions/{v}` | `PUT /items/{id}/versions/{version}/pin` |
| Subscriptions | `GET /subscriptions`, `GET /subscriptions/{id}` | `POST /subscriptions`, `PATCH /subscriptions/{id}`, `DELETE /subscriptions/{id}` |
| Hoppers | `GET /hoppers`, `GET /hoppers/{id}` | `POST /hoppers`, `PATCH /hoppers/{id}`, `DELETE /hoppers/{id}` |
| Hopper membership | `GET /hoppers/{id}/memberships` | `PUT` or `DELETE /hoppers/{id}/items/{sub}/{remoteId}` |
| Signals | `GET /signals` | `PUT` or `DELETE /signals/{sub}/{remoteId}` |
| Mentions | `GET /mentions?direction=inbound` or `outbound` | `PATCH /mentions/{id}` with `hidden` |
| Settings | `GET /settings` | `PATCH /settings` |
| Shelf | `GET /shelf` | `PUT /shelf` (replaces the whole list; see [Shelf](#shelf)) |
| Media | Included in item detail: `media` is the working copy's attachments, `publishedMedia` what the live version lists | `POST /media` with a multipart file (`inline=true` when the client places it in the text; the same file sent again to the same item in the same placement returns the existing row with `200` and `duplicate: true`). Attachments are per version: one added to a published item is listed from its next version on. `DELETE /media/{id}` detaches it from the working copy, so the next version goes without it while the versions that listed it keep it; the file is deleted only when no published version lists or shows it |
| Imported items | `GET /imports/{sub}/{id}`, `GET /imports/{sub}/{id}/history`, `GET /imports/{sub}/{id}/versions/{v}` (history and public versions, read from the origin) | The subscription importer manages these items |
| Reading | `GET /reading`, `GET /reading/imported` (imported items only; see below) | Read only |
| Read state | `readVersion` on each imported Reading entry | `PUT`/`DELETE /reading/{sub}/{remoteId}/read`, `POST /reading/read`, `POST /reading/unread` |
| Change revisions | `GET /changes` | Maintained by database triggers |
| Quote freshness | `GET /freshness`, `GET /items/{id}/freshness` | `POST /items/{id}/refresh` |

Publication, withdrawal, restoration, and generation remain explicit operations:

- `POST /items/{id}/publish` and `POST /items/{id}/withdraw` accept an optional publication note.
- Empty publications, including media-only versions, retain their authored kind and support pinning, restoration, and forking. Withdrawal endcaps reject pinning and restoration. Ambiguous historical empty versions keep their legacy interpretation after upgrade.
- `POST /items/{id}/restore` copies a stored version's text and attachment membership into the working copy. It does not publish. Restoring the current version discards attachment additions and restores detached attachments; historical version memberships and retained bytes stay intact.
- `POST /items/{id}/generate` generates one TK scope.
- `POST /subscriptions/{id}/resync` refreshes a Blyg subscription.
- `POST /items/{id}/note-draft` drafts a changelog note from the change between the published version and the working copy. It never publishes. When the published version is unpinned, the note must not reproduce wording that only that version had; a draft that does returns 422. Send `noteGenerated: true` with `POST /items/{id}/publish` only when the note is that draft, unedited: it becomes `changelog[].generated` on the wire.
- `POST /items/{id}/classify` asks the optional change classifier what kind of change the working copy would publish. See [Change classifier](#change-classifier).
- `POST /items/{id}/refresh` republishes a thread to re-bake quotes whose source has a newer version. See below.

## Shelf

The shelf is a short list of items in the owner's order: living threads kept
at the top of a writing list, and posts from blygs the owner reads. Studio and
other clients (Blygger Desktop) share it. It is studio-private: it never
reaches an item document, a feed, the manifest, a public page or the static
export, and it never gains a public mode. A featured list on public pages, if
one is ever wanted, would be a separate presentation setting, not a flag on
the shelf.

An entry names an item the way hopper membership does, as `{ sub, remoteId }`:

- an own item is `{ sub: "~own", remoteId: <item id> }`. The SDK exports the
  sentinel as `OWN_SUBSCRIPTION`;
- an imported item is `{ sub: <subscription id>, remoteId: <its remote id> }`.

A bare id would not tell two origins apart.

- `GET /shelf` (`owner:read`) returns `{ entries, revision }`, in order.
- `PUT /shelf` (`owner:manage`) takes `{ entries, expectedRevision }` and
  replaces the whole list. It returns the stored `{ entries, revision }`
  after dropping and deduplicating, so a client can reconcile without a second
  `GET`.

Rules:

- Any of this blyg's own items can be shelved, drafts included, and so can
  any item held under a subscription.
- An entry has to resolve to be kept: an own item that is not withdrawn, or an
  imported item that is current or a tombstone with a retained pin (the rule
  `[[id]]` and `![[id]]` resolve by). `GET` omits entries that do not.
- A `PUT` **drops entries that do not resolve quietly and never refuses them**.
  That covers a `sub` that names no subscription, a `remoteId` not held under
  it, a withdrawn own item, and an imported tombstone with no retained pin. A
  repeated entry keeps its first position. Check the response to see what was
  kept. A withdrawn item's place is kept until the next `PUT`, so republishing
  it before then puts it back where it was. The same holds for an imported
  item that turns into a tombstone and comes back.
- Discarding a draft takes it off the shelf. So does an imported item that is
  no longer held, and unsubscribing removes every entry of that subscription.
- At most 50 entries per `PUT`. A longer list, a malformed entry (`sub` or
  `remoteId` missing, empty or not a string, or an unknown field), unknown
  fields in the body, or a missing or negative `expectedRevision` returns 400
  `invalid-input`.
- Every successful `PUT` bumps `revision`, even when the list is unchanged.
  `expectedRevision` is required: read the shelf first (a never-written shelf
  is at revision 0), and the replace applies only if nobody else has written
  since. A stale one returns 409 `revision-conflict` with the full current list
  in `details.current: { entries, revision }`: merge and retry. There is no
  unconditional replace, because one client's `PUT` would silently undo
  another's reorder.
- The `shelf` change domain in `GET /changes` moves on every `PUT`, when a
  shelved own item is withdrawn or republished, when a shelved imported item
  becomes a tombstone without a retained pin or comes back, and when a shelved
  entry's row is deleted (discarded draft, unsubscribe).
- Shelving is not an interaction: nothing goes in the interaction log.
- The Studio's compose list shows the `~own` entries. Reordering or removing
  them there leaves imported entries where they are.

```ts
import { OWN_SUBSCRIPTION } from "@blygger/sdk";
const { entries, revision } = await unwrap(BlyggerApi.getShelf({ client }));
await unwrap(BlyggerApi.putShelf({ client, body: { entries: [{ sub: OWN_SUBSCRIPTION, remoteId: id }, ...entries], expectedRevision: revision } }));
```

## Change classifier

Optional and **off by default**: nothing below happens until Settings → AI
names a decision model in `aiModelClassify`. A decision model (Cloudflare's
Clef or Clef-flash on Workers AI, or TypeSafe's Jev) answers typed questions
with probabilities and writes no text, so `GET /ai/models` marks it
`kind: "decision"`, `aiModelClassify` accepts only a decision model, and the
text functions (`aiModelTk`, `aiModelChangelog`, `aiModelFeed`) refuse one
(400).

The category set is fixed: `refresh`, `typo`, `minor`, `major`.

| Category | Meaning | Decided by |
|---|---|---|
| `refresh` | a republish of the same words (the new `content_hash` equals the published one) | locally, with no model call |
| `typo` | spelling, punctuation, formatting or a link fixed; meaning unchanged | the model |
| `minor` | small edits to wording or detail; a returning reader need not reread | the model |
| `major` | the substance changed; a returning reader should read it again | the model |

The model is asked one `choice` question over both versions and the word-level
change between them; the instruction and option descriptions are
`CLASSIFY_QUESTION` in `src/change-class.ts`.

`POST /items/{id}/classify` (scope `owner:draft`, like `note-draft`) never
publishes. It returns `{ version, category, model, probability, reason? }`:

- `409` when the classifier is off, for a first version, or when the published
  version is a withdrawal.
- `200` with `category: null` and a `reason` when no category could be had: no
  binding or key, a provider error, the daily AI budget (`AI_DAILY_CALL_LIMIT`;
  every classify that calls a model counts, `refresh` does not), or an answer
  that does not parse. **None of these is fatal**: publish as usual.

The Studio calls it from the *Version N* publish dialog, which shows the answer
as a chip the author can change or clear. With `changeCategoryInNote` (on by
default; it matters only while the classifier is on) the dialog also writes the
category into the note, where the author sees it before confirming:

- an empty note becomes the bare word, `minor`;
- a note becomes `minor: <note>`;
- a note that already starts with a category word is left alone.

The server never rewrites a note. Send `noteGenerated: true` only when the note
is exactly the machine's text: a drafted note led by the classifier's own
category, or the classifier's bare word on an empty note. A category changed by
the author, or a category prefixed to the author's own words, is not generated.

`POST /items/{id}/publish` takes an optional `changeCategory`: the category the
author confirmed (`null` for cleared; omitted, a classification made for exactly
these words stands). It is kept with the version in studio-private storage
(migration 0030, `change_class`: category, model, probability, classified_at,
overridden) and read back as `changeClass` on each version in
`GET /items/{id}`.

**Nothing of this is on the wire.** Spec decision #19 / TN-1 refuses a
version-significance marker, and decision #77 makes "ignore this version" a
reader-side derivation from `content_hash`. So there is no new member in item
documents, `changelog[]`, `feed.xml` or `blyg.json`; the category reaches
readers only as words in the note the author confirmed.
`test/change-class.test.ts` asserts that a classified publish emits the same
document keys as an unclassified one.

Preview and search use `/preview` and `/search`.
`GET /changes` returns `{ epoch, domains }`, with revision counters for items,
Reading, subscriptions, hoppers, signals, settings, the public feed, mentions,
responses, interactions, browsing history and the shelf. It uses
the same current owner/delegated read authorization as other private reads.
Clients can skip unchanged data refreshes, but must capture their target before
loading and acknowledge it only after successful installation. These are change
signals, not row-delta cursors or permission to cache authorization decisions.
The old fork, stub, pause, resume, response-policy, and pin routes no longer exist.
Studio calls the canonical routes through the generated SDK.

## Create an item

One creation route accepts three recipes.
These examples use the generated SDK with an authenticated `client`:

```ts
const blank = await unwrap(BlyggerApi.createItem({
  client,
  body: { mode: "blank", kind: "fragment", contentMd: "A new draft" },
}));

const fork = await unwrap(BlyggerApi.createItem({
  client,
  body: {
    mode: "fork",
    source: { origin: "https://example.org/blyg/", id: "source-id", version: 1 },
  },
}));

const response = await unwrap(BlyggerApi.createItem({
  client,
  body: {
    mode: "response",
    source: { subscriptionId: "subscription-id", remoteId: "source-id" },
    selection: "An optional passage from the source",
  },
}));
```

Blank creation may omit `mode` or the entire body.
A fork starts from a pinned version and permanently records its source.
A response creates a thread with a citation to the imported source.
Creation returns the item, status 201, and a `Location` header.
Hopper and media creation also return 201.
Subscription creation returns 200 when the owner must accept the proposed subscription, then 201 when it creates the subscription.

## Subscriptions

`POST /subscriptions` takes `{ url, confirm?, title?, backfill? }`.
Without `confirm` it resolves the URL and returns the proposal (200); with `confirm: true` it creates the subscription (201).
A source that is already subscribed, by origin or by feed, is refused with 409.
New subscriptions are not in the public `blogroll.opml`; `PATCH /subscriptions/{id}` with `inBlogroll: true` adds one.

`backfill` (boolean, default `true`) applies with `confirm: true`.
By default the server starts importing the source's archive as soon as it has answered.
With `backfill: false` it creates the subscription and imports nothing yet: a subscription that has never been polled is always due, so the next quarter-hour poll imports it.
Use it for bulk imports, so that many subscriptions do not each start an archive import at once:

```ts
const result = await BlyggerApi.createSubscription({
  client,
  body: { url: "https://example.com/feed.xml", confirm: true, backfill: false },
});
if (result.response?.status === 409) { /* already subscribed */ }
if (result.response?.status === 429) { /* wait Retry-After seconds, then retry */ }
```

Whatever the `hopperFeeds` setting says (it governs only this node publishing its own hopper feeds), a URL naming one of a blyg's public hoppers (its page or its feed, as the blyg's manifest lists them) resolves to that hopper: the proposal has `kind: "hopper"`, with `hopper` (`title`, and `page` and `feedUrl` as absolute URLs) and `blygTitle`, and confirming creates a hopper subscription whose `hopperFeedUrl` is set. `wholeBlyg: true` subscribes to the whole blyg instead. Spec 0.4 §12.1 step 7 and §12.2 (decision #86, promoted from §16.12): see `docs/hopper-feeds.md`.

The Studio's OPML import works this way. It reads the file in the browser, flattens folders and sends one request at a time, about one a second, which stays under the owner's write budget of 120 writes a minute (`API_WRITE_LIMIT`).
Delegated clients have less room: 120 a minute per grant, and 60 a minute shared by every grant (`API_DELEGATED_WRITE_LIMIT`), so a token-bearing importer should go slower than one a second and honour `Retry-After` on 429.

## Partial edits

Item commands require the observed `expectedRevision`.
PATCH changes only supplied edit fields.
Omitted fields retain their values.
Null clears only fields that explicitly allow null, such as an item's `stubOf`.
Unknown JSON fields fail validation rather than disappearing silently.
Preferences use booleans, not database integers or strings such as `"on"`.

```ts
const item = await unwrap(BlyggerApi.updateItem({
  client,
  path: { id: blank.id },
  body: { contentMd: "Revised text", responses: "hide", expectedRevision: blank.revision },
}));
```

Item edits accept `contentMd`, `kind`, `stubOf`, and `responses`.
The response policy is `default`, `show`, or `hide`.
Kind becomes fixed after the first publication.
Fork lineage cannot change through PATCH. Client-recorded generation provenance
can change when it matches the resulting TK scopes. A provenance-only patch
guards the stored text used by that validation. A competing text change returns
409 rather than applying provenance to different scopes.

All requested changes must pass schema and domain validation before a write.
Item and hopper writes guard the state that their domain rules used.
If that state changes during the request, the API returns 409 without applying the patch.
Reload the resource before deciding whether to repeat the edit.
These guards do not provide general revision control for concurrent text edits.

Pinning uses PUT because repeating the same pin has the same effect.
A pin is permanent, including after withdrawal.
Deletion discards an unpublished draft. Withdraw a published item instead.

## Read and poll

Paginated reads return `{ items, page: { limit, nextCursor } }`.
Start without `cursor`, then pass `page.nextCursor` as `cursor` with the same
collection and filters. A null cursor marks exhaustion. Mentions also return
`direction`; Reading also returns its read-state support flags. Lists do not
include totals. Old HTTP `offset` inputs are rejected, including zero.

```ts
const first = await unwrap(BlyggerApi.listReading({ client, query: { limit: 25 } }));
for (const item of first.items) console.log(item.key);
if (first.page.nextCursor !== null) {
  const next = await unwrap(BlyggerApi.listReading({
    client, query: { cursor: first.page.nextCursor, limit: 25 },
  }));
}
```

Reading defaults to25 entries and accepts at most50 per request. Search defaults
to20. Imported Reading defaults to50. Other paginated reads default to100 and
accept at most100. Limits must be positive integers. Invalid cursors, filters,
and pagination return400 with `code: "invalid-input"`.

A cursor binds the collection, canonical filters, order, database epoch and
relevant change revisions. A relevant mutation expires the sequence: HTTP409
with `code: "cursor-expired"`. Discard that acquisition and start again without
a cursor. Do not append a restarted first page to an old prefix. Unrelated
changes do not expire it. Authorization is checked on every request. Cursors
are continuation values, not credentials or durable bookmarks.

Page queries apply filters and keyset order before limiting identities and
loading bodies. They do not promise constant D1 scan work for every filter or
sort. The selected page and its projection share a generation guard; an unstable
first page retries once before returning cursor-expired.

| Collection | Order |
| --- | --- |
| Items | updated DESC, id DESC |
| Item versions | version DESC within the item |
| Subscriptions and hoppers | created ASC, id ASC |
| Hopper memberships | addedAt DESC, subscriptionId ASC, remoteId ASC |
| Signals and thumbs | at DESC, subscriptionId ASC, remoteId ASC |
| Interactions | at DESC, id DESC |
| Browsing history | id DESC |
| Inbound mentions | verifiedAt DESC, lastSeen DESC, id ASC |
| Outbound mentions | created DESC, id ASC |
| Inbound mention groups | coalesced verifiedAt DESC, lastSeen DESC, firstId ASC |
| Reading | clamped display time DESC, source ASC, subscription id ASC, item id ASC |
| Imported Reading | observedAt DESC, subscriptionId DESC, remoteId DESC |
| Search | updated, id, source, subscription id; all DESC for newest or ASC for oldest |

Text ties use SQLite binary order. NULL sorts first in ASC and last in DESC.
Reading accepts `sub`, `kind`, `background` and `hopper` filters. A hopper Reading
view includes held imported bodies in membership order, newest added first,
then subscription id and item id. Own memberships and missing bodies remain
visible through membership management, but do not consume Reading slots.

Named summary reads supply counts separately:

- `GET /items/summary`: all, drafts, unpublished changes, public and withdrawn.
- `GET /reading/summary`: source counts and selected-source fallback, with the
  same `sub`, `kind`, `background` and `hopper` filters as Reading.
- `GET /signals/summary`: thumb and activity counts.
- `GET /mentions/summary`: inbound receipt, outbound receipt and inbound target
  group counts. Inbound counts include verified and gone receipts, including
  hidden receipts; outbound counts include every delivery status.

`GET /mention-groups` pages inbound target groups without downloading their
receipts. Each row has `targetItemId`, `total`, `visible`, `verifiedAt`, `lastSeen`
and `firstId`. Pending and failed inbound claims do not contribute. `visible`
counts verified, unhidden receipts before the target item's response policy is
applied. Gone and hidden receipts still contribute to `total`.

For group order, `verifiedAt` is the greatest receipt timestamp after SQL NULL
coalesces to an empty string. `lastSeen` is the greatest value among receipts tied
at that verified value; `firstId` is the smallest id among receipts tied at both
values. Thus a newer last-seen value on an older receipt cannot move its group
forward. Optional `targetItemId`, `verifiedAt`, `lastSeen` and `firstId` filters
match those group fields exactly. Counts and winners are computed in one SQL
statement; the response contains only the requested page. Computing the groups
still visits the matching receipts and sorts their aggregates.

`GET /mentions?targetItemId=…` pages one inbound group's receipts in the normal
inbound order. Exact `verifiedAt`, `lastSeen` and `id` filters support ordered
boundary reads. `verifiedAtNull=true` matches SQL NULL and cannot be combined
with `verifiedAt`; `verifiedAt=` matches an actual empty string. Outbound pages
accept exact `created` and `id` filters. Inbound-only filters with outbound
direction, and `created` with inbound direction, return 400. Every filter stays
part of that page sequence's cursor identity. Existing unfiltered mention
cursors retain their identity.

Poll `/reading` to read current D1 state. It does not fetch remote feeds; the
subscription cron does that. Studio polls visible data every15 seconds and
pauses in hidden tabs. Imported HTML is sanitized before return. Studio uses
TanStack DB windows and its native cursor pager for continuation acquisition,
cache sharing and cancellation. Its URL offset addresses a local view window;
it is not an HTTP pagination parameter.

Item detail includes current item fields, pin summaries, working and published
media, and the published version. It does not include the version history.
Read history with `GET /items/{id}/versions`; an optional exact `version` filter
supports a point demand. The item's kind is its authored fragment or thread
kind, including after withdrawal; publication state is the separate `status`.
Version resources include their kind, including threads with no transclusions.
Item and version references use objects, and flags use booleans. Imported
protocol metadata retains its remote member names. Subscription resources omit
internal HTTP cache fields.

Hopper detail returns only `{ hopper, total, sourceCount }`. Read paginated
memberships from `GET /hoppers/{id}/memberships`. Each row includes its nullable
held imported `item`. Missing bodies and own memberships retain their membership
row with `item: null`. The old hopper `preview` input is rejected.

## Imported reading feed

`GET /reading` is the Studio's timeline: own and imported entries together,
sanitized HTML only, with cursor pages. A client that syncs what the owner reads
and writes from it (Blygger Desktop) needs the other shape, and
`GET /reading/imported` (`listImportedReading`, `owner:read`) is it:

- Every imported item, own items excluded, newest observed first. Each row is
  an imported entry as `GET /reading` returns it (`subscriptionId`, `remoteId`,
  `kind`, `withdrawn`, `l0`, `version`, `readVersion`, `updated`, `observedAt`,
  `contentHtml` (sanitized), `sourceUrl`, `pinnedVersionRetained`, …) plus
  `origin`, `created`, `contentMd`, `author` (`{ name, url }` or null), `page`
  (as the origin declared it), `thumb` (the owner's signal: 1, −1 or null),
  `hoppers` (ids) and the origin's `transclusions`, `stubOf` and `forkedFrom`.
- The last three are the origin's own JSON, verbatim and unvalidated: remote
  data, unknown members included. Null means none held, or stored data that is
  malformed or of the wrong kind.
- `readVersion` is the read-state join below: null when unread or cleared.
- Paged by an opaque cursor over `(observedAt, subscriptionId, remoteId)`.
  Pass `page.nextCursor` back as `cursor`; null ends the walk. Timestamp ties
  resume by subscription and remote id. A relevant poll or metadata change
  expires the cursor with409; discard the old acquisition and restart. A cursor
  from another source or filter returns400.
- `limit` defaults to 50 and accepts at most 100; outside 1–100 is 400.

```ts
let cursor: string | undefined;
do {
  const page = await unwrap(BlyggerApi.listImportedReading({ client, query: { cursor, limit: 100 } }));
  for (const entry of page.items) console.log(entry.subscriptionId, entry.remoteId, entry.readVersion);
  cursor = page.page.nextCursor ?? undefined;
} while (cursor);
```

## Read state

A client that keeps "read" for imported items can store it here, so a post read
on one device reads as read on the owner's others. Each reading row holds one
number: the highest version the owner has read. It is Studio-private. No public
page, feed, item document, `blyg.json` or export reads it.

- `PUT /reading/{sub}/{remoteId}/read` with `{ version }` stores the larger of
  the held and requested values and returns `{ ok, stored, readVersion }`.
  A replay or a stale client never lowers it.
- `POST /reading/read` with `{ items: [{ sub, remoteId, version }] }` does the
  same for up to 500 rows in one transaction and returns `{ ok, received }`.
  Any malformed entry fails the whole request with 400, and nothing is written.
  The batch is one request against the write budget, however many rows it marks.
- A row this server does not hold, by subscription or by item, is acknowledged
  with 200 and `stored: false`, never 404. Clients may read a 404 from these
  routes as "this server keeps no read state".
- `GET /reading` returns `readState: true`, and each imported entry carries
  `readVersion`: an integer, or null when unread. A client can rely on the flag
  rather than probing the write routes. Each imported entry also carries
  `version`, the version held here: `readVersion` below it means a newer
  version arrived after the owner read it, and it is the value to send when
  marking the entry read.

### Marking unread

- `DELETE /reading/{sub}/{remoteId}/read` clears the row and always returns
  `{ ok: true, stored: false, readVersion: null }`. It is idempotent, and an
  unknown subscription or item is 200 as well, never 404.
- `POST /reading/unread` with `{ items: [{ sub, remoteId }] }` clears up to 500
  rows in one transaction and returns `{ ok, received }`, validated whole like
  `POST /reading/read`.
- `GET /reading` returns `readStateClear: true` when the server supports both.

A clear leaves a tombstone: the server records its own time of
the clear, and `readVersion` reads null. Both read writes accept an optional
`readAt` (ISO-8601 with `Z` or an offset; on `PUT` beside `version`, in the
batch on each item), the time the client read the post:

- A read whose `readAt` is earlier than the row's latest clear is ignored.
  `PUT` answers `stored: false` with whatever is held; the batch skips that row.
  Nothing changes, so no revision advances.
- A read with a later `readAt`, or the same instant, applies.
- A read with no `readAt` applies, as before clearing existed. Send `readAt`
  from any client that queues reads offline, or a queued read can undo a later
  "mark unread" from another device.
  The Studio acts online and sends none, so its reads always apply.

A clear resets the row, so the next accepted read stores its own version
rather than the larger of it and the value held before the clear. From there
reads are monotonic again. The tombstone stays after a read applies, so a
second stale read is still refused.

`readAt` is compared as an instant (the server normalizes it to UTC) against
the server's clock. A client whose clock runs fast can make a read look later
than a clear that followed it; one that runs slow can have a fresh read
ignored. Clients that cannot trust their clock may omit `readAt` and accept
last-write-wins.

Version is an integer from 1 (items start there) to 2^32 − 1. All four writes need `reading:state`,
a scope of their own so a sync-only reader app need not hold `owner:manage`. Read state goes with its imported item or subscription when either
is deleted, and a change, including a clear, advances the `reading` revision in
`GET /changes`.

## Quote freshness

A thread bakes each quote at the version it held when it published. A quote is
**stale** when a newer version of the item it quoted exists, either here (our
own item was republished, or the importer already pulled the source's new
version) or only at the source's origin. Only the direct relation counts: a
quote of a thread is not stale because that thread's own quotes moved.

- `GET /freshness` lists every published thread with a stale quote or one that
  would block a republish. It reads only D1.
- `GET /items/{id}/freshness` reports each quote in the published version:
  `baked` (the version in the thread), `held` (what a republish would bake now),
  `live` (what the origin serves, from `{origin}items/{id}.json`), and a
  `status` of `current`, `refreshable`, `behind`, `passage-missing`,
  `unresolvable` or `retained`. It probes origins unless `?probe=false`. A
  failed probe reads as `live: null`, never as stale.
- `POST /items/{id}/refresh` with an optional `note` re-imports the sources
  that are behind, then republishes. A refresh **is** a publish: it creates a
  new version, a feed entry, and mentions for the references whose target
  version changed. The words do not change, so `content_hash` stays the same.
  It returns 409 when the working copy holds anything other than the published
  words, when a quote would make the republish fail, or when nothing is stale.

## Errors and generation

Errors return JSON with an `error` string.
Validation errors also include issue paths and messages.
Domain errors may include details such as unresolved references.
Unknown routes return 404. A known route with the wrong method returns 405 and an `Allow` header.

Generated methods expose data, errors, and the HTTP response.
`unwrap()` throws for a failed response.
The SDK does not automatically retry writes.

Run `npm run sdk:generate` after changing the shared contract.
Commit `openapi.json` and `sdk/generated/` with the server changes.
CI validates generation drift, Worker behavior, browser flows, and packaged release artifacts.
See [SDK usage](../sdk/README.md) for browser and server transports.

### Conditional item commands

Items have a private `revision` independent of their published `version`.
Creation starts at1. Reads and successful commands return the current revision.
Each command supplies `expectedRevision` from the snapshot it changes. A stale
command returns409 with `code: "revision-conflict"`. Its `details` name `itemId`
and the rejected `expectedRevision`. A detached media conflict names `mediaId`
in `details` because the owning attachment no longer exists.

Working text, provenance, presentation preferences, attachment membership, and
publication transitions advance revision atomically. Generation and remote
refresh work retain their captured premise until commit. Pinning a version
that is already pinned is repeat-safe and retains the current revision.
Classifier and drafted-note reads require the observed revision without
advancing it.

Attached uploads require multipart `expectedRevision`; MCP carries the same
number in the upload body. Attachment deletion requires JSON
`{ "expectedRevision": n }`. Unattached upload/delete has no item precondition.
Every item mutation, including publish, withdraw, restore and delete, requires
a JSON condition. An empty creation body remains valid.

Studio retains its observed revision for unsaved text. Successful receipts
advance its paced command queue. A foreign polled revision cannot authorize an
old queued edit. A clean quick-edit session accepts text and revision together.
Conflicts require reconciliation. No blind retry or general idempotency receipt
store is provided.
