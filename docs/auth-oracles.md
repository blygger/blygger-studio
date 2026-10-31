# Auth oracle contract and coverage

These tests cover the OAuth/MCP implementation. Their authority is decision #52 in AGENTS.md and the approved OAuth/MCP plan: one owner; scoped credentials; private-read separate from drafting and publication; resource-bound access; individual/all-grant revocation; cookie-only credential management; client-recorded generation provenance. Protocol checks come from OAuth PKCE (RFC 7636), resource indicators (RFC 8707), browser-bound consent and single-use authorization codes, and the MCP authorization discovery specification.

`test/auth-oracle-model.ts` is the independent reference. It does not import production scopes, permission classifiers, token parsers, storage, or the OAuth library. `test/authorization.oracle.test.ts` owns the instruction grammar, real Worker driver, and refinement checks. The driver logs in through the owner page and mints through the public authorization API. At completed-response checkpoints it compares HTTP decisions and challenges. The oracle does not treat an arbitrary failed request as an authorization success: each permitted request has a named expected status.

Use the [project glossary](glossary.md) for shared terms. Read the [oracle-writing guide](oracle-tests.md) before adding or changing a model.

## Read the tests as executable documentation

The auth and MCP oracle files now keep five layers together: contract, independent model, history grammar, production driver and refinement check. This follows the [guide change in TanStack DB PR1870](https://github.com/TanStack/db/pull/1870/files) and its [local oracle-writing guide](oracle-tests.md). The source links in each file identify the normative section or security guideline. Local policy is named separately; an RFC does not define Blygger's exact lifetimes, scope verbs or error statuses for every guard.

Start with the file's opening law. Then read the prose beside `AuthorizationModel.judge`, `OAuthModel.decide/exchange`, `expectedTools`, storage comparisons and security checkpoints. These comments explain why the retained state and observations can distinguish a plausible wrong result. Driver comments state when a fixture exercises production and when it substitutes a dependency or constructs its own provider configuration.

`auth-security.oracle.test.ts` owns the claim, replay, introspection, storage, log and transport rules. `verify-auth-security-race.ts` explains its one controlled cross-isolate schedule. `verify-auth-security-mutations.ts` explains why setup errors do not count as security RED. `e2e/client-access.spec.ts` explains the browser boundary and the same-site, cross-origin hostile ancestor.

Treat those limits as part of the contract. A plaintext-exclusion check does not prove hash strength. A receiving401 does not independently count all downstream side effects. One official client does not prove every client's discovery behavior. Production TLS, external logs, database access and deferred host-root publication remain named gaps.

## Model state

A credential retains its granted scope set, audience, expiry, model generation, and individual revocation state. Each field has a distinguishing next request: a different operation, a different resource, a request at expiry, a request after root invalidation, and a request after individual revocation. Model generation keeps revoke-all distinct from revoking one grant. Slots identify credentials in test histories; they are not client IDs or production token fields.

Consent retains browser binding, expiry and consumption. An authorization code retains PKCE verifier, client, redirect URI, resource, expiry and consumption. Refresh rotation and provenance observations need additional models/receiving tests; do not claim those boundaries are covered by the credential model.

## Grammar and controls

Generated histories have 1–14 instructions, three credential slots, all 15 nonempty subsets of the four scopes, two resources, and forward clock steps of 0, 1, 30 days minus one second, exactly 30 days, and 30 days plus one second. An initial live full-scope API credential supplies the premise for revocation/expiry. Mint, read, draft, publish, manage, wrong-resource, individual revoke, revoke-all, signing-secret invalidation, owner-password reset and clock advancement can be reconstructed directly as instruction arrays. Array histories use the shared fixed/random campaign with eight runs each; replay is seed plus shrink path, not `fc.commands` replayPath.

Removing expiry steps hides boundary errors. Removing either resource hides audience confusion. Removing partial scope sets hides implied-read/full-control faults. Removing individual revocation hides revoke-all substitution. Removing signing-secret rotation hides credentials surviving authority invalidation. Removing password reset hides accidental coupling between owner sessions and delegated tokens. Negative clock steps and empty mint scopes are excluded as invalid histories. Nearby hostile protocol requests belong to the consent/code driver, not this legal credential-history grammar.

Fixed witnesses reach expiry at T−1 and T, leave another credential live after individual revocation, separate draft from read permission, reject the wrong audience, and invalidate access after root invalidation. Checker controls reject an unauthorized 200 and access at the exact expiry boundary. A later mutation run must reach these named checkpoints; build/setup failures do not count as caught semantic faults.


### Storage history grammar controls

The storage campaign has its own grammar. Its controls do not follow from the credential grammar above. Histories contain 1–18 `put`, `delete`, or `advance` actions. Keys are `grant:a`, `grant:b`, `grant:%`, `grant:_`, `client:a`, and `consent:a`. Values are integers −10…10. TTL is null, 1, 60, or 600 seconds. Forward time steps are 0, 1, 59, 60, or 600 seconds. A read/list comparison follows each action. Lists use limit two and the prefixes empty, `grant:`, `grant:%`, `grant:_`, and `client:`.

Reconstruction: the fixed storage history preserves overwrite, deletion, literal percent/underscore, an expiring sibling, a non-expiring replacement, and a multi-page prefix. Its advance actions use an empty inactive key; replace that key with `grant:a` to obtain the same history within the generated record domain. The driver ignores key/value/TTL on advance and time steps on put/delete. Those inactive fields do not add semantic cases.

Ablation accounts for each semantic axis and overlap:

- Removing put, overwrite on the same key, or distinct stored values loses replacement-versus-retention observations. Removing delete loses absence after removal. Removing advance loses expiry transitions. Removing no-op time zero loses unchanged-state observations.
- Removing the two ordinary grant keys loses a surviving sibling. Removing the client/consent namespaces loses exclusion from grant-only lists. Removing percent or underscore loses the distinction between literal prefixes and SQL wildcard interpretation.
- Removing null TTL loses permanent records and expiring-to-permanent replacement. Removing finite TTL loses expiry. Removing the 59/60 pair loses the adjacent sixty-second cut; 1 and 600 supply smaller and larger marginal TTLs. An action after an elapsed interval separates read expiry from insertion-time behavior.
- Restricting histories to one action loses overwrite, delete-after-put and put/advance interactions. Longer histories within the bound repeat those transitions. More than two live matching keys reaches pagination; literal-prefix and expiry cases also run through that pagination observer. Removing that overlap could hide a cursor or expired-key error despite correct single-key reads.

Range: key count is bounded at six, values at −10…10, and history length at eighteen. A value of −10 or 10, TTL one or 600, and a step of zero or 600 need new parameter values, not new grammar rules. These are reachable domains, not a claim that an eight-run sample exhausts them. Empty lists, one key and more than two keys have distinct observation shapes. Larger key domains, arbitrary Unicode keys and histories beyond eighteen remain outside this campaign.

Exclusion: negative clock steps, zero/negative TTLs and unknown operations are outside the declared constants. A put with TTL zero is the nearby invalid grammar case; advancing by −1 is another. No production rejection behavior for those excluded inputs is claimed. The public adapter's treatment of invalid TTLs is a separate contract.

## Provider and revocation boundaries

Better Auth and its native OAuth Provider plugin run through the production Worker routes. Mounted OIDC discovery, consent, PKCE code exchange and real MCP tool calls are exercised at root, `/blyg` and nested mounts. Host-root `.well-known` publication is deferred. Successful mounted interoperability does not establish full RFC9728 or RFC8414 publication compliance.

Production authorizations are individual grants. One registered client can have several grants; deleting one grant must deny its credentials while leaving another grant usable. `oauth-grant-list.oracle.test.ts` observes this through the owner list, REST and UserInfo. `auth-security.oracle.test.ts` observes authenticated native introspection before and after grant deletion. Refresh replay revokes the grant family, including signed access tokens; the controlled two-isolate driver checks one pending-issuance race.

`better-auth-driver.ts` constructs a separate integration fixture with test-only owner bridge and introspection helpers. Its client-disable case tests native client registration revocation. It does not replace production grant-level tests or establish the production forwarding allowlist. Both paths use native provider APIs; no generated metadata or SDK output is patched.

MCP capability discovery covers all fifteen nonempty scope subsets. REST/MCP item and provenance checks compare receiving values. Binary upload parity, rejection without storage writes and the inclusive file-size limit have dedicated media oracles. Browser tests cover owner login, token management, actual framing refusal and OAuth consent without an external callback Referer.

## Oracle-guide review

This map records evidence and limits for the working implementation. It does not claim exhaustive security coverage or a committed-head conformance closeout. The [security oracle map](auth-security-oracles.md), [deployment requirements](auth-deployment-hardening.md) and [loss-audit evaluation](auth-security-evaluation.md) retain the exact evidence and remaining clauses.

| Guide rule | Current evidence and limits |
| --- | --- |
| ORC-001 | Decision #52, the approved plan, PKCE/resource contracts and declared model/fixture limits establish the expected laws. Storage's adapter contract is its bounded authority. |
| ORC-002 | Independent credential/consent models import no production semantic helpers. Storage recomputes from a Map; MCP tool capabilities are literal expected lists. Production driver imports are intentional. |
| ORC-003 | Named model and campaign companions, grammar definitions, real Worker/D1 drivers and named response/value checkpoints make the responsibilities distinct. No five-class format is implied. |
| ORC-004 | Credential controls remain above. Storage's separate reconstruction, ablation, range and exclusion account now appears above. Fixed OAuth/MCP/provenance cases make no generated-grammar claim. |
| ORC-005 | Worker-issued credentials and production mounted OAuth/MCP tool calls have explicit status/value checkpoints. Storage records the full raw paginated sequence. The test-only Better Auth fixture is not credited as production routing evidence. |
| ORC-006 | Wrong-result controls and three isolated production mutations distinguish scope, password-reset token survival and exact storage expiry. Only semantic assertion failures count; missing migrations, setup errors, signals, survival and missing checkpoint evidence are rejected. |
| ORC-007 | Normal fixed and seedless random campaigns use the same generator, recorder, check and eight-run budget. Direct replay selects only its target. The mutation runner now captures real generated authorization and storage counterexamples and reproduces them through `ORACLE_TARGET`, `ORACLE_SEED` and `ORACLE_PATH`, with the same named semantic checkpoint and reduced history. The generic `fc.check` replay calibration remains an additional library-level check. Array histories do not require `fc.commands` replayPath. |
| ORC-008 | Retained credential fields have distinguishing next requests; consent/code bindings are explicit in the independent predicates. Overwrite, expiration and deletion distinguish storage states under the next read/list. No per-field production mutant is claimed. |
| ORC-009 | Slots are history handles, not client IDs. Model generation combines root invalidation and revoke-all; `api` and `mcp` map to their concrete resource URLs. Browser labels map to binding-cookie possession. |
| ORC-010 | The campaign retains the first mismatch and requires the same checkpoint during reduction. `withOracleCleanup` retains a primary mismatch as cause, records each close error, and tries every release. Hostile cleanup calibration rejects both error masking and skipped releases, and does not waive close failures after successful work. |
| ORC-011 | A concrete shared production/model semantic-fault hypothesis and a different formulation were not established by this scan, so the conditional obligation is not triggered. REST/MCP item equality is bounded transport/value evidence; it does not independently establish common permission semantics. |
| ORC-012 | This consolidated map records ordinary new-oracle review outcomes and trigger limits. No complete bug-class or guide-conformance closure is claimed. The [PR review record](auth-pr-review.md) identifies the reviewed implementation commit and final checks. Other source audits remain outside that record. |
| ORC-013 | Credential T−1/T, a surviving sibling after individual revocation, password-only rotation and storage 59/60 seconds distinguish the named reusable boundaries. Fixed exact consent-expiry/code examples remain bounded cases; arbitrary adjacent consent/code times are not credited. |
| ORC-014 | The production Worker supplies real provider discovery, consent and MCP call premises. The separate Better Auth fixture and controlled clock have explicit limits. Deployed proxy behavior and host scheduling remain unverified rather than inferred from ordinary local calls. |

The mutation runner captures authorization and storage failures and replays their seed and shrink path through the same registry and checkpoint. Its records are emitted under `build/auth-replay-*`. Setup failures, collateral timeouts and reductions at a different checkpoint do not count as semantic evidence. `auth-security-oracles.md` maps the thirteen additional security mutations to their laws.

## Verification

The full Worker suite passed 98 files: 1,052 tests and five existing skips. The auth/MCP prose rerun passed192 tests across15 files. Eight owner-auth browser cases, all thirteen security mutations, the controlled two-isolate race and Worker/UI typechecks passed. The term-scan rerun passed58 tests across five affected files. These runs have different scopes; their counts are not combined.

Logs and exact-source manifests are kept in the audit evidence. No local run establishes production TLS, database/operator access, external log secrecy or every distributed schedule. The implementation is committed on the review branch. No deployment or upstream merge is claimed. The PR records the reviewed commit and final check results.

## Complete REST permission inventory

`test/rest-permissions.oracle.test.ts` names all 49 operations in four independent capability groups. It checks all 16 scope subsets, including an empty injected access set. The contract supplies receiving paths, not expected permissions. An inventory equality assertion requires a model update when a route changes. Authorized requests must return a listed handler or validation result. A server error does not count as authorization success.

Every subset also checks the draft-plus-publish rule for response visibility. An adversarial registered write without scope metadata must return403 before its handler runs. The guard uses Hono's matched route templates and denies unclassified writes. Mutations remove that default denial and misclassify draft operations as private reads. Both must fail their named assertions.

`test/oauth-grant-list.oracle.test.ts` exercises the same client's `prompt=none` path before and after individual revocation. Revocation must remove remembered consent. Existing sibling access tokens retain their own grant state.

`test/review-auth-regressions.test.ts` checks the public attachment projection and pauses R2 upload until another request publishes the item. The media insert must check publication in the same SQL statement. A denied upload must remove its own R2 object. `test/mcp-media.oracle.test.ts` applies the same publication boundary through a direct tool call, with a draft-plus-publish permitted neighbor.

These laws cover permission classification, remembered consent and the controlled attachment race. They do not prove absence of every authorization bug or every concurrent schedule. Native token validation and browser credential transport remain separate receiving boundaries.


## Password sessions and delegated authority

Decision #31 and the user ruling keep delegated tokens valid after owner-password reset. `test/owner-reset.oracle.test.ts` checks manual API/MCP access, native OAuth access and refresh, stable grant deadlines and listing, old owner-cookie denial, and explicit revoke-all. It also supplies native browser cookies to `prompt=none` after reset. Those cookies must not replace a valid owner session: the provider must return `login_required` without a code.

The generated authorization grammar now includes password reset as a separate action. The independent model keeps its credential state unchanged. Signing-secret rotation and revoke-all still advance model generation. Mutations restore password coupling or allow stale native cookies, and must fail the corresponding law. These boundaries are independent of the provider/schema configuration cache.
