# Owner API

The owner API lives at `/api`, including installations with a mounted Studio.
The public Blygger protocol remains separate.
Sign into Studio before calling the API from a browser on the same origin.
Server clients must send the owner session cookie.
OAuth and cross-origin clients belong to the next compatibility phase.

Shared Zod definitions validate JSON bodies, path parameters, and query parameters.
They also define resource responses and generate the OpenAPI 3.1 contract.
Resource projectors validate their output with these schemas.
Contract tests validate successful responses against the same definitions.
Hey API generates the SDK directly from the contract, without changes to generated code.

## Resources and operations

All paths below start with `/api`.
Consult `openapi.json` for every field and response.

| Resource | Read | Write |
| --- | --- | --- |
| Items | `GET /items`, `GET /items/{id}` | `POST /items`, `PATCH /items/{id}`, `DELETE /items/{id}` |
| Versions | `GET /items/{id}/versions/{v}` | `PUT /items/{id}/versions/{version}/pin` |
| Subscriptions | `GET /subscriptions`, `GET /subscriptions/{id}` | `POST /subscriptions`, `PATCH /subscriptions/{id}`, `DELETE /subscriptions/{id}` |
| Hoppers | `GET /hoppers`, `GET /hoppers/{id}` | `POST /hoppers`, `PATCH /hoppers/{id}`, `DELETE /hoppers/{id}` |
| Hopper membership | Included in hopper detail | `PUT` or `DELETE /hoppers/{id}/items/{sub}/{remoteId}` |
| Signals | `GET /signals` | `PUT` or `DELETE /signals/{sub}/{remoteId}` |
| Mentions | `GET /mentions?direction=inbound` or `outbound` | `PATCH /mentions/{id}` with `hidden` |
| Settings | `GET /settings` | `PATCH /settings` |
| Media | Included in item detail: `media` is the working copy's attachments, `published_media` what the live version lists | `POST /media` with a multipart file (`inline=true` when the client places it in the text; the same file sent again to the same item in the same placement returns the existing row with `200` and `duplicate: true`). Attachments are per version: one added to a published item is listed from its next version on. `DELETE /media/{id}` detaches it from the working copy, so the next version goes without it while the versions that listed it keep it; the file is deleted only when no published version lists or shows it |
| Imported items | `GET /imports/{sub}/{id}`, `GET /imports/{sub}/{id}/history`, `GET /imports/{sub}/{id}/versions/{v}` (history and public versions, read from the origin) | The subscription importer manages these items |
| Reading | `GET /reading`, `GET /reading/imported` (imported items only, cursor-paged; see below) | Read only |
| Read state | `readVersion` on each imported Reading entry | `PUT`/`DELETE /reading/{sub}/{remoteId}/read`, `POST /reading/read`, `POST /reading/unread` |
| Change revisions | `GET /changes` | Maintained by database triggers |
| Quote freshness | `GET /freshness`, `GET /items/{id}/freshness` | `POST /items/{id}/refresh` |

Publication, withdrawal, restoration, and generation remain explicit operations:

- `POST /items/{id}/publish` and `POST /items/{id}/withdraw` accept an optional publication note.
- `POST /items/{id}/restore` copies a stored version into the working copy. It does not publish.
- `POST /items/{id}/generate` generates one TK scope.
- `POST /subscriptions/{id}/resync` refreshes a Blyg subscription.
- `POST /items/{id}/note-draft` drafts a changelog note from the change between the published version and the working copy. It never publishes. When the published version is unpinned, the note must not reproduce wording that only that version had; a draft that does returns 422. Send `note_generated: true` with `POST /items/{id}/publish` only when the note is that draft, unedited: it becomes `changelog[].generated` on the wire.
- `POST /items/{id}/classify` asks the optional change classifier what kind of change the working copy would publish. See [Change classifier](#change-classifier).
- `POST /items/{id}/refresh` republishes a thread to re-bake quotes whose source has a newer version. See below.

## Change classifier

Optional and **off by default**: nothing below happens until Settings → AI
names a decision model in `ai_model_classify`. A decision model (Cloudflare's
Clef or Clef-flash on Workers AI, or TypeSafe's Jev) answers typed questions
with probabilities and writes no text, so `GET /ai/models` marks it
`kind: "decision"`, `ai_model_classify` accepts only a decision model, and the
text functions (`ai_model_tk`, `ai_model_changelog`, `ai_model_feed`) refuse one
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
as a chip the author can change or clear. With `change_category_in_note` (on by
default; it matters only while the classifier is on) the dialog also writes the
category into the note, where the author sees it before confirming:

- an empty note becomes the bare word, `minor`;
- a note becomes `minor: <note>`;
- a note that already starts with a category word is left alone.

The server never rewrites a note. Send `note_generated: true` only when the note
is exactly the machine's text: a drafted note led by the classifier's own
category, or the classifier's bare word on an empty note. A category changed by
the author, or a category prefixed to the author's own words, is not generated.

`POST /items/{id}/publish` takes an optional `change_category`: the category the
author confirmed (`null` for cleared; omitted, a classification made for exactly
these words stands). It is kept with the version in studio-private storage
(migration 0030, `change_class`: category, model, probability, classified_at,
overridden) and read back as `change_class` on each version in
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
Reading, subscriptions, hoppers, signals, settings and the public feed. It uses
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
  body: { mode: "blank", kind: "fragment", content_md: "A new draft" },
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
    source: { subscription_id: "subscription-id", remote_id: "source-id" },
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
New subscriptions are not in the public `blogroll.opml`; `PATCH /subscriptions/{id}` with `in_blogroll: true` adds one.

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

While the experimental `hopper_feeds` setting is on, a URL naming one of a blyg's public hoppers (its page or its feed, as the blyg's manifest lists them) resolves to that hopper: the proposal has `kind: "hopper"`, with `hopper` and `blygTitle`, and confirming creates a hopper subscription (`hopper_feed` set). `whole_blyg: true` subscribes to the whole blyg instead. Proposed, pending a protocol ruling: see `docs/hopper-feeds.md`.

The Studio's OPML import works this way. It reads the file in the browser, flattens folders and sends one request at a time, about one a second, which stays under the owner's write budget of 120 writes a minute (`API_WRITE_LIMIT`).
Delegated clients have less room: 120 a minute per grant, and 60 a minute shared by every grant (`API_DELEGATED_WRITE_LIMIT`), so a token-bearing importer should go slower than one a second and honour `Retry-After` on 429.

## Partial edits

PATCH changes only supplied fields.
Omitted fields retain their values.
Null clears only fields that explicitly allow null, such as an item's `stub_of`.
Unknown JSON fields fail validation rather than disappearing silently.
Preferences use booleans, not database integers or strings such as `"on"`.

```ts
const item = await unwrap(BlyggerApi.updateItem({
  client,
  path: { id: blank.id },
  body: { content_md: "Revised text", responses: "hide" },
}));
```

Item edits accept `content_md`, `kind`, `stub_of`, and `responses`.
The response policy is `default`, `show`, or `hide`.
Kind becomes fixed after the first publication.
Fork lineage and generation provenance cannot change through PATCH.

All requested changes must pass schema and domain validation before a write.
Item and hopper writes guard the state that their domain rules used.
If that state changes during the request, the API returns 409 without applying the patch.
Reload the resource before deciding whether to repeat the edit.
These guards do not provide general revision control for concurrent text edits.

Pinning uses PUT because repeating the same pin has the same effect.
A pin is permanent, including after withdrawal.
Deletion discards an unpublished draft. Withdraw a published item instead.

## Read and poll

Collection reads return `{ items, total, offset, limit }`.
Use `offset` and `limit` to read another slice.
Reading also returns source counts and the selected source.
Mentions also return the requested direction.

```ts
const reading = await unwrap(BlyggerApi.listReading({
  client,
  query: { offset: 0, limit: 25 },
}));
for (const item of reading.items) console.log(item.key);
```

Reading defaults to 25 entries and accepts at most 50 per request.
Other paginated reads accept at most 100.
Search defaults to 20 results.
Collection queries limit the rows they return before resource conversion.
Totals, sorting, and large offsets can still scan rows in D1.
An offset past the end returns an empty array.
Invalid pagination returns 400.

Poll `/reading` to read the current D1 state.
Polling does not fetch remote feeds. The existing subscription cron still does that.
The planned SPA polls visible reading data every 15 seconds and pauses in hidden tabs.
The API sanitizes imported HTML before it returns reading bodies.

Item detail includes the item fields, `authored_kind`, media, versions, and the published version.
Version resources include their kind, including threads with no transclusions.
Item and version references use objects, and flags use booleans.
Imported protocol metadata retains its existing serialized JSON fields.
Subscription resources omit internal HTTP cache fields.
Hopper detail includes `total` and `source_count`.
Use `?preview=true` for an index preview of three memberships and bodies.
The default hopper detail still includes all memberships and bodies.

## Imported reading feed

`GET /reading` is the Studio's timeline: own and imported entries together,
sanitized HTML only, paged by offset. A client that syncs what the owner reads
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
- Paged by an opaque cursor over `(observed_at, subscription_id, remote_id)`.
  Pass `next` back as `cursor`; `next` is null on the last page. One poll run
  stamps one `observed_at` on everything it imports, so ties are common and
  the cursor resumes inside one. Rows observed after a walk began sort ahead
  of its cursor, so a poll between two requests neither shifts nor repeats the
  walk; start a new walk from the top to collect them. A cursor this server
  did not issue is 400.
- `limit` defaults to 50 and accepts at most 100; outside 1–100 is 400.

```ts
let cursor: string | undefined;
do {
  const page = await unwrap(BlyggerApi.listImportedReading({ client, query: { cursor, limit: 100 } }));
  for (const entry of page.items) console.log(entry.subscriptionId, entry.remoteId, entry.readVersion);
  cursor = page.next ?? undefined;
} while (cursor);
```

## Read state

A client that keeps "read" for imported items can store it here, so a post read
on one device reads as read on the owner's others. Each reading row holds one
number: the highest version the owner has read. It is Studio-private. No public
page, feed, item document, `blyg.json` or export reads it.

- `PUT /reading/{sub}/{remoteId}/read` with `{ version }` stores the larger of
  the held and requested values and returns `{ ok, stored, read_version }`.
  A replay or a stale client never lowers it.
- `POST /reading/read` with `{ items: [{ sub, remote_id, version }] }` does the
  same for up to 500 rows in one transaction and returns `{ ok, received }`.
  Any malformed entry fails the whole request with 400, and nothing is written.
  The batch is one request against the write budget, however many rows it marks.
- A row this server does not hold, by subscription or by item, is acknowledged
  with 200 and `stored: false`, never 404. Clients may read a 404 from these
  routes as "this server keeps no read state".
- `GET /reading` returns `read_state: true`, and each imported entry carries
  `readVersion`: an integer, or null when unread. A client can rely on the flag
  rather than probing the write routes. Each imported entry also carries
  `version`, the version held here: `readVersion` below it means a newer
  version arrived after the owner read it, and it is the value to send when
  marking the entry read.

### Marking unread

- `DELETE /reading/{sub}/{remoteId}/read` clears the row and always returns
  `{ ok: true, stored: false, read_version: null }`. It is idempotent, and an
  unknown subscription or item is 200 as well, never 404.
- `POST /reading/unread` with `{ items: [{ sub, remote_id }] }` clears up to 500
  rows in one transaction and returns `{ ok, received }`, validated whole like
  `POST /reading/read`.
- `GET /reading` returns `read_state_clear: true` when the server supports both.

A clear leaves a tombstone: the server records `unread_at`, its own time of
the clear, and `readVersion` reads null. Both read writes accept an optional
`read_at` (ISO-8601 with `Z` or an offset; on `PUT` beside `version`, in the
batch on each item), the time the client read the post:

- A read whose `read_at` is earlier than the row's latest clear is ignored.
  `PUT` answers `stored: false` with whatever is held; the batch skips that row.
  Nothing changes, so no revision advances.
- A read with a later `read_at`, or the same instant, applies.
- A read with no `read_at` applies, as before clearing existed. Send `read_at`
  from any client that queues reads offline, or a queued read can undo a later
  "mark unread" from another device.
  The Studio acts online and sends none, so its reads always apply.

A clear resets the row, so the next accepted read stores its own version
rather than the larger of it and the value held before the clear. From there
reads are monotonic again. The tombstone stays after a read applies, so a
second stale read is still refused.

`read_at` is compared as an instant (the server normalizes it to UTC) against
the server's clock. A client whose clock runs fast can make a read look later
than a clear that followed it; one that runs slow can have a fresh read
ignored. Clients that cannot trust their clock may omit `read_at` and accept
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
