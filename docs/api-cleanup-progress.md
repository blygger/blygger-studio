# API cleanup progress

The implementation follows [the cleanup plan](api-cleanup-plan.md) and
[issue 92](https://github.com/blygger/blygger-studio/issues/92). Record
source findings, decisions, checks, and PR dependencies here as work proceeds.
Update the plan when a finding changes its scope or design.

## Decisions

- The private API can break. API, SDK, Studio, and MCP change together in each PR.
- Mounted REST moves to `{mount}/api` without root aliases or dual audiences.
- Validators cover complete representations. Immutable caching requires fixed
  bytes, a content-hash URL, and suitable retention.
- CI tooling reliability and scheduling remain separate from this series.
- Use TanStack's on-demand collection protocol and cursor pager rather than an
  application-owned cursor traversal engine.
- Ambiguous historical empty versions keep their existing interpretation.
  New versions store explicit state. Upgrades do not require manual classification.
- Use stacked PRs when a dependency is still in review. Each PR must leave its
  API and consumers working. Do not merge or deploy without a separate request.

## Stack

| Part | Status | Branch and base | PR |
| --- | --- | --- | --- |
| 1a Attachment restore and provenance validation | Open, restacked; prior CI green, new CI pending | `codex/api-cleanup`, based on upstream `main` at `2582d73` | [90](https://github.com/blygger/blygger-studio/pull/90) |
| 1b Explicit version state | Open, all local and prep-pr checks passed, CI in progress | `codex/api-version-state`, based on `codex/api-http` | [93](https://github.com/blygger/blygger-studio/pull/93) |
| 2 HTTP behavior | Open, reviewed and restacked, new CI pending | `codex/api-http`, based on `codex/api-cleanup` | [91](https://github.com/blygger/blygger-studio/pull/91) |
| 3a Operation policies and discovery | In progress; checkpoint retained during restack | `codex/api-operation-policy`, after 93 | Pending |
| 3b Shared operation execution | Planned | After 3a | Pending |
| 4 Mounted API cutover | Planned | After 3 | Pending |
| 5 Conditional mutations | Planned | After 3 | Pending |
| 6 Private resources | Planned | After 5, with 4 integrated | Pending |
| 7 Cursor pages and TanStack loading | Planned | After 6 | Pending |
| 8 Hash-addressed media | Planned | After 2 | Pending |

## Findings on 2026 10 31

### Historical empty versions need a separate migration policy

`withdraw()` inserts an empty `content_md`, while empty normal publications
can store the same text and default HTML/transclusion values. Older fragment
versions therefore need not retain enough data to distinguish the two intents.
Current item state resolves some latest versions but not every historical row.
The publication note is not a reliable discriminator.

Plan change: split the version-state migration into PR 1b. PR 1a contains the
attachment and validation repairs and needs no migration. No production data
was inspected or changed. The user selected preservation of existing behavior
for ambiguous legacy versions, with explicit stored state for new versions.

### Restore spans media membership and the item row

Working membership is `media.item_id`; published membership is `version_media`.
Restoring text alone could mark an item clean while leaving the wrong working
attachments. Restore now detaches additions and reattaches the selected
version's retained media in the same transaction as the text update. Every
statement guards the caller's captured item state. A stale restore changes
neither the item nor membership. Historical memberships and R2 bytes remain.

Discarded uploads are detached, not physically deleted. Garbage collection is
not part of this repair. Restoring a version with generated text still leaves
the working copy dirty because stripped text cannot recreate positional TK
authoring provenance.

### Provenance needs a conditional text premise

A provenance-only PATCH validates scopes against stored text. Its atomic guard
must include that text. A PATCH providing replacement text validates that
replacement instead and does not need a new general text revision rule here.
The deterministic tests cover both cases with a real competing edit.

### Dependency and review baseline

Upstream `main` still resolves to `2582d73` at the start of this implementation.
The fork's `origin/main` is 85 commits behind it, so PR comparisons target
upstream `main`. GitHub reports read-only upstream access. Dependent branches
therefore remain stacked on the fork, while upstream PRs target `main` and link
to their parent-relative comparisons. Main diffs include unmerged parents
until the stack advances. Dependencies were installed from the merged lockfile:
DB/React DB `1.0.0-rc.1` and Query Collection `1.5.0`.

## Verification for PR 1a

- `npx vitest run test/version-media.test.ts test/restore-version.test.ts test/patch-atomicity.oracle.test.ts --maxWorkers=2`:
  33 passed with the fix. With original production source and the new tests,
  four regressions failed and 29 tests passed. The fixed source was restored
  after that control.
- `npm run typecheck`: passed.
- Separate read-only reviews of restore/media and provenance/guard changes:
  no actionable findings.
- Full Worker suite: 150 files passed, 1,868 tests passed, five skipped.
- `npm run release:check`: passed for client 0.49.2.
- `npm run sdk:generate`: passed with no tracked artifact drift.
- PR publication: [PR 90](https://github.com/blygger/blygger-studio/pull/90).
- Upstream CI: all nine checks passed, including e2e, auth-security Worker/browser
  mutations, polling-cache/oracle mutations, OAuth interop, SDK generation, and scope.

The local Worker tests need a loopback socket, so they run with a narrowly
scoped sandbox escalation. Fixtures disable remote bindings and outbound
network access. This does not change the repository's CI policy.

## Findings for HTTP response policies

Hono's `Context.res` setter preserves headers from the prior response. Replacing
`c.res` with a cloned response can restore a cache or CORS header that the clone
changed or removed. Apply final policy with `Context.header` after dispatch.
The final route matcher also escapes literal regex characters, so an unknown
`openapiXjson` path stays 404. The native OAuth provider returns 404 for metadata
HEAD requests. The adapter maps HEAD to native GET and applies body removal and
validation after dispatch.

Native responses outside a Hono context still use an ordinary header-preserving
response wrapper. Receiving tests exposed this difference before publication.

Mutable public JSON, OPML, CSS, and feed reads revalidate. Their validators cover
the full representation. A live item's pin status and a pinned document's live
author/origin metadata can change its ETag without changing `content_hash`.
Private media validates only after current access checks. Legacy media URLs
contain random IDs, so this PR removes their immutable promise and supplies
storage validators. Hash-addressed uploads remain PR 8.

The native OAuth discovery TTL remains intact. JWKS gets an explicit public
revalidation policy. Token responses remain `no-store`. Authorization endpoints
have no CORS allow headers, with or without a trailing slash and on preflight.
Private body-limit errors and MCP origin denials also receive `no-store`.

The audit's cookie-only 401/challenge question remains a separate auth-contract
choice for the operation/error work. PR 2 does not add a misleading Bearer
challenge to cookie-only routes.

## Verification for PR 2

- Focused HTTP, HTML, media, mount, OAuth/MCP, and polling-cache tests: 276 passed.
- Typecheck passed after correcting test fixture types.
- Parent-source control: all 19 receiving tests failed on the parent source.
  The fixed source was restored after the control.
- Full Worker suite after the final fixes: 151 files passed, 1,888 tests passed,
  five skipped. An earlier run passed 1,886 tests and failed only the old
  `public, max-age=60` assertion, which now checks the intended revalidation policy.
- Final focused route, metadata HEAD, and OAuth regression suite: 121 passed.
- Final typecheck, release check for 0.49.3, and SDK generation passed.
  SDK generation produced no tracked OpenAPI or generated SDK drift.
- Read-only cache/resource, transport/header, and final-fix reviews completed.
  The transport review found the literal route matcher defect, now fixed and
  covered by the negative-path receiving test. Final review found no issues.
- PR publication: [PR 91](https://github.com/blygger/blygger-studio/pull/91).

## Findings for explicit version state

Owner history and eligibility used empty markdown as a withdrawal marker.
Public pinned pages and forks instead used transclusion-column presence.
Some live-item kind recovery used truthiness. A single legacy fallback would
change existing behavior, so unresolved old rows retain the rule at each read
boundary. New rows use explicit stored kind everywhere.

Migration 0034 leaves the field nullable because migration runs before Worker
deployment. The prior Worker can still insert its old column list during that
window. Backfill recognizes nonempty fragments, valid thread arrays, and known
current item state. It does not infer intent from note text or version parity.
Only the new field changes. Trigger guards include it so all relevant revision
domains change with it.

The audit also found Studio pin/restore controls gated on truthy markdown.
They now use the version resource's kind. The lifecycle oracle chooses legal
pin/restore actions from its own snapshot-kind model and generates empty edits.
Background reading, publishing history, quote links, RSS, fork citations, and
mention route checks use explicit authored kind while retaining legacy rules.

## prep-pr receipts

The user requested prep-pr for every PR after PRs 90 and 91 opened. Retrospective
parallel simplification and comprehensive code-review passes covered each frozen
branch diff. Both reviews found no actionable bugs or instruction violations.
PR 90 had no simplification suggestions. PR 91 had one optional P3 suggestion:
compile method matchers at API construction instead of each fallback request.
The user authorized evaluation and automatic repair of routine findings.
The matcher cleanup is evaluated, verified, and pushed on PR 91.

This repository does not use Changesets. The changeset skill stops without
creating a directory. Release notes and version fields follow the repository's
existing scheme. Evaluate review findings and apply routine repairs. Present only novel design
decisions to the user, as instructed on 2026-10-31. Then run its
CI-loop step against the published head.

## Verification for PR 1b

- Initial state/lifecycle/trigger/migration-shape suite: 174 passed, with two
  test-fixture selector failures corrected to use the reading entry's own ID.
- State, lifecycle oracle, and populated migration fixture: 14 passed.
- Parent-production control: all five new state receiving tests failed, then
  the candidate source was restored in a finally block.
- Browser regression: desktop and mobile both passed. The fixture uses browser
  fetch so the Secure owner cookie reaches the local HTTP fixture, and matches
  the actual restore sheet title.
- The real v0.8.3 upgrade entry point passed against a synthetic local release:
  offline install/build, migration acquisition including nullable version state,
  typecheck, SDK/Worker smoke, and explicitly declined deployment.
- Typecheck passed. SDK generation passed with no tracked generated drift after
  omitting the stored kind before extending the explicit Version resource kind.
- prep-pr found two missed fork paths: local pin-choice filtering and remote
  empty-content rejection. Four new receiving cases fail on the current
  candidate, confirming both findings. Both fixes are now applied after RED evidence confirmed the failures.
- Simplifier proposals: share the repeated authored-kind SQL expression while
  retaining the distinct pin fallback, and replace the backfill's proven
  fragment lookup with the literal fragment value. Both simplifications are applied after source evaluation.

- Full Worker suite before review fixes: 151 files passed, two files failed.
  1,896 tests passed, five skipped, and exactly the four new fork regressions
  failed. No additional failures. Final typecheck and release check passed.
- Tracking issue published and verified: [92](https://github.com/blygger/blygger-studio/issues/92),
  containing the full plan and unchecked delivery checklist. PRs are not marked
  complete until merged. GitHub connector creation returned integration 403, so
  the authorized CLI fallback created the issue successfully.

The earlier add/skip gates were superseded by the user's instruction to use
evaluate-review and present only novel design decisions. The five pending
items require no novel design choice. The scratch ledger preserves all original
claims, footnotes, technical verdicts, actions, test evidence, and destinations.
No scratch review ledger is committed to this branch.

## prep-pr review for PR 2

The retrospective code review found no new bugs. The simplifier suggested
compiling fallback method patterns once at API construction. Evaluation confirmed
that this preserves the static route inventory and its order. A temporary
executable counter measured 138 constructions across two fallback requests
before the change and zero during those requests afterward. Existing receiving
tests still distinguish literal paths, 404/405 statuses, and Allow headers.
The probe and its logs remain in task-local scratch, outside the PR.

The final focused suite passed 38 cases across the probe, HTTP response
contract, and MCP oracle. Typecheck passed. The user requested automatic
evaluation and repair of straightforward items, with only novel design decisions
presented for approval. This replaces the earlier add/skip and documentation
readiness gates for this series. The repo uses its existing version/changelog
scheme because it has no Changesets configuration.

The full series is tracked in [issue 92](https://github.com/blygger/blygger-studio/issues/92).

## Evaluation of prep-pr findings

PR 91 now compiles method matchers at API construction. PR 1b now includes
explicit empty publications in local fork choices and accepts empty strings
from remote pinned publications. Missing/null/numeric markdown and withdrawal
endcaps still fail remote fork creation. Legacy unknown empty rows keep their
old exclusion from local fork choices.

The three batched authored-kind readers share one SQL expression, with
code-owned aliases and their existing truthy fallback. The separate pinned
version nullness fallback remains. Migration 0034 uses the literal fragment
value after its predicate establishes that fact. The guarded JSON expression
and nullable old-Worker insertion window remain intact.

The child branch advanced from 437634d to PR 91's 51df219. Earlier evidence is
recorded against its original head. Relevant checks will run again against
the final child candidate before publication. The stash checkpoint remains
available at 6c4aacb until this work is complete.

## Final local results for PR 1b

All five evaluated review items are fixed. There are no open evidence gaps or
novel design decisions. The review ledger and raw claims remain in
`/tmp/blygger-api-review-evaluation`, outside the PR. Final loss audit: five raw
items, five fixed, none omitted, deferred, refuted, or awaiting a decision.
The correctness reviewer found both fork defects with precise consumer paths.
The simplifier found three valid small cleanups. Both passes were useful.

- Full Worker suite: 153 files passed, 1,904 tests passed, five skipped.
- Desktop/mobile empty-publication pin, restore, and history-to-fork: two passed.
- Focused state, lifecycle, fork, feed, and populated migration suite: 61 passed.
- Final typecheck, release check, and SDK generation passed. No generated drift.
- Actual old-version upgrade fixture rerun after migration cleanup: passed.
- Separate final review of the evaluated fixes: no actionable findings.

PR 91's method cleanup and retrospective PR descriptions are published. The
quiet CI heartbeat monitors the stack and checks review submissions/comments;
its local automation ID is `api-cleanup-ci`. It stops after tracked heads are
green and every discovered review item has a disposition.

Version-state publication: [PR 93](https://github.com/blygger/blygger-studio/pull/93),
stacked on PR 91. Final review audit: five items fixed, no unresolved evidence.

## Restack on PR 94 — 2026-10-31

The user requested the whole stack on [PR 94](https://github.com/blygger/blygger-studio/pull/94),
head `cb2fa974fe2914577bcd12510a580a8d9ed2c612`. All six API commits replayed
without patch changes. The branch order is dependency updates, PR 90, PR 91,
PR 93, then the unpublished operation-policy branch. The source analysis still
refers to its original upstream baseline.

The package baseline now has Better Auth/provider 1.7.14, MCP client/server
2.4.0, Cloudflare vitest-plugin 1.4.11, Miniflare 5.20261023.3-beta, Zod 4.6.7,
and Hono 4.13.14. TanStack DB/React DB remain pinned to 1.0.0-rc.1 and Query
Collection remains 1.5.0. Installed with the updated lockfile: zero audit findings.

Fresh combined-stack results on this dependency baseline:

- Full Worker suite: 153 files, 1,905 passed, five skipped.
- UI suite: 14 files, 112 passed.
- Studio and client-access browser suites: 34 passed across desktop/mobile.
- Typecheck, SDK generation without tracked drift, and local old-version upgrade
  fixture: passed. No deployment.

The browser run exposed a shared test fixture collision. Desktop and mobile
saved the same site title, so the second no-op emitted no PATCH. The test now
uses project/repeat/retry-specific titles while retaining the real PATCH/200,
saved-status, reload, and persistence assertions. A source-driven cardinality
probe proved retry values differ. A controlled browser probe deliberately
failed after its first successful save, then passed on retry. Scratch probes
stay outside the PR. The fixture repair is on PR 90 so every child inherits it.

The operation-policy checkpoint is retained at `2016bb93ecc8deefcde5105df61ed4fb25c0504f`.
Restack inputs, original remote heads for explicit push leases, range comparisons,
and logs are in `/tmp/blygger-api-restack-pr94`. CI monitoring paused during the
restack and resumes against the new published heads.

Part 3 has 64 existing operations and roughly 1,400 lines of route handlers.
Split its implementation into 3a (explicit policy facts and capability discovery)
and 3b (shared domain execution). This changes review size, not the agreed API
architecture or the hard-cutover decisions.

## Part 3a: operation policies and discovery — 2026-10-31

Extended the existing route declarations with scopes, conditional permissions,
feature requirements, effects, and work budgets. REST scope checks and work
admission use those facts. MCP descriptions and hints derive from them. Runtime
policy functions stay out of generated OpenAPI. Static extension routes stay in
OpenAPI and the SDK; discovery uses current compiled/enabled/granted state.

Added authenticated capabilities for every valid identity, including a grant
with only reading-state authority. The REST permission oracle covers all 32
scope subsets. MCP's real-credential oracle now covers all 31 valid nonempty
subsets; injected empty authority is tested separately. The larger real-client
matrix exceeded the shared test MCP budget, so test bindings now provide high
request limits, like the existing API fixture. Budget oracles still set small
limits explicitly. Production quotas stay unchanged.

prep-pr's parallel review found four small corrections. evaluate-review retained
all four raw claims and evidence in `/tmp/blygger-api-policy-review`. Discovery
work now runs only for discovery requests. REST owns live extension execution
checks. Uncompiled extension paths return 404, including direct calls. MCP hints
mark classification and signal replacement as destructive because they can
replace or delete existing data. Deterministic query probes reproduced 1 extra
preview query, 2 capability queries, and 3 extension queries before repair. They
now expect 0, 1, and 1 respectively. The same extension probe reproduced 405
before the unavailable-route repair and expects 404 afterward.

All 14 policy-specific cases pass after those repairs. The initial wider suite
passed 170 cases before the final review repairs. Final broad results follow.
No new design decision or plan change.

Restacked PRs 90, 91, and 93 now have all nine upstream CI jobs green at
`0d46c5c`, `9eed3a4`, and `694664e`. Reviews and inline comments are empty.
The heartbeat stopped after those heads completed. It resumes for new PRs.

Final part 3a results: 154 Worker files passed, 1,919 tests passed, five skipped.
UI: 14 files and 112 tests passed. Studio/client-access/extensions browser
flows: 38 passed across desktop/mobile. Typecheck, SDK generation, release
check and diff whitespace checks passed. The final independent review found
no further issues. Four raw review items are fixed, with no unresolved idea,
evidence gap or design decision. Version 0.49.5, no migration.

Part 3a is published as [PR 95](https://github.com/blygger/blygger-studio/pull/95),
head `9f43bf3`, on PR 93. The plan issue includes its results. CI monitoring now
tracks PRs 90, 91, 93, and 95.

## Part 3b: shared domain execution — 2026-10-31

Extracted 63 core operations and the two compiled extension reads from HTTP
handlers into typed domain handlers. They receive verified authority, the node
environment and URL, compiled extensions, a defer function, and validated data.
They receive no Hono context or HTTP request and return no Response objects.
REST and MCP call one runner. MCP no longer constructs synthetic REST requests,
FormData, or File objects. Both upload adapters produce byte input.

Existing create/fork/response, publish/refresh/withdraw, classification, warnings,
attachment rollback, and deferred mentions remain in their operation pipeline.
The runner catches input-schema failures separately from domain/output failures,
so damaged output remains an internal error. Multipart metadata is validated
before normalization, preserving rejection of invalid inline and item fields.

Initial parity/security suite: 197 passed. Additional direct-runner, media,
authority, budget, race and mention regressions: 46 passed. Typecheck passes.
prep-pr reviews and final broad verification are in progress. Version 0.49.6,
no migration. No plan change.

PR 95 CI found three stale security mutation anchors after policy extraction.
The controls now mutate the policy declarations and retain their original
semantic checkpoints. Highlight, avatar and draft-scope baselines pass; all
three broken controls fail at the required security assertion. Repair published
as `2dfca6e`. The operation-runner branch advanced to that parent without patch
changes. Its checkpoint remains `0e7681d` until publication.

Part 3b prep-pr/evaluate-review retained 11 claims, including preliminary
suspicions and documentation footnotes, in `/tmp/blygger-api-runner`. Four
correctness defects reproduced: disabled-method 405 instead of404, MIME case
normalization, missing admission on uncompiled tools, and raw infrastructure
errors from native MCP. Seven receiving cases failed before repair; the same
40-case suite passes afterward. A further tools/list error probe reproduced a
raw native-32603 message and now returns a generic message with the same code.
All54 boundary/auth cases pass. The body-limit suspicion conflicts with the
documented REST-only setting and fixed8MiB MCP envelope policy; a direct test
now states that distinction. No new design choice.

The simplifier removed dead media context/form state and the unused extension
HTTP adapter, shared Zod error formatting, and named body-only policy input
ScopeInput. Domain output-schema failures remain500 rather than client400.
Server extension callback docs and client-access dispatch docs match the new
runner. Final independent review found no remaining actionable issue. Ledger
loss audit: 11 raw claims, 10 fixed, one refuted defect claim with its useful
boundary test retained. No omitted or unresolved idea.

The full run found two additional existing415 expectations that exposed a
missing REST media-type gate. Restored the installed Hono OpenAPI JSON/form
rules in the adapter. Typed decode failures still pass through shared scope
and admission checks. The two exact receiving tests and their47-case neighbor
suite pass. A final independent review found no further issue.

Final part3b results:155 Worker files passed,1,933 tests passed,five skipped.
UI:112 passed. Desktop/mobile Studio, client access and extension flows:38
passed after the media-gate repair. Typecheck, release check and generated SDK
without tracked drift pass. Four moved security controls and three authorization
controls reached their original semantic failure assertions, with two captured
replays. All81 exact mutation anchors match current source. Final loss audit:
12 raw claims,11 fixed,one refuted defect interpretation with its useful test
retained. No open evidence gap, omitted idea or new design decision.

Local validation must serialize SDK rebuilds with typecheck. One overlapping
browser build temporarily removed sdk/dist while tsc ran. Repeating tsc after
that build completed passed without a source change.
