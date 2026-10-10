# Tests and their limits

The Worker suite runs against local workerd, D1, and R2 bindings. Browser tests
run the bundled Worker in Miniflare. Release verification extracts the actual
Worker and SDK downloads before exercising them.

```sh
npm ci
npm run typecheck
npm run test:ui -- --maxWorkers=2
npm test -- --maxWorkers=2
npx playwright install chromium
npm run test:e2e
npm run test:upgrade
npm run test:mutations
npm run release:build
npm run release:verify
```

## In CI

`check.yml` runs its jobs in parallel: `check` (build, typecheck, release
build and verify, the Worker, UI and upgrade suites), `sdk-generation`, `e2e`,
and one `mutations` job per suite, with auth-security split into its worker and
browser halves. On a pull request, `scripts/ci-scope.ts` decides which of the
slow jobs to run: e2e runs unless every changed file is documentation, and a
mutation suite runs only when the PR changes a file it mutates, a test it
runs, its own script, or something every suite shares (`package.json`, the
workflows, the test configs, migrations). The file lists come from the suites'
own `file:` and `test:` fields, so a new mutant needs no CI change. A push to
`main` or a manual run runs every job, and `release.yml` publishes only after
that run on the tagged commit is green (it runs the suite itself only for a tag
that never went through `main`). A newer push to a pull request cancels its
older run. Playwright retries once in CI; a test that passes on retry is
reported as flaky.

Read the [project glossary](glossary.md) before naming model states or observations. The [auth oracle map](auth-oracles.md) and [security oracle map](auth-security-oracles.md) describe the OAuth/MCP tests and their limits.

The lifecycle, pagination and PATCH oracles keep their laws beside the model and comparisons. The collection-walk witness and browser save oracle also state their fixture boundaries and omissions. Replay, cleanup and mutation harnesses explain what evidence they preserve; a failed setup is not a caught product bug. Use the glossary's terms when changing any of these files.

## Independent oracles

The generated oracles follow the
[oracle-writing guide](oracle-tests.md).
Their models do not import production transitions, comparators, schemas, or
resource projectors. The lifecycle, pagination and PATCH oracles call the
generated SDK against the actual Worker. Mention delivery calls the production
queue and sender against real SQLite through local D1.

| Owner | Promised result and checkpoint | Domain and limits |
|---|---|---|
| `test/item-lifecycle.oracle.test.ts` | After every action, owner content/status/history and public current/pinned snapshots match a small independent model. Restore keeps the version counter. pins keep their content. | Nonempty plain-text fragments and threads. sequential edit, publish, withdraw, restore, and pin. No TK, references, forks, concurrent publication, or deletion claim. |
| `test/pagination.oracle.test.ts` | Every signals page and the complete ordered walk match independent sorting and slicing, including row values, duplicates, and exhaustion. | Static collections of 0–25 records, three timestamp values, and page widths 1–10. No snapshot guarantee across writes and no database-cost claim. |
| `test/patch-atomicity.oracle.test.ts` | A subsequent owner read preserves every field after rejection and changes only requested fields after acceptance. | Draft content, kind, response preference, and citation clearing. Invalid enums, malformed citations, and immutable fields. Separate controlled race cases change kind, citation, and withdrawal state before the guarded SQL write. No promise about concurrent text-edit conflicts. |
| `test/mention-delivery.oracle.test.ts` | Discovery and successful delivery match an independent longest literal-prefix model. Check the complete request trace, stored queue state and absence of redelivery. | Generated names, source kinds, insertion orders and 49–96 byte origins. Each input includes parent/nested prefixes, an RSS decoy, a wildcard-looking nonmatch and an unrelated 58-byte origin. Controlled HTTP responses. No retry, incoming verification, cron or production DNS claim. |

Each normal campaign runs eight histories with seed `20261001`, then eight
histories with a fresh random seed. Both use the same generator, recorder,
comparison, and budget. Fixed examples force important transitions that a small
random campaign could miss. These are bounded checks, not a proof of all histories.

To replay a failure, use its reported seed and shrink path:

```sh
ORACLE_TARGET=item-lifecycle ORACLE_SEED=123 ORACLE_PATH='0:1:2' npm test -- --maxWorkers=2 test/item-lifecycle.oracle.test.ts
```

The other targets in this table are `pagination`, `patch-atomicity` and
`mention-delivery`. Replay mode selects
only the named replay test. It does not first run fixed or random campaigns.
These generators use arrays, not `fc.commands`. no command replay path exists.
`test/oracle-replay.test.ts` captures a deliberate failure and checks direct
seed/path replay of its reduced input.

Failures retain the first input, violated checkpoint, and original exception.
Fast-check reports the reduced input and replay information separately. A
candidate that fails at a different checkpoint cannot replace the first failure.
Worker test isolation releases fixture state after each test. Generated
histories own their records. the signals oracle resets its table between histories.

## Grammar and checker evidence

- **Lifecycle:** both kinds and the fixed publish → pin → repeated pin → edit →
  publish → withdraw → restore → publish history are reachable. Generated actions
  choose from the current model's legal actions. Restore/pin cannot precede a
  content version. withdrawal cannot precede publication. Removing version history
  loses restore. removing pin state loses repeated-pin results. merging public
  and withdrawn status changes which action is legal. Content tokens span 0–999.
  generated histories contain 1–10 actions. Empty-content publication is excluded.
- **Pagination:** fixed cases force an empty table and eleven tied records over
  width-three pages. Generated width one reaches adjacent page boundaries.
  Removing ties loses secondary ordering. removing multiple subscriptions loses
  composite-key ordering. removing width changes loses page-boundary variation.
  Width zero is invalid and excluded. Checker controls reject reordered,
  duplicated, omitted, and stale-valued rows.
- **PATCH:** a fixed case requests every modeled field with each rejection
  branch, including a schema-valid citation rejected by the fragment rule.
  Generation selects any field subset and one of five validation states.
  Removing a field axis loses preservation/change checks for that field. removing
  invalid requests loses atomic rejection. Changing citations and changing kind
  remain separate race cases because each independently authorizes a write.
  The checker rejects a result that applies only the valid content field.

The lifecycle checker rejects rewound history and changed pinned content.
It also retains the complete wire response from the first pin read and compares
all later reads with those exact bytes. It never overwrites that reference.
These controls calibrate comparisons. `npm run test:mutations` also checks the
full production path in an isolated copy. Green baselines precede seven mutations:
missing pins, wrong restored text, ignored offsets, reversed tie order, restored
mention `LIKE` lookup, shortest-origin selection and inclusion of RSS origins.
Each must fail at its named semantic checkpoint. Setup errors and timeouts do
not count as caught mutations. Logs remain in `build/mutation-*.log`.
These checks do not cover every conceivable production mutation.
The mention `LIKE` mutation also captures its failing seed and shrink path and
replays them through `ORACLE_TARGET=mention-delivery`. Replay must reach the same
delivery-result checkpoint. Its log is `build/mutation-mention-replay.log`.

## Integration evidence

- `test/sdk-operations.test.ts` calls all 39 named SDK operations with and without
  owner authentication. Adding a route without a matrix entry fails the test.
  It checks status, response shape, and no-store headers. Generate, subscription
  creation, RSS resync, and published deletion deliberately exercise error paths.
  their success behavior is not credited by this matrix. Shared Zod schemas
  check shape, while independent oracles judge the modeled meanings.
- `test/collection-walks.test.ts` checks exact complete walks for items,
  subscriptions, hoppers, inbound/outbound mentions, reading, and search. It checks
  tied timestamps where an established tie order exists. Search uses distinct
  timestamps rather than inventing a tie contract.
- `test/stored-resources.test.ts` isolates malformed and wrong-shaped stored JSON
  through SDK reads. Valid citation and provenance
  data survive damage in another column. Stored bytes remain unchanged.
- `e2e/save-oracle.spec.ts` drives both editors through failed saves, session
  rejection, recovery, failed save before publication, and delayed autosaves.
  A response-loss case commits the real PATCH, then aborts its browser response.
  The editor keeps its text, reports failure, and recovers on a manual save.
  The delayed case records request invocation before network delivery. It can
  therefore detect overlapping saves without relying on a request arriving late.
- `e2e/mounted-studio.spec.ts` uses a real HTTP proxy forwarding only `/notes/b/*`
  and `/api/*`. It checks login, embedded SPA loading, saving, upload, and imported-response
  creation in desktop and mobile Chromium. This establishes local proxy behavior,
  not the route settings of an uninspected live Cloudflare deployment.
- `test/sdk.test.ts` lets the Worker commit a creation, then throws a transport
  error instead of returning its response. One request produces one stored item.
  The SDK reports failure and does not retry. Caller retries have no idempotency
  guarantee.
- `scripts/verify-sdk-consumer.ts` installs the release tarball offline in a
  fresh project. Node imports the package by name and checks read/write/upload/auth.
  TypeScript checks NodeNext and browser Bundler resolution without `skipLibCheck`.
  A wrong-type request must fail type checking. Browser bundling must select the
  browser export. Chromium runs that bundle against the extracted Worker.
- `scripts/verify-persistence.ts` stops one Worker process and starts another
  with the same temporary D1/R2 storage. It checks drafts, full owner history,
  pins, frozen citations, session validity, and exact uploaded bytes.
  Public pin reads must return 200 before their bytes count as observations.
  This checks a clean local restart, not crash recovery or remote durability.
- `scripts/verify-upgrade.ts` executes the actual 0.8.3 upgrade script against a
  local synthetic release. Offline installation reuses linked dependencies but
  runs the real postinstall build. The real typecheck and SDK/Worker smoke suite
  run. The fixture routes the migration command to local D1, checks the new index,
  declines deployment, and rejects unexpected commands. It does
  not establish registry availability, remote migrations, config-conflict
  resolution, or Cloudflare deployment. CI's preceding `npm ci` independently
  checks a fresh dependency installation. A fault control removed postinstall
  from the temporary release. The old script then failed its real typecheck gate
  because `sdk/dist/browser.js` was absent. This reached the intended gate, rather
  than failing during fixture setup.

## Guide review record

This record is versioned with the tests it reviews. Its evidence applies to the
repository revision containing this file, within the stated domains.

| Requirement | Evidence or limit |
|---|---|
| ORC-001 | Each oracle identifies its API/established-behavior authority and exclusions in its opening comment and the owner table. |
| ORC-002 | Expected results use local records and plain rules. no production semantic helpers are imported by models. |
| ORC-003 | Each oracle file exposes contract, model, grammar, SDK driver, and checkpoint comparisons. Campaign mechanics are directly named in `oracle-campaign.ts`. |
| ORC-004 | Grammar reconstruction, axis removal, ranges, and nearby invalid histories are recorded above. No claim of exhaustive arbitrary histories. |
| ORC-005 | Real SDK/Worker executions compare public results after awaited actions. exact arrays retain duplicates, omissions, and order. Campaigns record execution. |
| ORC-006 | Each checker rejects explicit wrong answers. Four production mutations fail at named semantic checkpoints. Browser tests failed on the prior editor code at the intended save/publish/order checkpoints, then passed after the fix. |
| ORC-007 | Equal-budget fixed/random campaigns and direct target/seed/path replay. replay calibration is executable. No commands generator. |
| ORC-008 | Lifecycle retains working copy content, status, snapshots, kind, and pins: edit/read, withdraw, restore, publish, and repeated pin distinguish those states. Other models are stateless recomputations. |
| ORC-009 | Model `content` maps to API `content_md`. snapshot index + 1 maps to the public version number. Authored kind remains distinct from withdrawal kind. |
| ORC-010 | Named checkpoint failures retain the original input/cause and reject reductions with another checkpoint. Worker isolation owns cleanup. upgrade temporary repositories use `finally`. |
| ORC-011 | Owner and public lifecycle reads provide separate observations. No second independent implementation is claimed. shared-fault risks in unmodeled rendering remain open. |
| ORC-012 | This table records all guide obligations and scope limits. No complete bug-class closure is claimed beyond the named laws and histories. |
| ORC-013 | Empty/width-one/tied page boundaries, repeated pin, restore after withdrawal, and valid-plus-invalid patches distinguish nearby weaker rules. Unmodeled limits remain open. |
| ORC-014 | Worker/D1 evidence is local. Race tests supply controlled ordering. the HTTP proxy supplies known forwarding ranges. Production Cloudflare scheduling and live route configuration remain unverified. |

### Mention delivery review

This record applies to the repository revision containing the named oracle and
mutation controls. The executable oracle states the law, independent reference,
grammar, receiving driver, comparisons and limits beside the checks.

| Requirement | Outcome and evidence |
|---|---|
| ORC-001 | Discovery §2.3.4 and established longest-origin behavior supply the authority. The oracle limits its claim to successful delivery routing. |
| ORC-002 | The reference scans an array with `startsWith`. It imports no production classifier or SQL. Network responses depend on the requested URL, not the reference answer. |
| ORC-003 | Contract, model, grammar, driver and named comparisons remain visible in `mention-delivery.oracle.test.ts`. |
| ORC-004 | The grammar reconstructs long unrelated and matched origins, nested prefixes, RSS decoys and literal percent characters. The opening comment explains each axis, its ablation, bounded range and excluded invalid origins. |
| ORC-005 | Real migrated SQLite receives production enqueue/discovery/delivery calls. Exact request arrays, queue rows and a second idle drain observe omissions, misrouting and redelivery. |
| ORC-006 | Production mutants restore `LIKE`, select the shortest origin and include RSS. The runner requires assertion failure at the intended checkpoint. Setup errors, timeouts and surviving mutants fail calibration. |
| ORC-007 | The same property runs eight inputs with seed `20261001` and eight without a seed. The mutation runner captures and directly replays seed/path at the same checkpoint. No commands generator exists. |
| ORC-008 | No stateful reference model. Each subscription snapshot recomputes its expected route independently. Each uses a fresh target so saved endpoints cannot bypass discovery. |
| ORC-009 | The model origin selects the expected manifest URL. Distinct receiving endpoints identify routing. Source kind maps to the public `f` or `t` path. The independent queue projection compares documented delivery fields. |
| ORC-010 | The shared campaign preserves the first checkpoint through shrinking. `withOracleCleanup` releases the source, mentions and owned subscriptions while retaining operation and cleanup failures. |
| ORC-011 | Review found no concrete shared model/production semantic fault requiring a second formulation. Independent SQL versus array selection remains the primary judgment. |
| ORC-012 | This table records all numbered outcomes. The claim remains bounded to the stated routing grammar and receiving path. No complete mention-system closure is claimed. |
| ORC-013 | Every input receives the long-origin premise and parent/nested/RSS/wildcard neighbors. The restored `LIKE` and wrong-selection controls distinguish weaker rules at delivery and trace checkpoints. |
| ORC-014 | SQLite supplies the actual LIKE failure locally. A read-only production D1 query also received that error and accepted the replacement prefix query. HTTP responses remain controlled. Live DNS, delivery and cron behavior remain unverified by this oracle. |

## Open coverage

- Database scan cost remains owned by the performance work in `migration.md`.
  Exact pages and few returned rows do not prove cheap queries.
- The SPA PR owns visibility/focus polling, stale-read rejection, and cache/write
  interaction tests. The retained UI tests do not establish those future laws.
- Part three owns real ecosystem-client request fixtures and OAuth/MCP behavior.
- Generation success across the HTTP SDK boundary still needs a controlled
  provider fixture plus a stated handoff to each supported real provider.
- D1/R2 fault handling, upload orphan cleanup, and crash recovery remain open.
- Browser coverage is Chromium desktop/mobile. Firefox and WebKit behavior is
  not established by these runs.

## SPA cutover coverage

Legacy Studio HTML and inline-script assertions are replaced by browser checks
against the production bundle. Public-page, API, lifecycle, grammar, and malformed
storage tests remain in the Worker suite. There is no separate development SPA.

| Contract | Tests |
|---|---|
| Ordered draft saves, stale acknowledgements, generation queue | `test-ui/state.test.ts`, `e2e/save-oracle.spec.ts` |
| Polling, hidden tabs, focus, cache eviction and route preload | `test-ui/state.test.ts`, `e2e/spa-studio.spec.ts` |
| Navigation, themes, editor kind/history/pins, quick edit, bracket paging | `e2e/parity.spec.ts` |
| Frozen imported HTML, retained withdrawals, legacy actions, hoppers | `e2e/parity.spec.ts`, retained importer API tests |
| Mentions, response policy, source guidance and update preferences | `e2e/parity.spec.ts`, retained mentions/response/update tests |
| Mounted authentication and asset forwarding | `test/mount.test.ts`, `e2e/mounted-studio.spec.ts` |

The browser suite runs each case in desktop and mobile Chromium. It does not
prove behavior in every browser or establish live Cloudflare route settings.
Reading requests return 25 bodies per page; counts and offset scans can still
read more D1 rows. Large compose/catalog collections load in batches of 100.
These limits are not a database-cost or concurrent-edit conflict guarantee.

The 5,000-signal fixture in `test/review-regressions.test.ts` measures D1
`rows_read` for a ten-row slice at offset 100. Without the ordering index,
the slice scanned at least 5,000 rows. With migration 0013, the test requires
at most 500 rows. This excludes the count query and is a local D1 result.
It does not establish total polling cost for a live site.

## Public homepage read budget

`test/public-page-performance.test.ts` uses real local D1 and measures database
calls and `rows_read`. A 100-card mixed page needs five render queries, or seven
when local or legacy remote citations need lookups. Settings and item selection
add two queries. The budget covers both root and mounted HTTP routes.

The fixtures include 300 unpinned history versions, 2,000 unrelated media rows,
and 5,000 unrelated drafts. History bodies must not enter the render results.
The limited item query must use its ordered index without a temporary sort.
Content assertions cover pins, thread images, citations, avatar metadata,
blogroll output, empty pages, and the 100-card lookahead boundary.

The new read budgets reject the prior renderer. A separate comparison against
that renderer produced identical complete HTML for the mixed-card, citation,
and empty-page fixtures. No copy of the old renderer remains in production.

These budgets cover database work for the homepage. Published HTML size, the
number of pins and attachments, browser image loads, and database latency can
still affect response time. Archive and RSS generation have separate read paths.

## Remaining oracle prose pass

Lifecycle, pagination, PATCH atomicity, collection walks, browser save, replay, cleanup and mutation witnesses now state their laws, driver boundaries and limits beside the executable checks. The Worker rerun passed22 tests across six files. All40 save-oracle browser cases passed across desktop/mobile Chromium. Separate browser cases now use separate stable fixture edge addresses, so they retain real throttling without exhausting one shared login budget. Production policy and executable assertions did not change. AST comparison against HEAD confirmed comment-only changes in the six tracked Worker oracle/harness files touched by this pass.
