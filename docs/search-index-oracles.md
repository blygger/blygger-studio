# Search index oracle evidence

This record accompanies the PR #146 merge of `fce415353212ee0e5601409e9be6e3e0ffa1397f`
with `origin/main` at `480fc6a`. Migration `0050_search_index.sql` keeps the
original search implementation; the added search tests now use the installed
`@tanstack/oracles` framework.

The adopted promises come from `docs/search.md`, PR #146's original tests,
and Venkatesh Rao's backup review on 2026-11-20. No search semantics changed
in this test migration.

| Previous witness | Oracle receiving it |
| --- | --- |
| ID/body substrings, short narrowing terms, literal URL and quotation mark | `search-index-source-history`: all query results and continuation availability |
| Import replacement, retained pin, deletion | `search-index-source-history`: queries before and after each source change |
| Working edit, republish, withdrawal | Same property through real PATCH/publish/withdraw requests, checking each mutation response |
| Scoped indexed work and both cursor orders | `search-index-bounded-work`: ordered identities, continuation, every source statement, total `rows_read`, and FTS lookups per request |
| Backup exclusions and restore | `search-index-backup-restore`: real owner archive, empty-search witness after deletion, restoration with items before versions and versions before items |
| Polling bookkeeping and 100-import write comparison | Existing `polling-cache-counted-work`: unchanged model and checks; L0 fixtures isolate tracking writes from FTS segment writes |

The source model stores separate working/publication strings and current import
facts. It uses ordinary substring comparisons, without production helpers, SQL,
or FTS. The work model filters and sorts source facts as an array, then slices
pages at widths one and two. This preserves both terminal and nonterminal tails.
The restore model predicts identities from known source facts, rather than
capturing search output as an expected snapshot.

Design grammar was relevant because the source model branches on actions.
Its state has three independent obligations: working words survive edit,
published words survive until republish, and held import words survive a retained
pin but disappear on deletion. Each distinction has a query that fails if the
corresponding values are merged. The preservation relation is the same original
observations at each source-change/query checkpoint. Source snapshots per action
were another possible representation; the reducer avoids repeating unchanged
source facts. No production transitions are imported into it.

## Verification

`npm run test:oracles:search` runs the two gap gates selected in Check and the
release fallback. Final runs have 16 passing baseline tests and no reported
nondeterminism:

- All seven generated mutations of `src/search-terms.ts` are killed, zero gaps.
- All six authored controls in `test/fixtures/search-index-mutants/search.json`
  are killed at the intended laws, zero gaps. This is a targeted mutation
  selection for the read operation, cursor helper and backup predicate, rather
  than a claim about every mutation of those entire files.
- The source property rejects a lost retained-pin result. Work calibrations
  reject excess row reads, a duplicate statement and a missing statement.
  Restore calibration rejects a missing imported result.
- The existing polling-cache oracle passes all 203 tests with FTS installed.
- Desktop and mobile Chromium search click-throughs pass all eight tests.
- The full ordinary Worker suite passes 1,885 tests across 168 files (five
  existing skips). The full UI suite passes 317 tests. Typecheck, oracle lint and the oracle
  migration inventory check pass.

The lexical gap run initially exposed an untested NUL boundary. The retained
histories now query a NUL-containing term alone and beside an indexed word;
removing the NUL guard is rejected. This preserves the distinction between
candidate filtering and a truncated FTS MATCH expression.

Two independent reviewers used the installed `oracles-review` skill. Both found
that an early version lost the original API mutation path and observed only the
last source statement per request. Each reviewer ran a discarded-duplicate-query
control: 14 baseline tests passed and that mutant survived as `not-observed`.
After the fixes, the same retained control is killed by `indexed search work`;
both reviewers re-read the fixes and confirmed the final 16-test/13-mutant run.
No oracle law or expectation was weakened to clear these findings.

The FTS-aware fixture snapshot uses writable columns, preserves explicit rowids,
leaves virtual/shadow tables to SQLite and rebuilds external-content FTS after
restoring source rows. This fixes the former cleanup failure on protected FTS
shadow tables while preserving trigger restoration and cleanup diagnostics.

## Scope

These are bounded, enumerated receiving histories, not generated coverage over
all source histories. The ordinary picker/draft tests remain. The model covers
only the text and lifecycle inputs named in its limits; Unicode case-folding,
concurrent publication and the full cross-product of restored source states are
not claimed. The restore fixture includes a clean publication and a current
import, with both source-table orders.

The suites apply migrations to their local D1 bindings, but seed their fixtures
afterwards. They establish current-schema lifecycle/restore behavior, not
backfilling a preexisting installation. That upgrade path is separate migration
verification.

ORC-001–003/005–006/009–010/012–014/016 are addressed by the authority,
independent models, receiving paths, per-query comparisons, calibrated controls,
cleanup, versioned evidence and explicit local-provider scope above. ORC-004,
007 and 015's generated-grammar requirements do not apply to this finite
enumeration. ORC-008's state distinctions are recorded above. No generated run
budget, fixed seed or constructed history was removed.
