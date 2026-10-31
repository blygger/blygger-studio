# Breaking API cleanup plan

GitHub tracker: [issue 92](https://github.com/blygger/blygger-studio/issues/92).

Use shared domain operations for state changes, a thin operation catalog for
the client contract, and explicit policies for each HTTP response class. Each
contract-changing PR updates REST, the generated SDK, Studio, and MCP together.

This plan starts from upstream `2582d73`. It covers the private API cleanup and
the HTTP defects found alongside it. The public Blygger protocol keeps its
content, citation, lineage, disclosure, and retained-media semantics.

## Settled scope

- Serve REST at `{mount}/api`, with a hard cutover on path-mounted deployments.
  Root deployments remain at `/api`. Remove the old root API on mounted nodes.
- Regenerate and update the SDK and Studio in the same release. Publish a
  migration note for other clients. Compatibility aliases are unnecessary.
- Prefer explicit resource shapes and state rules over preserving accidental
  private API shapes.
- Use ETags for cacheable representations. Use `immutable` only for fixed bytes
  at a URL containing their content hash. A version number alone is insufficient.
- Keep CI scheduling, image mirroring, download reliability, and release-gate
  policy outside this PR. Update existing test fixtures when the API changes.

## Architecture

| Layer | Owns | Does not own |
| --- | --- | --- |
| Domain operations | Resource rules, validation premises, conditional transitions, coherent attachment membership, typed outcomes | HTTP requests and MCP messages |
| Operation catalog | Operation IDs, input/result schemas, authority requirements, input-dependent scopes, feature requirements, effects, work-budget class | A general workflow or transaction language |
| Representations | Explicit private resources and public projections, including their mutable dependencies | Database-row serialization as an API contract |
| Adapters | REST request parsing, SDK generation, MCP argument encoding and result/error mapping | A second implementation of resource rules |
| HTTP policies | Final headers, cache validation, CORS, method responses, and provider forwarding | Domain permission decisions inferred from HTTP verbs |

Reuse the existing model, importer, reading, and media functions where they
already express the right rule. Extract route-local logic when adapters need
the same operation. Avoid wrappers that merely rename an existing function.

REST and MCP call the same operation runner after verifying the request's
identity and audience. The runner checks authority, input-dependent scopes,
feature availability, and the work budget before invoking domain logic.
Resource-dependent authority is checked with the state used by that operation.
MCP stops constructing synthetic REST requests; its Base64 upload adapter
decodes into the same media input that REST's multipart adapter supplies.

Keep five scopes independent. Keep grant administration owner-session-only.
Preserve per-grant work principals, revocation, audience separation, and
request-local identity. A mount change must not broaden an existing grant.

### Operation descriptions

Extend the current shared declarations rather than create a second registry.
Each description names the handler and its schemas, base authority,
input-dependent permission rule, feature requirement, effects, and budget class.
Use typed functions for rules that depend on inputs or resources; do not try to
serialize executable policy into OpenAPI.

Derive permission documentation, MCP hints, and method inventories from these
facts. Model effects explicitly: preview renders without persisting domain
state; link classification can perform network reads and cache writes; editing
response visibility changes public output immediately. HTTP verbs alone cannot
supply those distinctions.

Include owner-only administration and schema delivery in the HTTP method
inventory without adding them to delegated MCP tools.

## Addresses and discovery

Resolve deployment URLs once: public base, Studio, API, OAuth issuer, MCP, and
media. Routing, OAuth resource identifiers, metadata, challenges, `Location`,
OpenAPI servers, Studio boot data, and SDK setup use that resolver.

Generated operation paths are relative to the API base. For example:

```ts
createBlyggerClient({ baseUrl: "https://example.org/nested/blyg/api" });
```

Studio receives the canonical API base from the server. It does not assume the
host root or infer the mount from its current route. Preserve the existing
mount-relative discovery direction; add no host-rooted well-known endpoint or
public protocol manifest field.

Mounted REST grants carrying the old `/api` audience will need reauthorization
or replacement. Do not silently retarget them or accept both audiences. Root
REST grants and unchanged MCP audiences need no audience migration. Document
the break in grant UI and client migration notes. Keep cookie scope unchanged
unless the address change itself requires a correction; cookie hardening is not
a reason to alter the established auth model here.

Keep OpenAPI independent of runtime settings and the caller's scopes. Add an
authenticated `GET /capabilities` that reports the current contract version,
canonical endpoints, and available operation IDs filtered for this caller.
Allow any valid owner/delegated identity to inspect its own capabilities;
requiring `owner:read` would exclude a client holding only `reading:state`.

Compute declared, compiled, enabled, and caller-granted states separately.
Capabilities and MCP discovery use the same availability calculation. Listing
an operation means some permitted input is possible; conditional fields can
still need extra scopes. Document those conditions, and recheck them at
execution. Discovery is never an authorization cache.

This preserves the extension framework already merged in PR 52; it adds no new
extension system. The default `extensions.json` compiles the browser extensions
`inspect` and `reading-time`. The optional `lineage-glyph` contributes API read
routes to the static catalog, while the default server extension list is empty.
Those possible-but-unavailable routes are the concrete discovery case to fix.

## Private resource contract

Use camelCase for private API fields. Write schemas explicitly instead of
extending database-row schemas. Database column names and public protocol keys
keep their existing forms. Preserve remote protocol objects and unknown remote
members as remote data; do not recursively rename or overvalidate them.

Own item resources distinguish authored kind, publication state, working state,
and immediate presentation preferences. Published snapshots have their own
version identity. Return structured provenance, references, and media instead
of serialized JSON columns. Imported resources also expose structured stored
metadata, with the existing safe fallback for damaged columns.

Keep large collections out of detail responses. Add explicit paged version and
hopper-membership reads; item detail includes the working copy and current
publication, not every historical body. Studio loads history when needed.

Use one page envelope:

```ts
{ items: T[], page: { limit: number, nextCursor: string | null } }
```

Use bounded keyset cursors with a unique tie-breaker, bound to collection,
filters, and ordering. Replace HTTP offset pagination at the cutover; TanStack
DB can still request offset/limit windows internally. Return counts as named
summaries where the UI needs them, rather than require a total for every page.

### TanStack DB pagination

Use the existing on-demand Query Collections. Their query functions consume
`meta.loadSubsetOptions`; translate supported predicates and ordering before
paging, and reject unsupported expressions. For opaque API continuations, use
TanStack's `createCursorPager` to supply requested windows. Keep the small
adapter that maps the API page envelope to its `{ rows, nextCursor }` result.
Do not extend the application's current `pages()` loop into a cursor engine.

For growing UI windows use `useLiveInfiniteQuery`, which adjusts the live
query's window. Its query function is not a TanStack Query infinite query:
`getNextPageParam` does not belong there. DB's cursor expressions are separate
query hints, not the API's opaque continuation token. Follow the chosen
adapter's documented contract and test tied sort values explicitly.

Keep row queries and cursor-page caches under sibling keys. The page key
identifies the source, filters, order, and change generation; window size and
offset do not define a different server sequence. A generation change must
invalidate the cursor sequence as well as the row queries. A collection refetch
alone can reuse still-fresh cursor pages. Preserve cancellation and existing
pre-load generation labels.

The server still owns ordered-sequence consistency. It need not retain a
database snapshot across HTTP requests: bind continuations to the relevant
generation, reject a continuation when that generation changes, and have the
adapter discard that acquisition and restart. Page construction must check its
generation against the rows it returns. Do not present partial pages as a
successful complete demand or treat a short response as authoritative exhaustion
when a continuation remains. `/changes` remains an invalidation signal, not a
row-delta or durable synchronization cursor.

Verify this integration against the lockfile's TanStack versions before changing
the loader. Source inspection alone is not a runtime compatibility check.

Give domain failures a stable error code, a human message, and optional typed
details. Map the same failure to REST status/body and MCP error content. Keep
OAuth and native provider errors in their protocol-defined formats. Update
schema errors and generated SDK error unions with the new private contract.

Media resources return canonical, mount-aware URLs rather than R2 storage keys.
The same URL can require authentication before publication and become public
after publication; no credential appears in the URL.

## Coherent item transitions

Add a private item revision independent of the published version number.
Advance it atomically when relevant working, presentation, media membership,
or publication state changes. All writers, including generation and internal
refresh paths, participate in that rule.

Item mutations require the expected revision. Creation supplies the first
revision; subsequent reads and successful mutations return the new revision.
A stale revision returns a typed conflict before applying the transition.
REST and MCP carry the same precondition. Do not substitute a text hash, a
published version number, or a validator for an unrelated representation.

Validation and commit must refer to the same state. Use conditional SQL and D1
transactions where state spans rows. Long-running generation and remote reads
must recheck their captured premises before installing results. A failed
commit must not leave partially changed memberships or orphaned new media.

Discard restores the complete working attachment membership as well as text
and citation state. Restore preserves retained version media and the existing
rules for generated-text disclosure; published stripped text does not recreate
the original TK authoring scopes or their positional provenance cache.

Persist an explicit distinction between a normal empty publication and a
withdrawal snapshot. Projectors, pinning, and restoration use that distinction,
not `!content_md`. Backfill states that retained data can establish. Leave
ambiguous historical rows explicitly unclassified in the new stored state and
preserve their existing interpretation on reads. Every new version writes
explicit state. This keeps upgrades automatic without inventing historical
intent from empty text or a publication note.

Keep retries specific to each operation. Pinning and read-state updates retain
their existing repeat-safe behavior. A lost response to a publication or draft
creation must not cause an automatic blind retry. Conditional revisions prevent
reapplying a transition against changed state; they do not recover the result
of a successful request whose response was lost. General idempotency-key
storage is a separate feature, not an implied guarantee of this cleanup.

## HTTP response policies

Apply policy to the final response after dispatch, including native `Response`
objects. Set policy before early exits can escape it. Do not use one global
public cache or CORS policy across private API, public wire resources, OAuth,
and MCP.

| Response class | Validator and cache policy | Browser and error behavior |
| --- | --- | --- |
| Mutable public JSON, HTML, RSS, OPML, and stable asset URLs | ETag identifies the full representation; clients can revalidate. Preserve safe existing HTML/feed generation keys and TTL behavior. | GET/HEAD and matching 304 preserve required metadata. Public wire errors and preflight retain the intended CORS policy. |
| Public bytes at a verified content-hash URL | ETag plus long public caching and `immutable`, only while all byte-affecting inputs are fixed | Keep type, SVG isolation, and nosniff protections. |
| Private API, private media, owner UI, token responses | Preserve `no-store`; no shared cache of user state or authorization decisions | Errors, size limits, denials, and forwarded responses follow their class policy. Any validator is evaluated only after current access checks. |
| OAuth discovery and signing metadata | Keep provider-specific public metadata policies explicit | Preserve native headers and apply the intended CORS policy to the actual returned response. Authorization UI remains a separate class. |
| Temporary public absence | Explicit policy that permits availability to change without a stale negative response masking it | Missing/draft/unpinned resources and disabled features keep deliberate status and CORS behavior. |

Pinned JSON stays revalidatable: its author and origin still come from current
settings. Its ETag covers the complete JSON, not only `content_hash`. A pin URL
containing a version number is not a content-hash URL.

New uploads compute a digest for every file and return a hash-bearing URL, for
example `{mount}/media/{id}/{sha256}.{ext}`. Verify the digest in the path against
the stored file metadata. Keep the attachment ID in the address so unrelated
private/public media rows do not collapse into one globally public digest URL.
Private media remains private and `no-store` even at a hash-bearing URL.

A hash in the URL alone is not enough: the retention rule must also prevent
replacement or deletion during the advertised fresh lifetime. Use revalidation
for a media object that remains eligible for deletion.

Existing random-ID media URLs remain valid because historical public content
already names them. Serve them with validators and revalidation instead of
advertising immutable caching. No rewrite of historical publication bytes is
needed. New fingerprinted Studio assets may use immutable caching; stable
service-worker, manifest, and shell URLs retain policies suitable for updates.

Support conditional GET/HEAD consistently, including wildcard and list forms.
Preserve bodyless HEAD/304 behavior. Permit browser conditional reads on the
public wire routes that support cross-origin reads. Expose ETag, Retry-After,
Allow, Location, and authentication challenges where their response class
allows browser access; allow the matching request headers in preflight.

Private media reads returned by bearer uploads must support the intended
bearer CORS flow without publishing the bytes. Keep cookie-only owner requests
under the current origin protections. Match OAuth route identity consistently
with trailing-slash routing so the authorization endpoint does not gain CORS.

Use the complete registered method inventory for 405/Allow, including owner
administration, OpenAPI delivery, MCP, and enabled Webmention. Disabled
Webmention remains absent. Define cookie-only authentication failures
deliberately; do not add a misleading Bearer challenge to a cookie-only route.

## PR sequence and review checks

Use the bounded PRs below. PR 1 splits into 1a and 1b. Every merged PR leaves
the repository runnable and its API, SDK, Studio, and MCP mutually compatible. Each can be released on its own;
batching release tags is not a reason to depend on unfinished code. Keep public
protocol fixtures and existing revision-cache behavior green throughout.

| PR | Scope | Review boundary and checks |
| --- | --- | --- |
| 1a Correct existing resource transitions | Restore attachment membership on discard and guard text used for provenance validation. | Fix observed defects using the current private contract. Reproduce each failure and verify retained media, restoration, and generated disclosure. No migration or general expected-revision contract. |
| 1b Explicit version state | Distinguish empty publication from withdrawal. Include the snapshot-state migration and historical-data policy. | Separate from 1a because stored historical rows can be indistinguishable. Preserve public artifact bytes and verify pin/restore behavior and upgrade policy explicitly. |
| 2 HTTP responses and validators | Final response-class policies, complete-representation ETags, conditional GET/HEAD, no-store on early exits, CORS, preflight, exposed headers, and complete method responses. | Keep URLs and resource shapes stable. Cover public errors, mutable pin metadata, native OAuth forwarding, trailing-slash authorization, private media, and MCP method errors. Hash-addressed media is PR 8. |
| 3 Shared operation core | Extend existing operation definitions with scope/effect/feature/budget facts; extract shared domain calls; have REST and MCP use the same runner. Add capabilities and consistent enabled-tool discovery. | Preserve existing payload shapes and URLs. Keep typed domain failures internal until the error-contract cutover. Verify conditional permissions, owner-only exclusions, budget principals, audience separation, and all 32 scope subsets. |
| 4 API mount cutover | Canonical deployment URLs; `{mount}/api` routing and audiences; OpenAPI servers, challenges, Location, discovery, SDK base URLs, and Studio boot data. | One address break, with payloads unchanged. Root and nested deployments work; mounted root aliases and old mounted REST audiences are rejected; unchanged MCP audiences remain isolated. Update client migration notes and interop fixtures. |
| 5 Conditional item mutations | Add the private item revision, expected-revision inputs, atomic whole-state transitions, and safe installation of long-running results. Update every participating writer and client. | One concurrency-contract change, without a general resource rename. Test competing edits, attachment/publication races, generation completion after another edit, stale conflicts, retry behavior, and database upgrade. |
| 6 Explicit private resources | Replace row-derived schemas with intentional camelCase DTOs, structured stored metadata, canonical media URLs, and stable public-facing private API error codes. Update SDK and Studio together. | One representation break, with existing pagination behavior retained. Preserve remote protocol objects and unknown members; keep private presentation sanitization separate from raw public snapshots. Verify generated artifacts and actual SDK consumers. |
| 7 Cursor pages and TanStack loading | Common cursor page envelope, bounded history/membership reads, server sequence validation, on-demand loaders using createCursorPager, and native live-query window controls where appropriate. | One loading-contract change. Verify ties, filters/sorts, growing windows, exhaustion, cancellation, generation invalidation, and restart after an expired cursor. Remove all-pages loading and custom UI continuation bookkeeping where replaced. |
| 8 Hash-addressed media | Digest-bearing URLs for new uploads and eligible fingerprinted assets; immutable caching only where bytes and retention permit it. | A storage/URL change separate from general HTTP repair. Old published media URLs survive with revalidation; invalid digest paths fail; unpublished uploads remain private; retained references continue resolving after detach/withdraw. |

The main dependency path is PR 1a, then PR 3, then PR 5 and PR 6, followed by
PR 7. PR 4 follows PR 3 and can proceed separately from PR 5. PR 2 can proceed
independently; PR 8 builds on its validator policy and can proceed separately
from the operation refactor. Merge PR 4 before the final consumer checks for
PR 6 and PR 7 so the final examples use canonical mounted URLs.

The first implementation pass confirmed that the snapshot-state backfill can
be ambiguous, so PR 1 is split into 1a and 1b. The selected policy preserves
legacy behavior for ambiguous rows and requires explicit state for new versions.
PR 1b does not block unrelated fixes or the operation refactor. Track
implementation findings and stack state in
[API cleanup progress](api-cleanup-progress.md).

Each PR includes its relevant docs, generated artifacts, changelog/version
changes, and migration notes. Run focused regression checks during development
and the repository's required CI before merging. Contract changes also need
SDK drift checks, typecheck, SDK consumer verification, and relevant UI flows;
schema migrations need upgrade checks. Run existing OAuth/MCP interoperability
checks when addresses or dispatch change, without altering their CI policy.

Test domain invariants and observable responses rather than mirror catalog
declarations. No deployment is part of preparing these PRs.

## Source basis

- Shared contract and SDK history: [PR 21](https://github.com/blygger/blygger-studio/pull/21)
  and [PR 22](https://github.com/blygger/blygger-studio/pull/22).
- Shared scoped access: [PR 34](https://github.com/blygger/blygger-studio/pull/34)
  and [omitted-resource fix 66](https://github.com/blygger/blygger-studio/pull/66).
- Static schema and runtime capabilities:
  [PR 61 discussion](https://github.com/blygger/blygger-studio/pull/61).
- Mount migration: [issue 70](https://github.com/blygger/blygger-studio/issues/70),
  with the compatibility period superseded by the hard-cutover decision here.
- Cache and method audit: [issue 87](https://github.com/blygger/blygger-studio/issues/87).
- CI infrastructure is separate: [issue 73](https://github.com/blygger/blygger-studio/issues/73).
- Native pagination integration: [TanStack Query Collection](https://tanstack.com/db/latest/docs/collections/query-collection),
  [cursor pager source](https://github.com/TanStack/db/blob/main/packages/query-db-collection/src/cursor-pagination.ts),
  and [useLiveInfiniteQuery](https://tanstack.com/db/latest/docs/framework/react/reference/functions/useLiveInfiniteQuery).
- Existing boundaries: `src/contract/`, `src/permissions.ts`, `src/owner-api.ts`,
  `src/mcp.ts`, `src/extensions/server.ts`, `src/model.ts`, `src/protocol.ts`,
  `src/index.ts`, `src/html-cache.ts`, `src/feed-cache.ts`, and
  `src/ui/revision-query.ts` at the source commit above.
