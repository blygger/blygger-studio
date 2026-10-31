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
- Use stacked PRs when a dependency is still in review. Each PR must leave its
  API and consumers working. Do not merge or deploy without a separate request.

## Stack

| Part | Status | Branch and base | PR |
| --- | --- | --- | --- |
| 1a Attachment restore and provenance validation | Implementation and focused checks complete, preparing PR | `codex/api-cleanup`, based on upstream `main` at `2582d73` | Pending |
| 1b Explicit version state | Historical-data policy needed | Not created | Pending |
| 2 HTTP behavior | Planned | After or alongside 1a | Pending |
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
was inspected or changed. A policy for ambiguous legacy versions remains open.

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
- PR publication: in progress.

The local Worker tests need a loopback socket, so they run with a narrowly
scoped sandbox escalation. Fixtures disable remote bindings and outbound
network access. This does not change the repository's CI policy.
