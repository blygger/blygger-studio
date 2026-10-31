# API cleanup progress

The implementation follows [the cleanup plan](api-cleanup-plan.md). Record
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
| 1a Attachment restore and provenance validation | Open, local checks and all CI checks passed | `codex/api-cleanup`, based on upstream `main` at `2582d73` | [90](https://github.com/blygger/blygger-studio/pull/90) |
| 1b Explicit version state | Legacy-data policy settled, planned | Not created | Pending |
| 2 HTTP behavior | Local checks passed, publishing | `codex/api-http`, based on `codex/api-cleanup` | Pending |
| 3 Shared operation core | Planned | After 1a | Pending |
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
- PR publication: pending.
