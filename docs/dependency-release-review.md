# Dependency and release review

Reviewed 2026-11-27 against upstream `main` at `956dee3` (0.73.1).
This follows [#153](https://github.com/blygger/blygger-studio/issues/153) and
[#73](https://github.com/blygger/blygger-studio/issues/73).
Recommendations below are pending maintainer decisions. The user also requested
all available minor/patch dependency upgrades within the existing major versions.
This change preserves range styles, update grouping, OCR, and Release gates.

## Renovate: activation verified

Before setup, the organization installation API returned `total_count: 0`:

```sh
gh api orgs/blygger/installations --jq .total_count
```

The current user's organization membership returned `role: admin`. Renovate was
not installed on `blygger`; this was an installation problem, rather than an
installed app missing access to this one repository. The absence of bot PRs alone
would not have proved that. No self-hosted Renovate workflow exists here.

`.github/renovate.json` is a supported location and passes Renovate's repository
config validator. The existing config enables updates and lockfile maintenance,
permits the prerelease lines already in use, and disables automerge. There is no
disabled-manager or schedule setting that explains the lack of all updates.
See Renovate's [installation guide](https://docs.renovatebot.com/getting-started/installing-onboarding/).

The repository change adds `npmrc: "legacy-peer-deps=true\n"` to Renovate's
config. This gives its lockfile writer the same peer-resolution mode as CI and
the documented fresh-install command. It is a missing setup detail, not evidence
that an installed bot previously failed. It applies to Renovate only; package
scripts remain subject to Renovate's default script restrictions. See the
[npmrc option](https://docs.renovatebot.com/configuration-options/#npmrc).

An extraction-only run also found a coverage defect: the default Compose matcher
does not match `scripts/oauth-conformance.compose.yml`. The config now names that
exact file for the Compose manager. It changes no image or release gate. See the
[default filename rule](https://docs.renovatebot.com/modules/manager/docker-compose/).
The image upgrades add explicit release tags beside the digests, and an OpenID
version parser for its `release-v` prefix, which Docker's default parser rejects.
Review image updates against the runner's explicit suite assertion; extraction
does not establish that a replacement image is compatible or available.

The user installed the official app. The API now reports an active, unsuspended
Renovate installation on the organization. It has reached this repository:
the bot opened [Dependency Dashboard #193](https://github.com/blygger/blygger-studio/issues/193)
and update PRs #191 and #192. A config file alone could not have granted that
access. Check the dashboard for lookup and lockfile errors as upgrades arrive.

Validate the config with the official tool (Node must meet that tool's engines):

```sh
renovate-config-validator --strict --no-global .github/renovate.json
```

Renovate's standard managers cover the npm manifests and workflow action pins;
the explicit matcher adds the Compose images. Inspector's shell install, the
commit-addressed oracle tarballs and the OCR URL are separate
coverage gaps; no custom updater for those strings is added here. Keep their
versions synchronized with their runtime assertions when upgrading them.

## Reconcile #153 with current main

| Proposal | Current state | Treatment in this change |
| --- | --- | --- |
| Dependency updates | App now active; dashboard and update PRs observed | Complete npm/Compose setup and apply the requested minor upgrades |
| Release action hashes | Floating `@v4` refs | Pin the same refs to verified full commit hashes |
| Reviewed Wrangler upgrades | Grouped with Cloudflare test tooling; automerge already off | Separate-PR proposal below; no policy adopted |
| Tesseract worker/core/model | Still fetched remotely without integrity checks | Product choice below; no OCR behavior changed |
| Exact Base UI version | Manifest `^1.9.0`, lockfile `1.9.0` | Exact-pin proposal below; no version changed |
| Separate WebKit job | Already implemented in `049b5a7`; current job uses a digest-pinned Playwright container | No repeat implementation |

Before this upgrade, the Hono and fast-xml-parser fixes were already present: manifest floors and
locked versions are 4.13.18 and 5.12.1. Authentication/MCP and temml still have
exact direct pins. Of the TanStack packages, only db/react-db use exact pins;
query-db-collection, query-core and Router have ranges. `npm ci` still installs
the versions and integrity hashes in the lockfile for all of them.

Before these upgrades, the inventory had grown from 302 to 400 package entries,
excluding the root.
It now includes `@tanstack/oracles` and `@tanstack/eslint-plugin-oracles` from
commit-addressed `pkg.pr.new` tarballs, with lockfile integrity. They run in CI
and development; they are not production runtime packages. The root postinstall
build also runs code, beside the esbuild/workerd/fsevents install hooks.
Inspector is installed in `build/oauth-inspector` during CI: its direct version
is fixed, but its transitive tree has no committed lockfile here. The Playwright
container and GitHub runner image are also supply-chain inputs.

The ratings should separate impact from likelihood. Every UI dependency can
make owner-authorized requests if compromised; maturity does not lower that
impact. A release-candidate label raises compatibility uncertainty, but does not
by itself establish a security defect in TanStack DB. Better Auth remains high
impact because it issues and validates authority. Test/build tooling can alter
shipped output even when its job has no production secrets. These distinctions
are more useful than treating "test-only" as intrinsically harmless.

## Implemented: pin actions on the release path

`release.yml` invokes `formatting-baseline.yml` for its fallback verification.
Both workflows now pin their existing remote action refs; the local reusable
workflow and local Chromium action come from the checked-out repository.
The pins resolve the existing `v4` refs, rather than upgrading their majors:

| Action | Commit verified from its official repository |
| --- | --- |
| checkout | `11d5960a326750d5838078e36cf38b85af677262` |
| setup-node | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| upload-artifact | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| download-artifact | `d3f86a106a0bac45b974a628896c90dbdf5c8093` |

The `# v4` comments let reviewers read the selected line and Renovate track it.
No commands, permissions, conditions, job dependencies or deadlines changed.
Check's own action refs remain outside this patch. Hash pins prevent later tag
movement from silently replacing action code; they do not remove trust in the
pinned code, runner image, or npm install. See Renovate's
[action pin support](https://docs.renovatebot.com/modules/manager/github-actions/).

## Decision: Wrangler review

Recommend a separate Wrangler PR, with release notes read before merge.
It runs with the operator's Cloudflare session during deployment. Today one
Cloudflare group combines it with vitest-plugin, workers-types and miniflare.
All updates already need a human merge; there is no need for a new automerge or
bot-approval rule.

Smallest change: remove `wrangler` from the Cloudflare group, then add this rule
after the grouping rules so it also overrides inherited monorepo grouping:

```json
{
  "matchManagers": ["npm"],
  "matchPackageNames": ["wrangler"],
  "groupName": null,
  "prBodyNotes": ["Review Wrangler release notes and lockfile changes: this tool runs with the operator's Cloudflare credentials."]
}
```

The cost is another PR and possible coordinated upgrades when Wrangler and
Miniflare need the same runtime. Keep linked changes together when that is
needed, but call out Wrangler's deploy impact. Validation should build the
release and run the upgrade verifier without production credentials. Reading
release notes is a human review step, not something a green check proves.

## Decision: exact Base UI pin

Recommend changing `@base-ui/react` from `^1.9.0` to `1.9.0` in package.json
and the root manifest entry of package-lock.json. The resolved dependency tree
stays unchanged. Renovate can still propose later exact versions.

This matches the selected exact pins and limits fresh `npm install` resolution
drift. It does not make `npm ci` safer than it is now: CI already uses the locked
1.9.0 tarball and integrity hash. Keeping the range is also consistent with the
existing React/Router policy and avoids another manifest convention. Do not
expand this proposal into exact pins for every dependency without deciding that
broader policy. After approval, verify an unchanged resolved tree and run the UI
suite and component/browser smoke checks.

## Decision: OCR

Recommend removing the optional Tesseract photo reader and retaining the scan
sheet's existing OS-scanner instructions and paste flow. This is a product
change, so it is not included in this patch. It removes photo selection from the
web app, including on desktops without an OS scanner; those users lose a useful
feature. It also removes this runtime CDN code path without adding asset hosting.

The smallest follow-up removes `src/ui/ocr.tsx`, its import and `<OcrScan>` in
authoring.tsx, and updates the existing scan-sheet browser test to check OS
guidance, insertion/cursor behavior and the absence of OCR network requests.

If keeping browser OCR is worth the upkeep, self-host the complete asset set:
the top-level library, worker, supported core JS/WASM variants and English model.
Tesseract supports explicit `workerPath`, `corePath` and `langPath`; replacing
only the main script URL leaves the other fetches remote. Its
[v5.1.1 local-hosting guide](https://github.com/naptha/tesseract.js/blob/v5.1.1/docs/local-installation.md)
describes the core variants. Build from locked packages and checksum-pinned model
bytes, verify hashes before publication, and serve immutable versioned URLs from
each mount. SRI on the top-level script does not cover worker/importScripts,
WASM or model fetches. Same-origin hosting alone is not an integrity check.

That option needs a decision on asset distribution and the no-vendoring ruling,
release packaging, cache/update behavior and additional download/storage cost.
Its browser test must perform recognition with network access to outside OCR
hosts denied, including mounted installs and supported core variants. Keeping
the current opt-in is the smallest code change, but retains the CDN trust gap.

## Decision: OAuth interoperability and releases

No release gate changes here. Today `oauth-interop` remains in Check on every
PR/main push, and a main-tag Release requires the whole Check run to succeed.
The no-main fallback in Release does **not** run the external OAuth job; the
current policy is already different for tags that never passed through main.

Recommend retaining these receiving behaviors as hard gates for auth changes
and releases, through the in-repo Worker/browser suites:

- Mounted and root discovery/issuer/resource binding; registration followed by
  owner login, bound consent, S256 PKCE and a usable token.
- Omitted `resource` defaults to MCP at authorization, code exchange and refresh;
  REST refuses it, and refresh cannot widen its audience or scopes.
- Correct confidential-client authentication, single-use codes, refresh rotation,
  replay/revocation denial, and the independent drafting/publishing/private scopes.
- The official MCP client completes discovery and tool use, while unauthorized
  operations fail at the receiving REST/MCP endpoint. Browser login/consent and
  framing protections retain real browser checks.

These promises already have coverage in `test/mcp.oracle.test.ts`, the OAuth and
auth-security oracles, the compiled race verifier and `e2e/client-access.spec.ts`.
That is bounded evidence, not full OAuth/OIDC certification. The in-repo MCP
confidential flow uses Basic; the external generic flow additionally tests POST
client authentication. Do not remove the external run on an assumption that all
its cases are duplicate local coverage. Port any missing receiving case before
claiming that equivalence; changing oracle laws needs maintainer approval.

Keep the independent checks too: eight Inspector/generic-client cases and four
official discovery/PKCE modules at root and `/nested/blyg`. Inspector always
sends `resource`, so the official omitted-resource PKCE module is a distinct
regression witness for #54. The local MCP oracle now covers that flow, but cannot
replace an implementation-independent protocol check.

### Failure meaning

| Observation | Meaning and action |
| --- | --- |
| Selected official module finishes `FAILED`, or an interop receiving assertion fails | Product/compatibility failure candidate. Block the affected auth change; keep module findings and replay it. Rule out a broken fixture without relabeling the failure as an outage. |
| Image `manifest unknown`, registry 429/5xx, DNS/TLS/network failure, npm tarball unavailable | No protocol result. Retry or repair the supply path; do not call it conformance failure or success. |
| Setup failure, module interrupted, fixture startup failure, timeout or incomplete case list | Unknown result. Inspect logs and rerun; neither PASS nor proof of a product bug. |

The current scripts fail closed in all three cases. Compose/npm failures can
occur before either results file exists, and the scripts can leave partial
records. A workflow split should retain stage status and logs as well as sanitized
results, with an explicit expected-case count. Never turn every error into a
successful check with `continue-on-error`.

### Concrete gating options

1. **Recommended: independent workflow, required for auth changes; scheduled for
   drift.** Move the existing job intact, run it on auth/MCP/storage/login/consent,
   contract/policy and fixture changes, any dependency or lockfile change, and its
   workflow changes; add weekly and manual runs. Keep an always-reported required
   status for affected PRs. A workflow skipped with top-level `paths` can leave a
   required check pending; use an in-workflow scope decision/aggregate instead.
   Preserve exact-SHA evidence for auth releases, including no-main tags, before
   removing the global Check gate. Classify the whole release range since the
   last verified revision, so an auth change followed by a CSS-only commit cannot
   bypass the gate. Unrelated releases can then proceed during an
   external outage. This loses the third-party test on every unrelated merge and
   release. It adds release-evidence bookkeeping. A failed weekly run stays visible
   for triage; it is not automatically a product defect or a waiver.
2. **Scope it inside Check for PRs, keep every main push.** Smaller change and
   complete main-SHA evidence; saves PR work, but registries still block every
   main-tag release. No separate release-status lookup is needed.
3. **Leave the gate unchanged.** Strongest frequency and simplest status policy,
   with the existing registry-outage and deleted-artifact release cost.

Choose the gate before implementing the split. In option 1, an auth change with
no completed independent result stays blocked until it passes or maintainers
explicitly approve an exception with that evidence gap recorded. Moving a job
into another YAML file alone does not preserve release enforcement.

### Image mirrors

Do not add a GHCR mirror yet. It would preserve the three known image artifacts
against upstream deletion and consolidate image pulls, which directly addresses
the v0.46.2 incident. It would not remove npm/Inspector downloads, browser
artifacts, GitHub/GHCR availability, test defects, or maintenance on new suite
versions. A mirror also needs an owner, retention rules, licensing review,
multi-platform manifest preservation, and digest/provenance verification.

If maintainers keep external checks on every release, a small immutable mirror
of the two OpenID images **and Mongo**, validated before switching Compose, is
reasonable. Record upstream and mirror digests and run all twelve cases against
the copy. Mirroring only OpenID still leaves Docker Hub on that path. Keep refresh
manual and reviewed; do not add an automatic tag-following mirror that changes
the suite under an unchanged application commit. Building the suite from pinned
source would exchange registry retention for Java/build dependencies and more
maintenance; it is not a smaller fix.

Check redesign belongs to the CI lane. This branch changes its Inspector version
and Playwright container only; Release and its shared fallback get action pins.

## Requested minor upgrades

The user requested these upgrades together in this PR. This batch does not adopt
the proposed future Wrangler grouping or exact Base UI policy. Existing exact
versions remain exact; caret ranges retain their style. The SDK's Zod range has
no newer minor, and the two commit-addressed oracle builds remain at `97a4e7a`:
they expose no release version from which to select a minor update.

The registry plan updates 16 manifest entries, including Better Auth/provider
1.7.14 → 1.7.28, TanStack DB/react-db rc.1.2 → rc.1.6, Wrangler 4.156 → 4.169,
Workers Vitest plugin 1.4.11 → 1.10, and Playwright 1.64.1 → 1.65.1. A lockfile
refresh also updates packages covered by broad existing ranges, such as Workers
types. The isolated Inspector pin moves 2.10.1 → 2.17.0. Tesseract 5.1.1 and the
js-yaml 4.3.2 override have no later release in their current majors.

Inspector 2.17 requires `^22.23.4 || ^24.22.1 || >=26.12.1`. Its OAuth CI job
and local instructions therefore use Node 24.22.3. The other CI runtimes retain
their existing client-minimum and SQLite test roles.

The official OpenID server/nginx images move 5.3.2 → 5.3.5; Mongo moves from its
inspected 6.0.13 baseline to 6.0.28. All use verified multi-platform digests. The
Playwright WebKit container moves to the matching 1.65.1 image. The same four
official modules and eight interop cases remain required; this is a fixture
upgrade, not a gate change.

Reviewed Wrangler's official changelog from 4.157 through 4.169. Relevant changes
include corrected D1 account selection and upload metadata, sanitized diagnostic
headers and bundled security fixes. New OAuth logins request `billing:write`
(4.168); existing sessions need a new login to gain it. No login or deployment
is part of this PR. See the [Wrangler changelog](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md).

Reviewed Better Auth's [1.7 release notes](https://github.com/better-auth/better-auth/releases/tag/v1.7.28),
including refresh/revocation, session and key-selection fixes. Studio sets its
RS256 primary algorithm, does not enable CIMD or DPoP, and uses the native D1
adapter. Its existing receiving/security tests remain the compatibility gate;
this PR changes no auth configuration or security law.

## Validation and limits

- Renovate 45.3.1 strict repository-config validation passes, including the
  existing config before edits.
- Its local extraction-only dry run finds 46 npm entries across two manifests,
  106 GitHub Actions entries across three workflows, and all three Compose images.
  Before the matcher, no Compose file was found. All 24 edited action refs are
  extracted with their digests. The token-free local run warns that GitHub lookups
  need a token; an installed app supplies its own access. No host credential was
  copied into the test, and no branch or PR was created by the dry run.
- Both edited workflows parse as YAML. Replacing the 24 pins with their original
  refs reproduces the original files byte for byte; other workflow behavior is
  unchanged. `git diff --check` passes.
- Dependency upgrade validation is recorded in the PR body. The extraction and
  config checks above establish setup behavior, not application compatibility.
  No production deployment is part of this work.
