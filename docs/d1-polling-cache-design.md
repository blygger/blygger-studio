# Trigger revisions, Studio change checks, and R2 feed revalidation

Working design v3, updated 2026-10-06, upstream `3192d37`. The user selected ordinary
Query Collection caching inside `queryFn`: fetch new data when its revision
changes, otherwise return its existing cached response. The feed rules below
include the stress-test repairs. The frozen
[v1 specimen](../models/d1-polling-cache/design-specimen-v1.md) and original
Studio model remain historical evidence; `StudioQuery.tla` models this revision.
`FeedCron.tla` adds bounded timer checks to the feed safety model.

## Source and success standard

The user wants the existing polling speed, less D1 work, and little change at
application write points. The selected narrow surfaces are Studio polling and
`feed.xml`. The user accepts stale-while-revalidate for XML. No maximum stale
age or withdrawal exception has been selected.

The implementation uses trigger-maintained domain counters, revision-bearing
Query responses, stable feed renders and generation-bound conditional feed
replacement. TanStack Query schedules refetches; each `queryFn` checks a domain
revision and returns its cached response or fetches new data. Query Collection
owns materialization and optimistic state. Timed reads keep their scheduling.

Current source:

- `src/ui/query-client.ts`: live collections explicitly opt into 15-second
  polling. Query Client defaults contain no timer. Settings and authorizations
  refresh on return, reconnect, or writes without periodic polling.
- `src/ui/data.ts`: collections refetch their tracked active subsets; released
  Reading pages unload. Existing local optimistic
  edits and query collection behavior must remain intact.
- `src/reading-data.ts`: Reading loads all identities for ordering and counts.
- `src/api.ts:148-160`: working-copy edits need not change `items.updated`.
- `src/protocol.ts:217-346`: XML includes current published item content,
  publication events, media, settings, and quote provenance.
- `src/public-feed.ts:82-112`: provenance also reads subscription origin/title
  and imported kind/page, not just published own items.
- `src/importer/store.ts:73-104`: unchanged imports still change poll diagnostics.
- `src/owner-api.ts`: authentication/admission precede private handlers.

## Preservation contract

P1 user-required: keep Studio's 15-second cadence and hidden-tab behavior.
P2 user-required: record ordinary content changes without adding invalidation
calls at every write site. SQL migrations and reader/client code still change.
P3 source-established: inserts, edits, withdrawals and deletes remain visible;
unchanged item timestamps cannot be used as a complete change cursor.
P4 user-required: revision tracking belongs to the ordinary Query response
cache. Store fetched data and its pre-fetch revision together. Query Collection
owns publication, which can lag fetch completion during local edits.
P5 proposed: warm unchanged Studio polls skip watched collection SQL; cached
XML responses do not wait for a full render. Cheap checks remain D1 work.
P6 user-accepted: saved XML may be older than D1 while revalidation runs. It must
be a legal complete rendering; successful older builds cannot replace newer ones.
P7 proposed: failed refreshes/builds remain dirty and retryable. No unconditional
eventual completion or bounded stale age is claimed.
P8 source-established: current private authentication/admission and optimistic
draft protections remain. No cached credential decisions are introduced.
Time-driven read effects, including the daily update check, remain scheduled.
P9 proposed: identity includes database epoch, deployment/origin/mount and
renderer/schema version. Restore/reset must not silently reuse old cursors.
P10 limit: a formal or SQLite fixture is not a deployed Cloudflare proof, actual
billed-row measurement, complete trigger matrix, or global single-flight proof.

## Design structure

M1 committed source and revision vector: fixed `change_state` row with an epoch
and counters for affected data domains, including the XML domain. Triggers
advance appropriate counters in the same transaction as actual row changes.
One trigger may advance several counters in one UPDATE. No append-only journal
is needed for change detection plus full refresh; that would be a later delta
sync feature. Counter movement is per relevant row effect, not per user command.

M2 dependency relation: source table/column effects -> domain counters ->
collection query functions/feed. Collection configs declare their domain.

M3 fetched Studio state: each exact TanStack Query key stores a response and
its epoch/domain revision. Query Collection selects rows from that response.
There is no application publication cursor or transaction inspection. Failure
or cancellation cannot record a new revision without its accepted response.

M4 reusable feed artifact: XML, its source revision, epoch, renderer identity,
and a conditional replacement token. ETag/HTTP validation names saved XML, not
the current D1 state. A 304 can legitimately refer to a stale saved feed.

M5 attempt: a refresh or build has captured source revisions, results, current
status, and expected replacement identity. Failure/reset can abandon an attempt.

M6 work observation: change checks, collection loads, feed renders, trigger
writes and remaining auth/admission costs are counted separately.

Rules:

R1 triggers record INSERT/UPDATE/DELETE effects atomically, including background
and direct SQL paths. UPDATE guards compare old/new values with null-safe
semantics. Tracking tables and security counters never track themselves.
Missing state rows, schema evolution and restore epochs need fail-safe handling.
Initialize the fixed state row in the migration before installing triggers.
Each tracked effect must abort if that row is absent; an UPDATE that silently
matches zero state rows is invalid. Do not recreate missing state during normal
writes with an old/default epoch. Review the dependency matrix whenever schema
or response fields change, including migration backfills.

R2 let live collections opt into TanStack Query's built-in 15-second polling
and visibility handling. Each actual `queryFn` invocation reads the fixed
revision row afresh. If its exact-key cached response has the same epoch and
domain revision, return it; otherwise fetch complete data for that collection
or on-demand subset. Timed update-state and security reads remain live.

R3 store `{ data, generation }` in the existing Query cache and use the adapter's
`select` to extract rows. Capture the generation BEFORE loading data, using
primary D1 reads; never label the result with a later revision. Query's accepted
response owns both fields, so canceled/failed fetches cannot advance a separate
token. Query Collection owns cancellation, materialization, subset ownership
and optimistic edits. A fresh content response can be cached while collection
publication waits behind a local edit; the application need not inspect that
queue or refetch solely because publication lags.

Do not share a cached revision check across query functions: a mutation refetch
must not join a check that began before the write. Each query function performs
its own cheap check. Mounted views can therefore make several cheap row reads
per timer tick; there is no one-check-per-tick guarantee. An old in-flight Query
may be joined according to normal Query behavior, but its response keeps its
old pre-fetch token, so a later invocation will still fetch a changed revision.

Reading remains on-demand. Its cached page retains counts and offset alongside
the rows. Query Collection observers poll each tracked subset. If startup fails
before mount, the existing Retry control restarts the
failed derived view. No custom adapter or new row-delta protocol is introduced.

R4 cached feed is served immediately; unconditional and conditional requests
both schedule a revision check. If source token equals artifact token, do not
render or rewrite. A missing object needs a blocking initial build. Failed
background work keeps the last good artifact and remains eligible on later
requests. A separate minute cron also checks and warms the canonical site from
Settings by calling the same feed handler with HEAD. It shares existing SWR
coalescing: joining a pre-write render leaves the newer source revision dirty
for the next tick. No separate warming or acknowledgment algorithm is needed.
Blank/invalid canonical
URLs leave request-driven rebuilding intact. Cron retries are attempts, not a
maximum-stale-age or unconditional convergence guarantee.

The minute job does not scan subscriptions or perform housekeeping. Subscription
polling keeps its 15-minute schedule; legacy imported-URL repair and expired
inbound-mention cleanup run daily. No write handler needs a rebuild hook.

R5 feed renderer uses a monotonic-consistent source read path, samples source
revision before/after its multi-query render and discards a changed interval.
It cannot label arbitrary partial mixed data with the newest revision. This is
an analyst-added prerequisite, not already implemented in buildFeedXml.

R6 publication uses the expected generation-bound replacement token captured
BEFORE rendering. If the observed artifact is newer than the build target,
stop. Conditional replacement, rather than a separate metadata preflight,
protects against an intervening publication. On conflict, reread the winning
artifact and stop if its generation already satisfies the target. Otherwise
perform another cheap source check before deciding to rebuild; never blindly
retry the old PUT or rerender without checking the winner. Mutations after
validation can still leave the artifact temporarily stale; SWR permits that window.
After the bounded render attempts, reread the same R2 key and serve a valid saved
artifact if another builder installed one. Keep its recorded generation; do not
publish unchecked bytes. A truly empty cache can still fail under continued
source churn. This is a safety contract, not guaranteed cold-request availability.

R7 bind the generation into the saved XML bytes using a canonical, valid XML
comment after the XML declaration. The comment includes the database epoch and
feed revision; cache identity also includes renderer/deployment/origin/mount.
Use a safe encoding that cannot introduce an invalid comment delimiter. The
R2 ETag then names generation-bearing bytes; custom metadata can duplicate the
revision for lookup but is not the atomic replacement guard. Plain XML ETag
plus revision-only metadata is rejected because repeated visible bytes permit
an old builder to overwrite a newer artifact. Validate distinct generation
ETags and stale-PUT rejection with the real R2 path before claiming that handoff.

R8 duplicate background renders are possible across isolates. Local pending
promises reduce duplicates only locally. A global rebuild claim/lease is not
included in this candidate: a global work bound remains unresolved. A lease,
if later selected, must have recovery/expiry and is extra D1/platform work.

R9 restoring/replacing the database must establish a fresh epoch before service
resumes. A restored copy of the old epoch is not fresh. Clients reload on epoch
change; revalidation treats an epoch mismatch as a cold generation, and builders
started against an old artifact must lose their conditional replacement after
the new generation is installed. Restore/deploy tooling owns this lifecycle
step; trigger counters alone cannot perform it. Renderer upgrades change cache
identity and force a new feed build. This lifecycle is outside the current models.

## Dependency preview, not a complete migration

| Source effects | Studio domains | XML domain |
| --- | --- | --- |
| Item working-copy changes | Items/detail | Only if fields read by XML/provenance change; draft text alone excluded |
| Publish/withdraw/version changes | Items/detail/Reading | Yes |
| Media changes | Items/detail | Media association/rendered fields |
| Settings | Settings/update-state | Feed title, bio, byline, canonical URL, timezone used in citation rendering |
| Imported content | Reading/hopper detail | Imported kind/page used in uncited provenance |
| Subscription title/origin/membership | Subscriptions/Reading/hopper detail | Provenance title/origin effects |
| Subscription poll diagnostics | Subscriptions | No |
| Hoppers/membership/signals | Hoppers/detail/signals | No direct XML dependency found |

For the implementation, spell out watched-view dependencies separately from
counter names. Hopper detail watches imported HTML and membership as well as
hopper rows; Reading watches subscription existence/title/origin as well as
own/imported entries; XML watches attribution joins as well as own publication.
The existing prototype is conservative and not the final dependency matrix.

Deletion and changes moving a row between categories must cover both OLD and
NEW dependencies. UPDATE OF alone detects named columns, not changed values.
SQL columns added in future must be reviewed against renderers and consumers.
Conservative over-tracking is safe for values but may reduce work savings.

## Receiving tests and cost checks

Before implementation is accepted, exercise actual readers and direct SQL
writes against fresh DTO/XML results. Include unchanged timestamps, deletes,
NULL transitions, source renames, direct HTML repair and diagnostic-only polls.
Keep the missing-delete and missing-state controls so incomplete tracking is
detectable. Check schema additions and backfills against the dependency map.

Studio tests must hold a refresh while another mutation commits, fail one of
several view refreshes, cancel a refresh, mount a previously unmounted view and
cross the daily update-check deadline without a database change. Observe
accepted cached responses, their pre-fetch tokens, adapter-published data and
scheduled effects. Include canceled loads, failed revisions, a mutation racing
an older revision check, and overlapping subset ownership.

Feed tests must cover body repetition across generations, mutations between
render reads, simultaneous builders, conditional 304 revalidation, interrupted
background work and conditional cold creation. On a losing PUT, verify that a
winner satisfying the target causes no additional full render. Cold creation
must not blindly overwrite a concurrent winner; the conditional-create path
needs its own receiving witness and is outside the current preexisting-object model.

Measure rows read and written separately under matched Studio/feed/import
traffic. Include fixed-counter writes, admission/auth work and duplicate renders.
The SQLite probe's 100 imports caused 100 extra counter-row updates; this is
not D1 billing evidence. Tighten over-tracking only with dependency tests intact.

## Concrete limits and open branches

The feed may retain pre-withdrawal bytes during SWR or repeated rebuild failures.
No prior immediate-freshness law carries over automatically. A hard stale-age
cutoff or withdrawal gate is a separate policy, not silently selected here.

D1's primary/session reads and R2's conditional operations do not form one
cross-service transaction. Safety concerns legal source renders and monotonic
artifact replacement, not instantaneous alignment with the latest D1 commit.
The configured minute cron can retry after readers stop. Endless writes, missing
configuration and failed providers still have no unconditional progress guarantee.

Triggers remove caller notification obligations, not dependency maintenance.
The implementation uses a migration, one change endpoint, ordinary Query
functions, a feed read/revalidation helper and tests. Auth/admission writes remain.
The fixed counters add row writes per mutation; batches/imports can amplify them.

## Provider basis and receiving checks

- [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/):
  batches are transactions; default non-session reads use the primary; sessions
  can begin at primary or a bookmark and preserve sequential consistency.
- [SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html): row
  triggers, WHEN and UPDATE OF semantics. SQLite fixture evidence alone is not
  D1 deployment evidence; migration/runtime verification remains required.
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/):
  object custom metadata, ETags, conditional put and strong object consistency.
  Actual ETag/generation behavior needs a receiving provider witness.
- [Workers context](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil):
  background lifetime is finite; later-request retry must cover interruption.

Controlled models check the above candidate rules independently of production
rendering. Receiving tests must exercise the real Studio/feed routes and D1/R2
behavior before any production correctness or quota claim.
