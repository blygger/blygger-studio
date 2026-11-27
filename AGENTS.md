# Blygger Studio — Project Instructions

> **Environment rules, keys & safety policies:** see [`Code/CLAUDE.md`](../../CLAUDE.md), `warnings.md`, `warnings-node.md`, `warnings-keys.md`, `security-policy.md` at the `Code/` level. Read before starting work.
> **The protocol lives elsewhere:** [`../blygger-spec/`](../blygger-spec/). This repo is **one implementation**, not where protocol decisions get made.

Blygger Studio is the reference client for the Blygger protocol — a Cloudflare Worker
that publishes a blyg, subscribes to others, and threads, transcludes and responds
across them. Public repo: `blygger/blygger-studio` (branch `main`).

Split out of `blygger-spec/worker/` at session 26 (2026-09-28) with all 59 commits of
history, when six independent client implementations made a combined spec+implementation
repo untenable. Named `blyg-ref` until then; `CLIENT` in `src/types.ts` is the one place
the name and version live.

## Where the process lives

**This repo has no session ritual and no devlog of its own.** Both stay in
`blygger-spec`, which remains the program's log across all four repos:

| Thing | Where |
|---|---|
| Session-start ritual, session numbering, carry-overs | [`../blygger-spec/CLAUDE.md`](../blygger-spec/CLAUDE.md) |
| `DEVLOG.md` — one log for the whole program | [`../blygger-spec/DEVLOG.md`](../blygger-spec/DEVLOG.md) |
| Locked protocol decisions (#1–#29) | `../blygger-spec/CLAUDE.md` |
| Model routing (⚠️ FABLE gates) | `../blygger-spec/CLAUDE.md` |
| Four-track program roadmap | [`../blygger-spec/docs/roadmap-tracks.md`](../blygger-spec/docs/roadmap-tracks.md) — this repo is **Track 2** |
| Plan docs (`v0.3-plan.md` etc.) | `../blygger-spec/docs/` |

**Model routing applies here too.** This repo implements semantics; it does not set
them. If a task touches protocol semantics, cross-client invariants, security/crypto or
API-surface design, it is ⚠️ FABLE — stop and say so rather than improvising. Two live
examples, both **ruled session 27 (2026-09-28)**: the `/api` write contract (roadmap-tracks
1.8 → decision #31: the client's own contract, never the protocol's; auth direction fixed)
and whether a citation's human half goes on the wire (1.2 → decision #30: yes, `cited`).
The rulings and their build consequences are in `../blygger-spec/docs/v0.3-plan.md` §8c.

## Stack conventions

- Cloudflare Workers + D1 + R2, TypeScript, wrangler. Node: `/usr/local/bin/node` (see `warnings-node.md`; **no `node_modules/` synced by Dropbox** — follow the policy there).
- **`npm install` needs `--legacy-peer-deps`.** npm 10.9.0's peer resolver crashes on vitest's optional peer graph; the environment, not this repo. A fresh clone hits it, an incremental install does not.
- **Studio is a React SPA; public pages stay server-rendered** (0.10.0, session 30 — Venkat
  reversed v0.1-plan's "no client-side framework" rule when merging Kyle Mathews' #21/#22).
  Studio: React + TanStack Router/DB + Base UI under `src/ui/`, built by `npm run build`
  (also `postinstall`/`pretest`/`predeploy*`) and embedded in the Worker. It talks to `/api`
  only through the generated SDK (`sdk/generated/`, from `openapi.json`, from the Zod
  contract in `src/contract/`). Change a route → `npm run sdk:generate`; CI fails on drift.
  Public pages, protocol files, static export and cron are still server-rendered from
  `src/pages.ts`/`src/protocol.ts` with no framework, and that is not changing.
- **Inline page scripts live inside TS template literals, so escapes are a live hazard** —
  now only on the *public* pages (`VERSION_NAV_SCRIPT` and kin in `pages.ts`); the Studio's
  inline scripts were deleted by 0.10.0: write `\\n` (not `\n`) inside a `confirm()`/string in `actionScript`/`composerScript`/`FEED_SCRIPT`, or the emitted JS gets a real newline inside a string literal and the whole script fails to parse. Session 19 shipped a studio where every button was dead this way, **with the full suite green** — assertions about HTML pass whether or not the `<script>` in it is valid JavaScript. `test/inline-scripts.test.ts` compiles every inline script via `new Function`; keep new pages covered by it.
- Use TanStack Router `Link` for internal navigation so hover and keyboard focus can preload the destination. Use buttons for actions, not links.
- **Page scripts need behaviour tests, not just markup tests.** For the Studio that now means
  the Playwright suite (`npm run test:e2e`, desktop + mobile Chromium, 118 tests at 0.10.0) and
  `npm run test:ui`; the Worker suite keeps API, public-output and lifecycle tests. The same blind spot produced a second session-19 bug: the shared action handler ends in `location.reload()`, correct for every action that leaves the item in place and wrong for `discard`, which deletes it (reloading an editor URL 404s). Assert on what a handler *does* — where it navigates, what it calls — not only that the button rendered.
- Secrets: wrangler secrets only; register every key in `Code/.env.keys` per `warnings-keys.md`. Never commit secrets.
- **Maximize what a blyg can do on D1's free tier** (design principle, Venkat, session 87 after studio#180; reframed as a soft rule, session 90). Today the free tier allows 5M rows read and 100k rows written per UTC day. Over the limit, D1 refuses reads, and the blyg's public pages return 500 until midnight UTC. A median blyg is small: about a dozen items, a few dozen subscriptions, one owner. Prefer the design that lets it do more inside that budget: a day with the Studio open and used for hours, plus every cron. Polling, preloads and background work count, whether or not anyone is watching. **It is a soft rule:** don't try to stay inside the free tier at all costs. It never justifies a contorted, inelegant or fragile design. When the clean design costs rows, pay them, and leave paying for a plan to the operator. Know what a change costs: state the rows a change adds per poll, per page load or per cron tick, measured with `wrangler d1 insights` (`--sort-by=reads` or `writes`). #180 is the failure that prompted it: 0.65.0 ended the cheap preflight, and Reading's two full scans then ran every 15 s in an idle tab, about 16,000 rows each time. That used up fred's node's daily limit in two hours.

- **Design for CI** (design principle, Venkat, session 87, after studio#178's four review rounds). Design so that verifying is cheap, as design for manufacturability makes building cheap. Give each cross-cutting property, such as visibility, permission, payment or taint, one choke point that every decision goes through, a small closed set of states, and laws written as "For every" sentences with their oracle before the code. Features consume the choke point and never re-implement it: no per-feature filtering. A rule that needs a second enforcement site is a design finding, not a build task. It applies first to the multi-author permissions and the RFC-6/7 builds (blygger-spec `sealed-content-build-plan.md` §0).

## Identity and versioning

`CLIENT` in `src/types.ts` is the single source of truth for this client's name and
version, and `GENERATOR` derives from it. Both user-agent strings
(`IMPORTER_USER_AGENT`, `MENTION_USER_AGENT`) derive from `GENERATOR` — before session
26 they were hand-written and had drifted to `blyg-ref/0.2` and `blyg-ref/0.3` on a
0.3.0 client.

**Client version ≠ protocol version, always.** `PROTOCOL_VERSION` is what the wire
carries and is governed by decision #18d; `CLIENT.version` is this software's identity
and the wire is indifferent to it. Do not couple them, and do not derive `CLIENT.name`
from `BRAND` — `BRAND` is the protocol's vocabulary, which this client does not own.

Bumping `CLIENT.version` is what blygger.com's directory census reads to decide a node
is behind (roadmap-tracks Track 3.1), so a release that changes behaviour operators
should adopt must bump it.

## Deployment

`npm run deploy:all` drives every deployment in `deploy-targets.json`, each against its
own pinned Cloudflare account, with a tsc+test gate, migration preflight and post-deploy
live verification. Protocol and rationale: `../blygger-spec/docs/deploy-protocol.md`
(built session 17 after incident `2026-09-12-01`, a wrong-account deploy).

**Our deploy config is not committed (session 28).** The client ships as a generic
artifact anyone can stand up, so committed `wrangler.jsonc` names no account, database,
route or domain, and `deploy-targets.json` is gitignored. Ours live in
`wrangler.private.jsonc` and `deploy-targets.json`, both gitignored, both at the repo
root — wrangler resolves `main` and `migrations_dir` relative to the config file, so
neither can move into a subdirectory. `deploy-all.ts` prefers the private config when it
exists and falls back to the committed one when it does not, which is also what makes a
self-hoster's own `wrangler.jsonc` work with no flag.

Per-target spellings (`deploy:all` is blocked in auto mode):

```bash
npm run deploy:vgr    # wrangler deploy --config wrangler.private.jsonc --env venkateshrao
npm run deploy:pi     # wrangler deploy --config wrangler.private.jsonc --env protocolInstitute
```

**New Nature is not deployed from here** (Venkat, 2026-11-06). `newnature` is in the deploy manifest, but that node is migrated, deployed and changed only from `Publishing/newnature/` sessions: it vendors a private dashboard at build time, and a deploy from this checkout would remove it. So don't run `deploy:all`; roll out with the per-node commands above and the `blyggerOrg` deploy.

**If you lose the private files:** every value in them is readable from the Cloudflare
dashboard, but rebuilding by hand is how incident `2026-09-12-01` happened. `test/
deploy-manifest.test.ts` cross-checks them on every `npm test` — and note *how* it
detects their presence: `import.meta.glob`, not `node:fs`. Inside the Workers test pool
the filesystem is sandboxed, so `existsSync` returns false for a file that is plainly
there, and a `runIf` on it would skip the live half silently while the suite went green.

**Authenticate with `wrangler login`, not `CLOUDFLARE_API_TOKEN`.** Both registry tokens
are single-account and the personal one has no D1 scope, so the migration preflight
cannot run from either; an env token silently overrides the OAuth session, so **unset it**
before deploying. One OAuth session reaches both accounts.

## `/api` is a documented contract with owner and delegated access (OAuth/MCP merged 0.28.0, session 36)

**Since 0.10.0** (#21, Kyle Mathews): 39 operations defined once in `src/contract/` (Zod →
OpenAPI 3.1 → `openapi.json`, served to the owner at `/api/openapi.json`), resource-shaped
(POST creates, PATCH edits, PUT pins), documented in `docs/api.md`, consumed through the
generated SDK. The pre-0.10 routes (`PUT /items/:id`, `/fork`, `/stubs`, `/items/:id/pin`,
`PUT …/responses`, pause/resume, …) were removed with **no aliases** — Venkat accepted the
break (session 30). Kyle's phase 3 (`docs/migration.md` §3: ecosystem clients, then OAuth and
MCP) **was ruled session 31 (2026-10-03, decision #52): it proceeds, and Kyle builds 2.9.**
OAuth is a way of *minting* #31's tokens (IndieAuth is what Micropub itself uses), and MCP is
a transport for the contract, not a second one. **Review his auth PR against these four
invariants before merging; Opus reviews and does not build tokens:**

1. **One token model.** OAuth mints #31's tokens — scoped, listed, per-token revoke and
   revoke-all in the studio; the password is typed only on the studio's own login page. A
   manual mint-and-paste path exists beside the flow (CLI tools, crons and the reference
   agent have no browser).
2. **No `.well-known`, no manifest key.** `/.well-known/` is host-rooted and breaks a
   path-mounted blyg (`venkateshrao.com/blyg/` is one); discovery is the HTML `rel` link on
   the studio page and the metadata lives under the mount. Nothing reaches `blyg.json`.
3. **Scopes:** a read scope for studio-private material; publishing a distinct verb from
   drafting; no refresh-only scope (#38). Names are his; studio#11 lists the measured demand.
4. **MCP:** same operations, same scopes, a token like any tool. Text written through it is
   disclosed via client-recorded provenance (`tk-provenance`, studio#11) with `sources` in
   the spec's §5.9 reference shape. Polling, not webhooks.

Password reset rides with his auth middleware (#31: after tokens, MUST offer revoke-all).
Upstreaming Blygger Desktop's reading-rows and read-state extensions is fine — studio-private.
Reasoning: `../blygger-spec/docs/v0.4-plan.md` §8.1.

The owner still signs in with the existing password and 30-day owner cookie.
Delegated clients use scoped OAuth grants or named manual bearer tokens. Studio
lists grants and supports individual revocation and revoke-all. REST and MCP
share the same permission rules. See `docs/client-access.md` for the current
contract and `docs/auth-security-oracles.md` for its security checks.

**Third-party authoring tools are already writing to it** — a native macOS studio, a
Drafts action, an Obsidian plugin. Making this a real contract (tokens, scopes,
versioning, idempotency) **was** ⚠️ FABLE-gated on two counts and is now **unblocked**
(decision #31, session 27): it is this client's contract, not the protocol's. Direction
is fixed — per-client bearer tokens with coarse verb scopes, owner-minted and revoked in
the studio, the owner password as root credential that no tool ever holds, revoke-all,
CORS for token-bearing requests, endpoint discovery via an HTML `rel` link on the studio
page (never a manifest key). Build within that direction; anything beyond it is still
Fable. Do not harden it in a way that breaks the tools now depending on it without
saying so.

## Status

**0.74.0** (session 91, 2026-11-27): the built-in Agentic digest (blygger-spec `docs/agentic-digest-plan.md` §8, laws 1, 2 and 5): `src/agentic-digest.ts` (Highlights, Happening conversations, no rewrite of an unchanged edition; owned by `test/agentic-digest.oracle.test.ts`), `src/agentic-schedule.ts` (hourly/daily/weekly by the owner's clock, run from the quarter-hour cron), settings `agenticDriver` (external default, resident, off), `agenticHidden`, `agenticFrequency`, and `regenerateAgentic`. Private contract 7.2.0, SDK 0.28.0. No migration.

**0.73.1** (session 89, 2026-11-26): the hopper lens lists draft members (studio#175, #178 V9) through `hopperEntries` in `src/reading-data.ts` (drafts swapped into `readingEntries`' ordered entries by key; `draftHtml` = `withoutComments` + `previewStrip`; no Background state); `readingEntries`, shared with the Agentic edition, stays draft-free. `setReadingPlacement` places a private item for a caller who sees private. Reader: no copy-link, fork or Background on a draft entry. Law 2's stated limit: an untainted draft's working copy is the owner's own text. Private contract 7.1.0, SDK 0.27.1. No migration.

**0.73.0** (session 89, 2026-11-26): private items, the rest of Phase 0 (#178; blygger-spec `docs/sealed-content-build-plan.md` §1 0c–0f): the `owner:private` scope (`owner:read` no longer implies it; hidden answers as unknown on every item operation, `test/private-scope.oracle.test.ts`), [TK] on private sources with the server-only `items.private_taint` mark (public publish refused while set; discard clears it), owner search over private working copies, owner hopper members (studio#175), server-owned provenance, the Agentic feed behind `owner:private`, shelf ceiling 1,000, publish confirmations (`test-browser/publish.oracle.test.ts`). Private contract 7.0.0 (breaking for tokens), SDK 0.27.0. **Migrations 0064, 0065.**

**0.72.3** (session 87, 2026-11-26): **discard gives back the working copy as published** (#184): `versions.source_md` (only where it differs from the published text) and `source_provenance_json` (always written; NULL marks a pre-0063 version), read by `restoreVersion`; a pre-0063 version that disclosed generated text stays dirty. The nested-scope refusal offers `markImportedAround` (`src/tk.ts`). The full view's actions bar leads (`reading-article`). `SUPERSEDED_WINDOW_MS` is 3 minutes (#183). Contract and SDK unchanged. **Migrations 0062, 0063.**

**0.72.2** (session 87, 2026-11-25): an open Studio no longer spends a free plan's D1 reads (#180). `watchAttention` in `src/ui/query-client.ts` drives Query Core's focus state: polling stops when the tab is hidden, the window is unfocused, or there has been no input for `IDLE_AFTER_MS`. Reading's page and summary use `readingPollingOptions` (`READING_POLL_MS`, 5 min). Unquoted `href`s verify (#181): `src/html-attr.ts` (`tagAttribute`, `tagTokens`) is shared by `alternateJsonHref` in `src/mentions/receive.ts`, `endpointFromHtml` and `src/peek.ts`. Contract and SDK unchanged. No migration.

**0.72.1** (session 85, 2026-11-24): private items are ranked in the pace-layered reader by their private versions (`src/feeds/reader-order.ts` `loadReaderHistory`); they had no position and sorted above everything. Migration **0061** adds private items and `private_versions` to the ranking's rebuild triggers. Contract and SDK unchanged.

**0.72.0** (session 82, 2026-11-23): **private items** (#94; blygger-spec `docs/sealed-content-build-plan.md` §1 Phase 0): `servedPublicly` allow-list on every public route with a route-enumeration gate (`test/private-surface.test.ts`); `status = 'private'` with versions in `private_versions` (migration **0059**), p1, p2, … listed by `GET /items/{id}/private-versions`; raising is an ordinary publish, first public version v1. **Publish mode / Notebook mode** (`defaultVisibility`); in Notebook mode a *private* nav tab (reader `sub=private`, `counts.private`) and the editor's *reader view* link. Setup gains Mode and Reading steps and a Read step (Discover, with blygger.com authors); **what's new after an upgrade** via `setupSeenVersion` (migration **0060**) and `src/ui/whats-new.ts` (`SINCE`, `HIGHLIGHTS`; add each release's lines there). Seven private-items oracles. Private contract 6.4.0, SDK 0.26.0. **Migrations 0059, 0060.**

**0.71.0** (session 81, 2026-11-23): **text content by spec §2** (#118): `BLOCK_BOUNDARY` in `src/markdown.ts` breaks at the start and end tag of §2's block elements and at `br`/`hr`, so a tight nested list's parent and first child are two lines (`selectionText`, `selectionLines`, `plainTextFromHtml`). Kyle's #172 (reader work bounded, migration **0058**, fixes #169) and #168 (editor formatting fixes, browser formatting oracles); #173 (`pickerSource` extension slot); djinna's #167 (suite blanks AI keys; `fail()` guarded by `status = 'pending'`). Private contract 6.3.0, SDK 0.25.0, unchanged. **Migration 0058.**

**0.70.0** (session 79, 2026-11-22): **TK reads the links its author placed** (#117, spec §16.16): `src/tk-hydrate.ts` (`hydrate`, `extractUrls`, `extractLinkIds`, `heldItem`, `fetchPage`, `pageText`, `pageSource`), the checkpoint in `runGenerateScope` and `generateItem` (`proceed`, response `{ checkpoint }`), web pages disclosed as `{url, cited}` in `generated[].sources` (`PageGenerationSource`), `ReadForScope` in the TK panel. **Reading load fixes:** migration **0056** (`reading_order_state.inputs`, moved only by what the order reads), the reading loader awaits only the summary that decides a redirect, the identity/summary/Raw queries require the subscription (`HELD` in `src/reading-data.ts`). **Seen means read:** `readerMarkRead` (seen / opened / never), `useSeenMarks` in `src/ui/reading.tsx`, the card date links to the full view; "retry reads" re-runs the route loader. Migration **0057**: read marks move the **`marks`** domain, not `reading` (polling-cache oracle law amended, Venkat's approval). Private contract **6.3.0**, SDK 0.25.0. **Migrations 0056, 0057.**
**0.69.0** (session 78, 2026-11-21): **Helpers** (`GET /helpers`; `catch-up`, `src/helpers/catch-up.ts`, the entry ⋯ sheet `src/ui/catch-up.tsx`; `catch-up-summary`, `src/helpers/catch-up-summary.ts`, cached in `helper_results`, the `ai_model_helpers` setting falling back to change notes). **The Agentic feed's foundations** (`src/agentic.ts`, `GET /agentic`, `GET`/`PUT /agentic/{feed}`, the digest tab, editions composed into a private draft thread). **Background 4b** (`src/background-model.ts`: `bg_model_imported`, `imported_change_queue` drained on the quarter-hour tick, `bg_instruction` with `NOTE_CLAIM_QUESTION` and `bg_flag_disagreement`, #96 (a)). **Quoted lists keep their structure** (#114: `selectionLines` in `src/markdown.ts`, `partialBakeBody` in `src/transclusion.ts`; `ol start` kept by the sanitizer and fork flattening). **TK links** (the prompt teaches `[[id | text]]` and markdown links; `stripGeneratedGrammar(text, keepLink)`). **Reader parity** (`src/generated-style.ts` shared with `pages.ts`; `src/ui/generated-highlight.ts`), `studioTheme`, `SourceName` (`src/ui/source-name.tsx`, `from=feed` back link), wake-time read settling (`useSettledReadProblem` in `components.tsx`), the sheet host given the router's context. Kyle Mathews' FTS5 search (#146, migration 0050); the dictionary (#156, `src/dictionary.ts`, migration 0055), editor marks (#159, `src/ui/editor-marks.tsx`), the `spellcheck` extension (#155) and `claims` (#165). Private contract **6.2.0**, SDK 0.24.0. **Migrations 0050, 0052–0055.**
**0.68.0** (session 77, 2026-11-21): **Reading in six tabs** (row 142): Feed (`all`/`threads`/`fragments` lenses, `FeedControls` with kind and order; `readerOrder` now defaults to `pace-layered`), Mentions, Agentic feed (`agentic`, was `smart`; a placeholder; the prompt is still `feed_prompt`), Saved (the shelf; `shelfLabel` says save), Background, Raw (`raw=true`, `rawIdentitySql`: imported only, no rules or folds). **The pace-layered reader** (row 69): `src/feeds/reader-order.ts` replays the home page's algorithm over own and imported items (window `READER_ORDER_WINDOW` = 500), positions in `reading_order` rebuilt per change generation (`reading_order_state`) and paged by the ordinary cursor via `paceAtSql`; the importer keeps `changelog_json` and `maintenance_json` (`NormalizedItemDoc.changelog`, written in `settleImportedBackground`). **Background phase 2** (row 112): `quotes-refreshed`/`quotes-material` (`bakedQuoteTexts`, `refreshReason`), `near-same`, `superseded` (`SUPERSEDED_WINDOW_MS`, `supersedes`; imported both arrival orders, own at first publish). The e2e server seeds `superseded` off and `reader_order` newest. Private contract **6.1.0**, SDK 0.23.0. **Migration 0051** (0050 reserved for #146).
**0.67.1** (session 77, 2026-11-21): copies elsewhere on every reading card (`CopiesElsewhere` beside `SourceLink`), and `importedEntry` carries `syndication`, so the full view opened by address shows them; found by the #98 gate run. Contract and SDK unchanged. No migration.
**0.67.0** (session 76, 2026-11-20): **syndication** (#148 via #160, Aneesh Sathe; spec 0.4 §16.14, decision #98, shipped ahead of promotion by Fable's ruling; `GET/PUT /items/{id}/syndication`, `item_syndication`, `imported_items.syndication_json`, the editor's *copies elsewhere…*, `u-syndication` on the page, "the author says it is also at …" in the reader); **`/changes` removed** (#162, decision #111; Kyle's `1290176` re-applied and `6e4bb9d` reverted, so the oracle laws are the removed-endpoint ones; `src/changes.ts` stays for internal readers); the #102 publisher changes (#161: `directiveLines` refuses a directive line in a fragment, a link to an item with no `page` names its item document via `itemUrl`, quotes in generated output bake outside `blyg-tk-gen` via `ResolveResult.parts`). Private contract **6.0.0**, SDK 0.22.0. **Migration 0049.**
**0.66.0** (session 76, 2026-11-20): editor bars (#154; the `editorBar` slot, `barPlacement`/`useEditorBars` in `src/ui/extensions.tsx`, `useBars` in `authoring.tsx`, the labelled bars menu, `blyg.editorBars.hidden`) and **replaceable controls** (decision #113; `ReplaceableControl`, `editorBar.replaces`, `context.bar.owns`, `barReplaces`, the boundary's `onFail` handing a crashed owner's control back; first entry `regionToggle`); mentions in natural grammar (#158; `handleCandidates` in `src/contacts.ts`, `punctuationAfterPick` in `src/ui/handle-trigger.ts`); the picker stays shut in a written reference (#157, `written` in `src/palette.ts`) and Shift+Enter is a plain newline (no key writes the backslash break). Private contract 5.14.0, SDK 0.20.0 (unchanged). **Migrations:** none.
**0.65.0** (session 75, 2026-11-19): Kyle Mathews' #152, conditional reads (private resource GETs take `If-None-Match` and answer a bodyless `304`; the SDK's optional `conditionalReads`; the studio refreshes after writes with no `/changes` preflight) and `/changes` deprecated under decision #111 (answers in 0.65.0 and 0.66.0, removed in 0.67.0 with contract 6.0.0, ROADMAP row 133); his #151, the oracle suites on `@tanstack/oracles`, which also **removes the host-root `/api` alias** (mounted nodes serve only `{mount}/api`; `venkateshrao.com/api` now 404s). CI: WebKit's one test has its own `e2e-webkit` job; `check:fixtures` sends the workflow token (an anonymous 403 failed the release Check once). Private contract 5.14.0, SDK 0.20.0. **Migrations:** none. Live on venkateshrao, PI and blyg.blygger.org.
**0.64.1** (session 74, 2026-11-19): security upgrades, Hono 4.13.14 → 4.13.18 (five advisories, one the router skipping wildcard middleware, which is how the sign-in checks attach) and fast-xml-parser 5.11.2 → 5.12.1; supply-chain inventory in studio#153.
**0.64.0** (session 74, 2026-11-19): studio#88 merged (Shannon's Base UI primitives; `src/ui/primitives.tsx`, toasts in `src/ui/sheets.tsx` on Base UI, phone toasts at the top so a WebKit hover cannot pause them); her `mobile-webkit` e2e project restored (`e54af45`: WebKit drops the Secure session cookie over the suite's http, so `cosmetics.spec.ts`'s login hands it over without Secure); link notices listed apart on the responses page (`MentionGroup.links`, `visible` excludes links); tangling fixes (a dropped part named in the publish warning, `droppedPartsNote` in `src/api.ts`; spans out of bounds in `src/ui/stub-quote.ts`). Private contract 5.13.0, SDK 0.19.0. **Migrations:** none. CI: WebKit's apt packages took 35 minutes on a slow Ubuntu mirror; 0.65.0 moved WebKit to its own job.
**0.63.0** (session 74, 2026-11-18): **tangling** (row 45, decisions #78, #100; `src/tangle.ts` `parseTangles`/`rewriteTangles`/`placeholderBody`, `publishTangled` in `src/api.ts`: dry-run pre-flight, the `tangle: true` gate answering 409 `tangle-confirmation-required`, one batch minting parts with `tangled_from`, parts published before the thread, a stopped tangle finished by the next publish); **`[[+ text]]` placeholders** (row 130); **`links[]` on the wire** (row 77, #79: `linkEntries` in `src/transclusion.ts`, `versions.links_json`, emitted in item and pinned documents, imported) and **`link` mentions** (sent for remote entries, `relationTo` ranks `link` last, `listPublicResponses` leaves them out); the **fold by link** in `src/background.ts` (own items only when `tangled_from` names the thread; imported ones within `LINK_BURST_WINDOW_MS` and only when `saysNoMoreThanLink`, #112); **local patches** (`npm run patches`, `build/patches.ts`, the Settings line, `upgrade.ts` lists them). Private contract 5.12.0, SDK 0.18.0. **Migrations 0047, 0048.** Reader suite 100 of 100.
**0.62.0** (session 72, 2026-11-16): mathematics (#149, decision #105; `src/math.ts`, `src/math-render.ts`, `temml` in the Worker only, the build fails if it reaches the browser bundle; the sanitizer redraws every imported formula from its TeX annotation) and the **burst fold** (Background reordered for tangling): `src/burst.ts` (`BURST_WINDOW_MS`, `withinBurst`, `clampedTime`) shared with the pace-layered `findBursts`; `settleImportedBackground` runs in `applyEffect`, `settleOwnBackground` at publish; rules `burst`, `wordless` (`isWordless` = §15.4's test via `extractDirectives`), `maintenance`; `ReadingEntry.parts` gives a thread's **+N parts**. A settings PATCH may name only the Background rules it changes (`BackgroundRulesPatchSchema`). Private contract 5.11.0, SDK 0.17.0. No migration. Pending call #15: no-vendoring covers client-side JavaScript only.
**0.61.0** (session 72, 2026-11-15): the Reading redesign — lenses All, Mentions, Smart Feed, Fragments, Threads, Shelf, Background; the Shelf (#137, Aneesh; `src/shelf.ts`, `GET/PUT /shelf` with required `expectedRevision`) with a Shelf lens (`shelf=true` on `/reading` and `/reading/summary`, `shelfIdentitySql`) and **+ add to shelf** on every entry; Background phase 1 + 4a (`src/background.ts`, `PUT /reading/placement`); `citedUrl` names the item document for an unheld item. Private contract 5.10.0, SDK 0.16.0. **Migrations 0044, 0046.**
**0.60.1** (session 72, 2026-11-15): Discover's "new" view is the unfollowed blygs, newest listing first, `PAGE_SIZE` at a time; setup's finish screen offers Discover; **tooltips are one pattern**: `Tooltip`/`IconButton` from studio#88 in `src/ui/primitives.tsx` and a `TooltipProvider` in `app.tsx` — use them, not a native `title`, on any interactive control. Contract unchanged. No migration.
**0.60.0** (session 71, 2026-11-14): download backup (ROADMAP row 15; `src/backup.ts` streams a tar from `{studio}/backup`, owner cookie only; tables by allow-list in `src/backup-format.ts`, guarded by `test-ui/backup-tables.test.ts`, because better-auth's runtime tables are not in `migrations/`), marked beta in More; `npm run backup` (`scripts/backup.ts`) writes the same archive through wrangler with no Worker read cap; Discover (row 17, `src/ui/discover.ts(x)`, ✦ beside ＋) reads blygger.com's `/blygs.json` from the browser, new since `discoverSeenAt` or all, subscribing through the OPML import's paced walk. Private contract 5.9.0, SDK 0.15.0. No migration. Maths (#149) and the reading redesign are not in it.
**0.59.0** (session 69, 2026-11-13): `main`'s held changes released with the 0.58.2/0.58.3 hotfix line merged in (#147): extension vendoring (#59; `scripts/ext-vendor.ts`, `extensions-vendor/`, the `vendored` lock in `extensions.local.json`, `docs/extension-vendoring.md`), menu zones (#143; `menuPlacement`, `askedZone` in `src/ui/extensions.tsx`, `PageContext.menu`), editor regions (#144; `src/ui/editor-regions.ts`, `editorRegions` slot). The extension page's context goes through `extensionContext` (the #147 merge). Contract and SDK unchanged. No migration. **The reading redesign (Background phase 1 + 4a, migration 0046, branch `feat/reading-redesign`) is not in it**; it moves to the next minor.
**0.58.3** (session 69, 2026-11-13; also a hotfix-line release, on top of 0.58.2): Tab/Shift+Tab nest list items and Shift+Enter writes the backslash line break (`indentEdit`, `breakEdit`, `structureKey` in `src/ui/format-shortcuts.ts`, wired through `onFormatKey`, which now steps aside for a key a picker already took); toolbar buttons for those and a code block (`codeBlockEdit`, `applyEdit`); a Markdown section on the syntax page. Contract and SDK unchanged. No migration.
**0.58.2** (session 69, 2026-11-13; a hotfix cut from the `v0.58.1` tag, so without main's #59, #143 and #144): the error log (ROADMAP row 59; `src/ui/error-log.ts`, `localStorage` key `blyg-error-log`, a ring of 100; `Failure` in `components.tsx` records every banner and links to Settings → Errors; `watchUncaughtErrors` in `app.tsx`; the API transport in `data.ts` notes failed requests so an entry can name one; nothing is recorded once `pagehide` fires; copy, export and clear in `ErrorLog` in `settings.tsx`); extension failures are logged under their name through `extensionContext` in `extensions.tsx`, which wraps every host context and adds `showError` (hosts type theirs `HostContext<…>`); focus view skips browser fullscreen on iOS (`platform()`); the mention hide/show write goes through `writeIfSyncing`. Contract and SDK unchanged. No migration.
**0.58.1** (session 62, 2026-11-09): a create from Reading after the items source was collected (#142; `writeIfSyncing` in `data.ts` around every confirmed `utils.write*`); comments to self open only at a line's start or after a space and not as `/**` (`opens`, `attachedOpeners` in `src/comments.ts`), with `parseComments` caching recent results and `useWithoutComments` waiting for a pause; focus view keeps the fragment tint; quick edit gets the `draftCounter` slot. Contract and SDK unchanged. No migration.
**0.58.0** (session 61, 2026-11-07): changelog display (#140, decision #95; `src/changelog-summary.ts`, `changelogSection` in `pages.ts`, `ChangeLead` in the reader): settings `changelog_display`, `reader_changelog_display`, `changelog_summary_prompt`; summaries from notes only, one per item version in `changelog_summaries` with a claim; `draftNote` `history`. The pace-layered order's R2–R4 (#141, decision #97): `maintenance` on `FeedVersion` from the loader (`src/change-size.ts`), bursts in `findBursts`, fixtures canonical in blygger-spec `conformance/feeds/` with CI-only `check:fixtures`. Private contract 5.8.0, SDK 0.14.0. **Migration 0045.**
**0.57.0** (session 61, 2026-11-07): six PRs for the blykker pilot and self-hosts, merged together: comments to self `/* … */` (#131; `src/comments.ts`, `withoutComments` before hashing, studio-private under #70), focus view (#126; `.editor.is-focus`, `useFocusView`, `src/ui/caret.ts`), the `draftCounter` extension slot and word count while writing (#125; fed `withoutComments(text)` at the merge, to agree with `CharCount`), `page.mainMenu` for extension pages (#133), the directive label baked as `data-blyg-label` and used as attribution text (#136, ROADMAP row 79, #81), single-node deploy configs pass the cross-check (#138; `envArgs`). Contract and SDK unchanged. No migration.
**0.56.0** (session 60, 2026-11-07): the Mentions lens (#134; tn-6 section 6, #91 B4): `src/importer/mention-index.ts` records h-card identifiers at import, `imported_mentions`, cron backfill; match on `author_url` plus the blyg's address until a member record exists; `.mention-you` highlight (`src/ui/own-mentions.ts`). The old mentions tab is labelled responses; route and API unchanged. Private contract 5.7.0, SDK 0.13.0. **Migration 0043.**
**0.55.3** (session 60, 2026-11-06): item pages are h-entries with a `p-author h-card` byline (#132; `asHEntry` in `pages.ts`, hidden, page chrome only). Contract and SDK unchanged. No migration.
**0.55.2** (session 60, 2026-11-06): fragment-mode cues (#128; `--fragment-bg`, `boxClass`, `CharCount`); Cmd/Ctrl+B, I, K (#129; `src/ui/format-shortcuts.ts`, `insertText` for undo); the toolbar above both panes and public-styled preview quotes with provenance lines (#130); one subscribe sheet through the address book offer (#127). Contract and SDK unchanged. No migration.
**0.55.1** (session 60, 2026-11-06): the address book offers a blyg on a manual subscribe and an author from the reading menu (#124; `customSheet` in `src/ui/sheets.tsx`, the manifest read from the browser with a fallback); help text; the section has its own form outside the settings form. Contract and SDK unchanged. No migration.
**0.55.0** (session 60, 2026-11-06): the address book and `@handle` (#123; tn-6, #91): `src/contacts.ts`, `src/ui/contacts.tsx`, consumed at publish on every write path through the `[[id]]` token splice, `unresolvedHandles` from publish and preview, `rel="me"` identifiers read as `self`. Plan and what remains: `../blygger-spec/docs/mentions-build-plan.md`. Private contract 5.6.0, SDK 0.12.0. **Migration 0042.**
**0.54.1** (session 60, 2026-11-05): one `theme-color` on the themed login page; the importer's sanitizer keeps `<data value>` (tn-6 section 5.3; first step of the RFC-1 build). Contract and SDK unchanged. No migration.
**0.54.0** (session 60, 2026-11-05): the `word-count` extension (#117; server half, so compiled in through `extensions.local.json`, never in `extensions.json`; `GET /api/ext/word-count/counts`, roll-ups over outline links only); Kyle Mathews' #122 (the hopper picker reads its rows when chosen, not when the menu opened; the Mentions half of #118 stays open); `classifyLinks` ages its cache by the caller's `now` (a fixed-clock test expired 2026-11-05). Private contract 5.5.0, SDK 0.11.0. No migration.
**0.53.0** (session 59, 2026-11-04): search on the reading and compose pages (#120; `src/ui/search.tsx` shared with the picker, `?q=` in the URL, opt-in `include=drafts` on `GET /search` for compose; `docs/search.md`); the login page wears the install's theme (#119; pure tokens in `src/studio-theme.ts`); the tab names the blyg and its icon takes the accent (#121; `src/ui/tab.ts`, `studioIconSvg`); Kyle's #116 (malformed Unicode isolated per read-batch child). Private contract 5.4.0, SDK 0.10.0. No migration.
**0.52.0** (session 59, 2026-11-04): Kyle Mathews' #114, batched reads: `POST /read-batch` (up to 50 children of one operation, each through its own handler, policy and quota; order kept; no caching), DataLoader in the browser with a microtask scheduler, ready D1 statements packed into native `db.batch()` per round; Mentions opens at 10 groups × 10 receipts. Aneesh Sathe's #112: §12.1 step 7 always on, `hopper_feeds` is the publish side only. #113 (#115): indexes for the `remote_id`-only lookup and the per-row hoppers subquery, pinned by `test/imported-lookup-indexes.test.ts`. Private contract 5.3.0, SDK 0.9.0. **Migrations 0040, 0041** (indexes only).
**0.51.0** (session 58, 2026-11-03): Kyle Mathews' #111 (Venkat's 2026-11-02 lag report): optimistic writes on the real row with mutation-owned refreshes, scoped write queues, rollback on failure; view-scoped collections; paged Mentions (`/mention-groups`, `/mentions/summary`, `/mentions?targetItemId=`, 25 groups × 10 receipts, viewport-loaded source cards); TanStack DB 1.0.0-rc.1.2. Private contract 5.2.0, SDK 0.8.0 (the PR left the contract at 5.1.0; bumped at release). **Migration 0039** (index only).
**0.50.0** (session 57, 2026-11-01): **hopper feeds** (Aneesh Sathe's #84; spec 0.4 §16.12, decision #86), off until Settings → Network → hopper feeds: `{mount}/h/{slug}/feed.xml` for public hoppers (no `blyg:` namespace, excerpts, `<source>`, join-time `pubDate`), the manifest's `hoppers` list, and §12.1 step 7 hopper subscriptions (identity = origin + resolved feed URL, `hopper_feed IS NULL` on every whole-blyg lookup, entries dropped when they leave, paused never converted when unlisted; `docs/hopper-feeds.md`). Plus #106 (partial quotes take CommonMark's blockquote extent, lazy lines included, #76) and #107 (own-line `![[id]]` in provenanced TK output transcludes, #60). Private contract 5.1.0, SDK 0.7.0. **Migration 0038** (0037 stays reserved for the AI-budget prototype).

**0.49.12** (session 55, 2026-11-01): Kyle Mathews' API-cleanup stack (#90–#101, tracker #92; 0.49.2–0.49.11 were never released on their own): private contract 5.0.0 and SDK 0.6.0, REST at **`{mount}/api`**, shared REST/MCP operations with declared policies and live capabilities, conditional item mutations (revisions), explicit camelCase resources and stable errors, cursor pages, HTTP validators on public JSON/XML, digest media URLs (`media/{id}/{sha256}.{ext}`). **Plus a host-root `/api` alias on mounted nodes for two releases** (Venkat: `/blyg` is one of the two recommended mounts): rewritten in `makeApp`, `Deprecation` + successor `Link`, legacy `{origin}/api` audience accepted in `verifyBearer`. Drop it deliberately two releases on. **Migrations 0034–0036** and `scripts/normalize-import-dates.ts` before deploy (deploy-all runs it); applied on all three nodes.

**0.49.1** (2026-10-30): Kyle Mathews' #86 (the studio title links to the reading page) and #85 (route loaders complete the hover/focus preload; the custom `Polling` scheduler is replaced by TanStack Query's native 15 s polling on live collections; reader links are router links; DB/React DB 1.0.0-rc.1). `AGENTS.md` is now the instructions file, `CLAUDE.md` a symlink to it. Two e2e flakes fixed (`reader-browse` waits for the feed to end the walk; `generated-highlight` was outside the per-test IP fixture and hit the 5/min owner-login budget). No migration.

**0.49.0** (session 53, 2026-10-29): browse the thicket from the reader — every quoted layer at any depth and every link that names a blyg item opens in the reader (`src/ui/reader-links.tsx`), items of unsubscribed blygs are read from their origin at `/peek` (`src/peek.ts`, nothing stored), back retraces the descent, and the walk is logged privately (`browse_log`, `src/browse-log.ts`) and shown in a *history* pane; public pages give nested quotes a provenance line (`injectNestedProvenance`); a stub's passage is selected in the editor's preview. **Migration 0033** (`browse_log`, `link_probe`).

**0.48.2** (session 52, 2026-10-20): a mention without the target's page names its item document (decision #85, blygger-spec#17) — `remoteTarget` in `mentions/send.ts` replaces `remotePermalink`: `page` when held, else `itemUrl` under the subscription's stored surface or, for an unsubscribed origin, a manifest read once per origin at enqueue (template and `webmention` endpoint, the endpoint stored on the `mentions_out` row); never `f/`·`t/`. No migration.

**0.48.1** (session 52, 2026-10-20): mention targets by membership (decision #84, blygger-spec#17) — `targetItemId` accepts a pinned version's document and page, each resolving to the item, and refuses a live page under the wrong kind (keyed on `authoredKind`, so a withdrawn item's page still resolves). No migration.

**0.48.0** (session 50, 2026-10-19): nine contributor PRs merged — Aneesh Sathe's #74 (OPML import), #75 (duplicate-upload guard, migration 0028), #77 (optional change classifier on decision models, 0030), #78 (six label-grammar edge cases), #79 (mentions and responses change domains, 0032), #80 (attachments per version, `version_media`, 0031), #81 (phone PWA fixes); Kyle Mathews' #76 (newest responses first) and #82 (TanStack DB bump). Merge fixes: a `rowid` tie-break on every attachment list (same-second uploads sorted randomly through the `version_media` join), both withdrawal mutants extended to the new `version_media` route, #77's settings e2e (five provider rows). Venkat's two features: own items in the reading feed get stub ↗ / hopper / fork (`~own` in `createResponseDraft`, same-origin `stub_of`, the lineage sheet's own-post note), and **local mentions** (`localMentionsSection` in `pages.ts`): a public page lists the blyg's own live items that stub, quote or fork it, chrome beside Responses, always on. `[[id]]` links join it once item o stores `links[]`.

**0.47.0** (session 49, 2026-10-17): labels `[[id | text]]`/`![[id | text]]` (#70, 0.4 §10.1): the bracket grammar now lives once in `src/grammar.ts` (directive, link, reserved, inline and own-line directive builders, `label()`, `labelText()`, `linkSource()`), used by transclusion, directives, tk, fork-flatten, plain-text, stub-quote and the editor; `src/link-label.ts` holds the heading-or-excerpt text shared by the bake, search hits (`label`), the picker and *copy [[id]]*. Generated output is stripped of inline grammar (`stripGeneratedGrammar`, row 67) and the prompt says so; own-line directives in output still quote (#60). Comments cite 0.4 sections. No migration.

**0.46.3** (session 49, 2026-10-17): 0.46.2 re-released. Its tag could not pass Check because GitLab rebuilt `release-v5.3.2` and deleted the two pinned conformance-suite digests (`manifest unknown`); both are re-pinned, recipe in `docs/oauth-interop.md`. The nodes run the same code.

**0.46.2** (session 49, 2026-10-17, tagged, never released): Kyle Mathews' #66 defaults an omitted OAuth `resource` to the mounted MCP resource at `/oauth2/authorize` (the `invalid_grant` behind #54; the default grant cannot reach REST), plus a pinned `oauth-interop` CI job (MCP Inspector + OpenID conformance, docker). Toolbar `title`s for #48. No migration.

**0.46.1** (session 48, 2026-10-13): the public HTML cache key carries `publicHtmlRevision` (epoch + items/subscriptions/hoppers/settings/feed from `change_state`), read once per public request in the gateway, so a publish no longer waits out the 60 s edge window. A failed read falls back to the plain key. `mentions_in` has no change domain, so mention hide/show still lags. No migration.

**0.46.0** (session 47, 2026-10-12): Settings is one page in sections (General, Feed, Appearance, Links: masthead menu + main menu, AI: model beside instructions per function, Network, Extensions) with a sidebar of anchors (`SettingsNav`, scroll-tracked, deep-linkable); `ModelSettings` split into `useAiModels`/`ModelIntro`/`ModelField`; `ThreadSearch` shared by the front page and the main menu; `links_position` defaults to left. No migration.

**0.45.0** (session 47, 2026-10-12): own posts in hoppers (membership under `OWN_SUBSCRIPTION = "~own"`, existing routes, no migration; out of the interaction log); autosave runs outside the editor's busy flag (`useAction().background`; the composer's draft-creating first save still holds it); the side menu stacks one link per line, puts the masthead over the content, and folds behind a Menu button below 62rem (`LINKS_SCRIPT`); thread search in the links-section settings. No migration.

**0.44.0** (session 47, 2026-10-12): the **links section** on every public page (`linksSection`, and `blygPage()` now frames every public page so none can miss it): `links_position` (bottom by default, or a left/right sidebar at ≥62rem), `links_threads`, `links_external`, and on-by-default `links_collections`/`links_opml`/`links_blygger_org`/`links_blygger_com` (ROADMAP row 5). Edited only in Settings, by Venkat's ruling: an exceptional action, not an item-menu one. Settings saves accept a stored value whose thread was since withdrawn. No migration.

**0.43.0** (session 47, 2026-10-12): a **static front page** (`src/front-page.ts`): settings `front_page` (a published thread; falls back to the latest items if withdrawn) and `posts_path` (default `posts`, reserved names refused); the root renders the thread, `/{posts_path}/` the latest items without it, and the thread's pages name the root canonical (decision #69, Fable review pending); the edge-cache matcher admits any free single segment. Kyle's #71 keeps `CancelledError` out of the banner. No migration.

**0.42.0** (session 46, 2026-10-11/12): the **pace-layered home page**, core and the fresh-install default (Venkat: the diachronic half of the premise, recommended to other clients): `src/feeds/` (contract, `pace-layered.ts`, `reverse-chronological.ts`, D1 history loader), wire-only inputs, worked fixtures in `test/fixtures/feeds/`, `climbFor()` the stub for changelog-driven climbing; the `feed_order` setting; **extensions may add orders** (`feeds` on `ServerExtension`, ids `<name>/…`, the core keeps published items only and renders every card; `extensions/feed-example`); the **setup walk-through** (`/studio/setup`, `setup` setting, server-served `defaults`); discard changes restores the stub citation and clears `dirty`. **Migration 0029** (`0028` stays reserved for #7). Plan: `docs/pace-layered-feed.md`.

**0.41.1** (session 45, 2026-10-10): TK grammar quoted in code inside a scope is text (#68; every token search in `parseScopes` skips code, found when a changelog quoting `[TK]` failed to publish inside an impyrt scope); the public AI box's source links take `--pencil`. **CI reworked (#67, #69):** parallel jobs, `scripts/ci-scope.ts` scopes a PR's e2e and mutation suites to the files it touches, every `main` push runs everything in its own concurrency group, and Release publishes after the tagged commit's green Check instead of rerunning the suite (first used for v0.41.1). No migration. Deployed to all three nodes.

**0.41.0** (session 44, 2026-10-10): **remote generation sources** (decision #44, gate G8): a [TK] scope draws on any item a directive may name (own threads, imported items), resolved by `resolveTarget`; remote sources carry `origin` + a frozen `cited` and send a mention verified as **`source`**; imports keep `generated` (**migration 0027**, `imported_items.generated_json`, with the change trigger recreated); a *source* picker inside TK instructions; preview scopes carry `sources`. **`PROTOCOL_VERSION` is `"0.4"`.** Exercised live PI → venkateshrao (ids in the devlog).

**0.40.0** (session 44, 2026-10-10): six contributor PRs — #64 composer caret (the `compose-pwa:179` flake), #61 `GET /api/reading/imported`, #62 YouTube posters and failed-image links, #60 Workers AI and OpenAI-compatible providers, #53 lineage-glyph extension (operator-compiled), #58 custom theme and reading typeface. No migration. Not deployed on its own.

**0.39.0** (session 43, 2026-10-09): read state for imported items (Aneesh's #44/#45: unread dots, select mode, mark all read, mark read on open; unread tombstones against stale reads; `readVersion` on `/api/reading`), under a new **`reading:state`** scope, which `owner:manage` no longer covers. **Migration 0026** (`read_state` + five triggers), applied to all three D1s before deploy and proven first on a throwaway remote D1.

**0.38.0** (session 42, 2026-10-09): releases carry two browser-only extensions, both off until enabled in Settings → extensions: `reading-time` (byline estimate) and `inspect` (⋯ sheet: the stored record, bodies elided). `extensions.json` lists what ships; `test-ui/default-extensions.test.ts` keeps anything with `server.ts`/`contract.ts` out; `{"remove": [...]}` in `extensions.local.json` drops a shipped one. No migration.

**0.37.0** (session 42, 2026-10-09): studio extensions (Aneesh's #52: catalog, build-time compile, per-node `extensions` setting, slots, GET-only `/api/ext/<name>/…`; read `docs/extensions.md`); init writes `nodejs_compat` (#46); paced autosave on TanStack DB (#47); shared item and hopper reads (#55). No migration.

**0.36.1** (session 41, 2026-10-07): webmention receiver (roadmap row 11): the same source/target pair claimed again within 60 s is refused (429, stored row untouched; the hourly caps count rows, so repeats had escaped them and re-run verification), and new claims are refused while 30 are pending (rows touched in the last 10 min). Each 429 carries its own `Retry-After`. No migration.

**0.36.0** (session 41, 2026-10-07): block-position detection treats document edges as blank lines, so a generated scope followed by one trailing newline renders as a block (row 2); `author_url` setting for `author.url`, blank = the blyg's own address (row 6); a `[[id]]` link takes the target's opening heading as its text (row 8). No migration.

**0.32.2** (session 38, 2026-10-06): security fix for mention verification (#61): the item document must come from exactly `{origin}items/{id}.json`, so same-host path-mounted impostors and pinned stub files fail, and a target outside the mount is refused. TK sources come from the instruction only, and publish warns on an unrequested own-line directive in TK output (#60). `page` stability test (#56). No migrations.

**0.32.1** (session 37, 2026-10-06): Kyle Mathews' #40, the D1 polling cache: Studio checks `/api/changes` revision counters (27 triggers, **migration 0024**) before reloading; `feed.xml` is served from R2 with ETags/304s, stale-while-revalidate, warmed by a minute cron. Three crons now (`* * * * *`, `*/15 * * * *`, `0 0 * * *`); a pre-0.32 `*/15`-only config still gets the daily work at 00:00 UTC. **0.32.0 was never released:** its 0024 used `SELECT CASE … END;` trigger guards, which D1's remote executor cuts at the first `END;` (local apply passes); `test/migration-remote-shape.test.ts` now rejects that shape. Before a D1 restore, see `docs/d1-polling-cache-operations.md`.

**0.31.0** (session 37): one response action. *Quote selection* and the reading-view pill are gone; a stub opens quoting the whole post; passages are chosen in the stub editor (`src/ui/stub-quote.ts`), with further passages added after the cursor for a running commentary; a "How stubs work" sheet. No migration.

**0.30.1** (session 37): a `304` poll skipped the daily index sync and name refresh, so ETag-honouring blygs whose first sync failed never synced again; live preview spends the read budget. No migration.

**0.30.0** (session 36, 2026-10-05): subscription names follow their source (**migration 0023**, `subscriptions.title_auto`; manifest title at the daily sync, RSS channel title every poll, owner names protected); resync all feeds (`POST /api/subscriptions/poll`); "Draft discarded" toast; long stubs quote their opening; thread counter without the limit; quote-only compose rows resolved. The first release after 0.28.2: 0.28.3 and 0.29.0 were deployed but their tags failed `release:check` and were deleted.

**0.29.0** (session 36): the `[[`/`![[` picker is a panel with full-text SQL search (`source`, `sub`, `sort`), and the `picker_typing` setting (automatic / editor / picker). No migration.

**0.28.3** (session 36): the outbound DNS check used `redirect: 'error'`, which the Workers runtime rejects, so every poll and Webmention failed on both nodes for ~70 minutes after 0.28 deployed. Now `'manual'`. No migration.

**0.28.0–0.28.2** (session 36): Kyle Mathews' #34 — OAuth grants, manual tokens, MCP, four scopes, the Access page, and a security pass (allowlist sanitizer, SVG sandbox, private draft media, outbound-destination checks, owner/grant work budgets; **migrations 0021, 0022**; needs `nodejs_compat`). 0.28.1 unwraps unlisted tags (0.28.0 deleted their content); 0.28.2 bakes transclusions verbatim again (sanitize at render). **The owner budgets bite in practice:** 120 writes/min throttled live preview (raised in the private config; preview moved to the read budget in 0.30.1) and 20 AI calls/day applied to the owner (interim 200). Follow-ups are on studio#39.

**0.27.2** (session 35, 2026-10-05): the editor's TK generate kept only the scope's output since 0.10.0; the generate route now also returns the spliced `content_md`. No migration.

**0.27.1** (session 35, 2026-10-05): 0.27.0 released. Every Release run since v0.21.2 had failed (an e2e screenshot to a machine-local path; the mutation tree missing `build/models.json`), so 0.21.2–0.27.0 have no downloads. No migration.

**0.27.0** (session 35, 2026-10-05): highlight generated portions on public pages. A `highlight_generated_default` setting and a per-item `highlight` override (**migration 0020**, `items.highlight_override`). The default lives in `style.css` and an override is a `gen-on`/`gen-off` class on the `<article>`. Themes have `genBg`/`genRule`. Robot badge (Brady Dale's convention); `GEN_INFO_SCRIPT` opens a version-level disclosure box from `data-generated`.

**0.26.1** (session 35, 2026-10-05): subscribe backfills under `waitUntil`; duplicate subscriptions 409; a source-URL citation line on every reading card; reading lands on the feed, with Feed/Sources tabs and one `ReadingHead` under every lens; Smart Feed "Coming soon". No migration.

**0.26.0** (session 34, 2026-10-04): one model per AI function (`ai_model_tk`/`_changelog`/`_feed`, falling back to the pre-0.26 `ai_model`, kept one release as a write alias) from an editable **`models.json`** (gitignored `models.local.json` overrides, merged at build into `build/models.json`; releases ship the base list only); OpenAI Responses and Gemini generateContent adapters beside Anthropic, all raw HTTP (`src/ai/provider.ts`, `src/ai/models.ts`); secrets `AI_PROVIDER_KEY`/`OPENAI_API_KEY`/`GOOGLE_AI_KEY`; `GET /api/ai/models`; the `feed_prompt` setting (stored, unused until the smart feed's agent). No migration.

**0.25.0** (session 34, 2026-10-04): reading lenses (All/Threads/Fragments filter by kind, `kind` on `/api/reading`; Background and Smart Feed placeholders); the private **interaction log** (**migration 0019**, backfilled; `src/interactions.ts`, logged at the store and at publish, never on the wire); `GET /api/interactions`, `GET /api/thumbs`; more → signals.

**0.24.0** (session 34, 2026-10-04): public hoppers listed as Collections on the homepage and archive; the hopper page gets `pageTop`, metadata and a description (**migration 0018**, `hoppers.description`); its Home link no longer points at the host root on path mounts.

**0.23.0** (session 34, 2026-10-04): stale quotes move from a compose banner to an *updates* tab, stalest first by `behind` (versions missed, summed over stale quotes); the batching norm stated on the page. No migration.

**0.22.0** (2026-10-03, contributed): the studio redesigned for the phone after Thicket Console — wears the reading theme, tab bar, NetNewsWire-style reading, bottom sheets for every confirm, copy + link / share, link from clipboard, scan-text instructions (optional on-device Tesseract), installable PWA. No API, contract or data changes; no migration.

**0.21.2** (session 34, 2026-10-04): five conformance-toolkit fixes (studio#27–#31): any feed gap reconciles; stub version agreement matches origin and id; forks keep a legacy author's `>` lines (partiality from `blyg-partial`); remote fork cites the pinned page when served; `<dc:creator>`. No migration.

**0.21.1** (session 34, 2026-10-04): akashtattva's #33, feeds for strict RSS readers (batched feed queries, ~4 s → ~0.5 s; absolute titled discovery link; atom self-link), with the provenance loader shared between feed and pages. No migration.

**0.21.0** (session 33, 2026-10-03): a *Version N / Change* confirmation dialog before every new version with a note (typed, drafted, or auto-drafted), and the `auto_change_notes` setting (off by default) that drafts one when the field is empty (#40). No migration.

**0.20.2** (session 33, 2026-10-03): XML-invalid characters filtered from the feed and stripped at publish, grapheme-safe excerpts (studio#15 parts 2–3; `src/text.ts`); `npm test` no longer fails on an operator's own `wrangler.jsonc` — the template guard is CI-only `npm run check:template` (studio#1); local migrations reserved `9000_`+ (studio#10).

**0.20.1** (session 33, 2026-10-03): own-line `![[id]]` in TK output is a quote again (provisional — Fable's §9.2 reading over studio#5, pending reconciliation with #20); "TK transcludes are not yet implemented" for imported/thread TK sources (until G8).

**0.20.0** (session 33, 2026-10-03): a fork flattens its pinned document (#57, `src/fork-flatten.ts`): quotes as attributed blockquotes, generated spans as impyrt, whole-HTML fallback. The build side of gate G11. No migration.

**0.19.0** (session 33, 2026-10-03): the composer autosaves (studio#23; first save after a 3 s pause and ≥ 8 characters); image alt keeps escapes (studio#6). No migration.

**0.18.0** (session 33, 2026-10-03): imports keep `stub_of`/`forked_from` verbatim (studio#12, **migration 0017**); `{url}` stubs cite the feed and entry, frozen at creation (#55). The build side of gate G10.

**0.17.0** (session 33, 2026-10-03): the bracket and TK grammar are inert inside code (#54, studio#4) and inside generated output (studio#5); links never nest (studio#13); preview resolves links in generated blocks (studio#14); no PUA markers reach HTML (studio#3). `src/code-ranges.ts` finds code with markdown-it's own parser. No migration.

**0.16.0** (session 32, 2026-10-03): images belong to the text they are in (`media.inline`, **migration 0016**; studio#24), attachment removal, uploads block navigation, the editor fills the window, `$` patterns spliced verbatim (studio#2), and **no built-in AI model** — operators set one (our nodes: `claude-sonnet-5-5`).

**0.15.0** (session 32, 2026-10-03): *history* on imported reading entries — the changelog read from the origin, and a word diff between public versions (decision #40, reader half). No migration.

**0.14.0** (session 32, 2026-10-03): drafted changelog notes, emitted as `changelog[].generated` when published unedited (decision #40). **Migration 0015.**

**0.13.0** (session 32, 2026-10-03): `[TK]impyrt=…[/TK]` — pasted generated text disclosed as generated (decision #37), with a *mark selection as generated* button. No migration.

**0.12.0** (session 32, 2026-10-03): stale-quote detection and one-click refresh — a *quoted snapshots* panel on the thread editor, a notice on compose listing threads whose quotes are behind, and `GET /freshness`, `GET /items/{id}/freshness`, `POST /items/{id}/refresh` (decision #33's direct check; #38's detect-always, refresh-on-decision). No migration. 757 Worker + 6 UI-state + 128 browser tests.

**0.11.1** (session 32, 2026-10-03), released and deployed: Kyle Mathews' #25 batches the public homepage's reads (≈300 D1 queries for 100 cards → 5–7) and migration **0014** adds four indexes, applied to both D1s first. Live time to first byte fell from ~4.2s to ~0.35s on venkateshrao and ~1.9s to ~0.3s on PI.

**0.11.0** (session 30, 2026-10-02): absolute URLs
in `content_html` (publish, import, bake, plus a cron repair of stored imports), thread cards that
show the thread, and image insertion at the cursor, via `/image`, paste and drop. Operators coming from
0.8.x have `docs/upgrading-to-0.11.md`. 735 Worker + 6 UI-state + 126 browser tests.

**0.10.0** (same session): Kyle
Mathews' #21 (documented `/api` + generated SDK, which was 0.9.0 and never deployed on its own)
and #22 (Studio as a React SPA). Migration **0013** (signal poll index) applied to both D1s first.
**Releases are cut by pushing a `v{version}` tag**, not by merging (session 30, Venkat):
`release.yml` builds the downloads (OpenAPI, SDK tarball, Worker archive, checksums) for that
tag.

Live on five nodes as of 2026-09-28, two of them Venkat's
(`venkateshrao.com/blyg/`, `blyg.protocol-institute.org`) and three strangers'
self-hosts. 0.8.3 was session 29's (four releases that day, 0.8.0 through 0.8.3).

0.8.0 carried the two-pane reader, `link post`, thread and reader titles, the responses
default, the timezone setting, update alerts, the `init`/`upgrade` scripts and the generic
packaging, plus the top menu, mobile pass and finished social cards. **It carried migration
0012**, applied to both databases before the deploy; a node upgrading from 0.7.0 must do the
same. 0.8.1 adds **partial transclusion** (§16.4, decision #49) — no migration, and
`PROTOCOL_VERSION` stays `"0.3"` because it implements 0.3 additively; its cross-node
exercise opened gate G7. **0.8.2** made a thread name itself in its author's own words on
all four surfaces that name one. **0.8.3** stopped the default title being the literal
`"blyg"` — derived from the deployment's own host now — and pointed `npm run upgrade` at
release tags rather than the tip of `main`, so it and the update alert agree about what
"current" means. 755 tests, `tsc` clean (with `noUnusedLocals`, on since session 28).

## Backlog — from Venkat's issue list (session 26, 2026-09-28)

> **Read entries below against 0.10.0.** Many name `studio.ts`, `importer/studio.ts`,
> `threadEditPage`, `actionScript` and other SSR-Studio code that no longer exists; the
> *semantics* in each entry still hold, but the UI half of an open item is now built in
> `src/ui/` (React) over an SDK route, adding to `src/contract/` if the route is new.

Triaged against the code, not the report. **Six items from that list turned out to touch
the wire and are not here** — they are parked in
[`../blygger-spec/docs/v0.3-plan.md`](../blygger-spec/docs/v0.3-plan.md) §8b for the Fable
round: plain `[[id]]` links, TK sources from another blyg, partial quotation, `impyrt`
(externally generated spans), `#`-heading-as-title, and the write-surface question (1.8).
**All six ruled session 27** — see §8c there and the "From the session-27 Fable round"
block below.
**Two of the five reported "bugs" are not bugs** — see §8b; the client is doing what it
was specified to do in both cases.

### Bugs

- [x] **`[[id]]` must be inert inside code spans and code blocks** — **done 0.17.0 (session 33)**, with studio#3/#5/#13/#14 (spec decision
  #54 on blygger-spec#4): §10.1 now gives the link form the same exemption the directive
  always had. studio#4 covers both forms. Fix both in one pass in the renderer and in the
  preview; a code block that quotes the grammar must publish as literal text.

- [x] ~~**Reader view doesn't roll up entries**~~ — **dropped session 30 (Venkat): a
  mistaken diagnosis**, not a bug. Nothing to build.
- [x] **Transclusion picker stops after a few items and has no search** — **done 0.7.0.**
  Neither half was what the report implied. There was never a missing query box: the query
  has always been the text you type in the editor. What existed was a *dead*
  `<input class="search">` in the palette markup, wired to nothing, which took focus and
  swallowed keystrokes and so read as a broken search field — replaced by a hint line
  naming the active bracket form. The ceiling was a silent `.slice(0, 20)`;
  `/fragments/search` now returns `total`/`offset`/`limit`, the palette states the count
  either way, and ArrowDown at the bottom of a partial list pages instead of sticking.

### Feature refinements

- [x] **Switch fragment → thread in the composer before first publish** — **done 0.7.0**,
  and the gap was in the *editor*, not the composer: the composer's toggle already worked by
  deleting the draft and recreating it, which is safe only because the text lives in the
  textarea it was typed into. Past the Full Editor door that stops being true (attachments,
  TK scopes, save history), so `PUT /api/items/:id` now accepts `kind` and changes the row
  in place. Guarded at `version === 0` in the handler *and* in `setDraftKind`'s SQL — a
  withdrawn item counts as published, because its endcap and its versions are both out
  there. A stub thread is refused (409) rather than silently losing its citation; "clear
  stub" is the way through.
- [ ] **The changelog AI judges the change: trivial / minor / major, in the note** (Venkat,
  session 50, after Fable's #83 ruling dropped the `ignyr`-in-changelog idea). When AI change
  notes are on, the same call that drafts the note also judges how big the change is and
  leads the note with it in words, shown in the confirm dialog to edit or clear. The
  change classifier (studio#77, Aneesh) already does this with a *decision* model
  (`ai_model_classify`, `change_category_in_note`); this item gives the text-model path the
  same result when no decision model is configured, sharing `composeNote`. Under #83 it is
  prose only: no reader parses it, and the studio never routes on it, inbound or outbound.
- [ ] **Bulk-update stale transcluded snapshots in a stub.** **Unblocked (decision #33):**
  freshness is direct and needs nothing new on the wire — fetch `{origin}items/{id}.json`
  and compare `version` to the reference's. Build the probe and the UI against that.
  Transitive ("over the DAG") staleness is undefined and stays out.
- [ ] **Link probing traffic (parked, session 53).** `classifyLinks` makes the Worker fetch pages behind an entry's links (cap 40, cached 7 days in `link_probe`). Venkat: minimal for now; revisit only if heavy traffic of that type becomes a problem. Trigger and options: `../blygger-spec/docs/backlog.md` §2. Drop this line when that row is ruled or scheduled.
- [x] **Show second-degree references within a stubbed item.** **Done 0.49.0 (session 53):** the layers' own `data-blyg-*` carry every depth, so nothing needed fetching — each nested quote gets a line naming its source that opens in the reader (`ReaderBody`) and, on public pages, a provenance link (`injectNestedProvenance`). Original entry: Presentation is this client's
  call (§8.4 does not constrain presentation — session 20). **Check the data exists first:**
  we hold a snapshot of the target, not the target's own reference list, so this may need a
  fetch we don't currently make — in which case say so rather than half-rendering it.
- [x] **Open a reader item in a new tab** — **done 0.7.0.** Each reading entry carries
  `open ↗`, derived from `sourceTitleAndUrl` rather than a second URL-shaped guess: the
  origin's declared `page` wins (#29), `f/`·`t/` is a fallback, L0 points at the anchor its
  feed gave, own items point at our own public page, and a withdrawn own item gets no link.
  Always `target="_blank"` — the studio holds unsaved composer text.
- [x] **Offer plain linking in the reader** — **ruled #50 and built 0.7.0.** Raised as a
  possible collision with #27 by the session-28 Opus run and ruled by Fable the same
  afternoon: #27's forbidden sibling was a *response* affordance that did not declare
  itself, and #32 ruled `[[id]]` declares nothing, so this is a different act — citing
  without responding. Shipped as `copy [[id]]` in the reading entry's byline beside
  `open ↗`, **never** as a peer of `stub ↗` in the actions row, which stays the one
  affordance meaning "I am responding"; #50 makes position semantics, so the tests pin it.
  Offered only where the link would resolve at publish (`resolveTarget`'s order, #26): our
  own published items and imported non-L0 blyg items that are current or pin-retained. L0
  rows get `open ↗` and nothing else — a legacy feed has no item document to link to. The
  `[anchor](url)` half of this backlog entry is not built and is not needed: ordinary
  markdown already does it, and #50's ruling is about the construct the reader could not
  otherwise reach.
- [x] **Discard button for an unpublished new version** — **done 0.7.0, and the defect was
  worse than this entry implied.** The control existed and worked; the *thread* editor just
  never rendered it. `threadEditPage` computed `discardBtn` — both branches, with the
  comment explaining the distinction — and dropped the variable on the floor, so neither
  "discard draft" nor "discard changes" appeared on any thread. Every case in the discard
  test block opened the fragment editor, which is why a whole control could be missing from
  half the studio with the suite green. `noUnusedLocals` is now on for exactly this class.
  The session-19 `location.reload()` trap was already handled — the `discard` branch
  navigates to the index.
- [x] **Reorder the tabs** — **done 0.7.0.** reading, compose, hoppers, mentions,
  subscriptions, settings, syntax. `NAV` is the single source of order and `compose` stays
  the bare studio path wherever it sits; the order is asserted now, since it was not before
  and the reorder would have been invisible to the suite in either direction.
- [ ] ~~**Emit `cited` on every reference**~~ (decision #30, spec §16.1): serialize the existing
  `StubCite` — `source`, `author`, `excerpt` (cap ~200 chars), `url`, `retrieved`
  (REQUIRED) — as `cited` inside `stub_of`, each remote `transclusions[]` entry, and
  `forked_from`, on live and pinned documents. **Read side:** when importing a document
  that carries `cited`, use it as the frozen citation (it is more correct than a later
  lookup, not a fallback) and never as verification input; `verifyMention` reads the bare
  reference only. Never render it into `content_html`. The stale-byline finding for remote
  transclusions is the same fix.
- [x] **Render `[[id]]` as a plain internal link** — **done session 27 (0.6.0)**. Grammar
  sits beside the directive regexes in `transclusion.ts` (a negative lookbehind is all that
  separates them), resolution is literally `resolveTarget`, hrefs are absolute because
  `content_html` travels, anchor text is a short quote of the target since items are
  titleless, and previews resolve it too. Silent on the wire as ruled. Original entry:
- [ ] ~~**Render `[[id]]` as a plain internal link**~~ (decision #32, spec §16.2): inline
  anywhere in `content_md`, resolve by the `![[id]]` order (#26), render `<a href>` to the
  target's `page` (remote: origin + page), anchor text is ours to choose. Unresolvable is a
  publish error. **No** `transclusions[]` entry, **no** mention, **no** wire class — it is
  invisible on the wire by ruling, not by omission.
- [x] **`[TK]impyrt=<text>[/TK]` in the composer** — **done 0.13.0 (session 32)**: parsed in `tk.ts` with its provenance carried by the grammar (`imported`), so it never touches the positional cache; *mark selection as generated* in the editor; generate refuses it. Original entry: (decision #37, spec §5.7 rule 7): a
  studio-private TK form whose output is the pasted text verbatim, wrapped as an ordinary
  `blyg-tk-gen` span, with a `generated[]` entry carrying `sources: []` and `model`/`at`
  only if the author supplies them. No new wire member and no "external" flag. The
  composer may offer a model picker for the entry; it must not invent one.
- [ ] **Agent-contract hooks, direction only** (decision #39, roadmap-tracks 1.10/2.10):
  when 2.9's tokens land, include a **read scope** for studio-private material (drafts,
  hoppers, signals, mentions) so an agent can poll `/api` for staleness, inbound mentions
  and new imports. Poll first; no webhooks until a need is measured. The public state
  plane needs nothing — it is already the corpus.
- [x] **Generate a changelog note** — **emission done 0.14.0 (session 32)**: *draft note* in the editor (`POST /items/{id}/note-draft`, `src/change-note.ts`), editable, drafted before publish rather than at it so publish stays network-free (#26); `changelog[].generated` only when published unedited (migration 0015); the §5.2 depth rule checked mechanically (`quotesWithheld`, 6-word runs of removed text) as well as prompted. The history view below is the other half of gate G6. Original entry: (decision #40,
  roadmap-tracks 2.12, spec §5.2 + §16.6c): at publish, diff the locally held prior
  version against the new one and draft a note through the existing generation provider.
  **Pin-bounded depth is the one hard rule:** if the prior version is unpinned the note
  describes and MUST NOT quote it; between two pinned versions it may be as full as it
  likes. Editable before publish. Emit `"generated": true` on the changelog entry for such
  notes — that emission is what promotes §16.6c into §5.2.
- [x] **History view on a rolled-up item** — **done 0.15.0 (session 32)**: *history* on reading entries (blyg subscriptions), changelog read from the origin on demand (`src/imported-history.ts`), *see the change* only between public versions (adjacent pins, last pin → current), word diff in `src/word-diff.ts`. With 0.14.0's emission this is the whole build side of gate G6; G6 opens once both nodes have used it. Original entry: (#40): notes as a timeline; where two
  consecutive versions are both pinned, a local diff of the two pinned files ("see the
  change"). Needs nothing from the wire; works on any imported 0.2+ blyg with pins.
- [ ] **Discovery surfaces from references** (decision #41, roadmap-tracks 2.13). Four,
  none touching the wire, in this order of payoff:
  1. **Chain view.** **Built 0.49.0** (the subscribe affordance is the *not subscribed* alert at `/peek`; the per-origin manifest title is the subscription title or the host). Original: Parse the stored `content_html` of an imported thread for nested
     `blockquote.blyg-transclusion` and read `data-blyg-id/version/origin` at every depth;
     render the chain with a provenance line per layer (today only the direct layer gets
     one) and a subscribe affordance per origin not in `subscriptions`. **Absent
     `data-blyg-origin` on a nested layer means the origin of the layer that baked it**,
     not ours — carry origin context down the tree. One cached manifest fetch per unknown
     origin for its title. `importer/sanitize.ts` is allowlist-by-removal and keeps
     `data-blyg-*` (verified session 27), and stored HTML is verbatim anyway.
  2. **"Responds to" walk.** From an imported item's `stub_of`, fetch
     `{origin}items/{id}.json`, show the target and follow *its* `stub_of`; bounded
     (~6), cached, each origin subscribable. Works for chains you are not in.
  3. **The conversation around you.** Verified inbound mentions ∪ your outbound
     references, grouped by origin; "responded to you, not subscribed" at the top.
  4. **Second-degree blogrolls + cited origins.** Fetch each subscription's
     `blogroll.opml` (§11) and aggregate every `origin` in imported provenance; list
     origins minus subscriptions, ordered by how many of your reads list/cite them.
     Local ordering only — never published, never shown as a count on a public page.
  **Do not** scrape another blyg's public responses list for the forward direction; it is
  presentation, and #28 keeps verified mentions off the wire by decision (spec §16.6d).
- [x] **Emit `generator_url`** and **`PROTOCOL_LEVEL` → 2** — **done session 27 (0.6.0)**,
  in one commit as this entry asked. Original entries:
- [ ] ~~**Emit `generator_url`**~~ (decision #34, spec §16.6a): one absolute URL beside
  `generator` in the manifest — `https://github.com/blygger/blygger-studio`, derived from
  `CLIENT` like `GENERATOR` is. Same commit as the level fix below; together they promote
  §16.6a into §6.1.
- [ ] ~~**`PROTOCOL_LEVEL` → `2`.**~~ Live nodes emit `"level": 1` while publishing 0.3
  constructs; 0.3's §3 defines L2 as this specification. One line. (Readers may not gate
  on it — §3.2 — so this is honesty, not compatibility.)
- [x] **Store the target version per outbound mention** — **done session 27 (0.6.1, migration
  0011)**. `mentions_out.target_version`, a null-safe change test, and withdrawal as the one
  caller allowed to force a re-send (§15.7 owes a mention precisely because nothing changed).
  This is the half the 0.3 freeze needed: §15.2 asserted the reference client did this and it
  did not. **The other half shipped in 0.12.0 (session 32)**: `src/freshness.ts` reports each
  quote of a published thread against what a republish would bake (asking `resolveTarget`
  itself, so it cannot drift from publish) and probes `{origin}items/{id}.json` for remote
  quotes; `POST /items/{id}/refresh` resyncs lagging subscriptions and republishes. Found on
  the way: "discard changes" leaves `dirty = 1` on purpose (a restore drops the positional TK
  provenance cache), so refresh gates on *holds the published words* — clean, or byte-equal
  with no `generated[]` to lose — not on `dirty`. **The same restore hazard is live for any
  republish**: restoring a version that disclosed generated text and publishing it again
  drops `generated[]`. Not fixed here; `impyrt` (#37) is the natural repair — re-wrap the
  restored spans. Original entry:
- [ ] ~~**Store the target version per outbound mention**~~ (roadmap-tracks 1.7, decision #33):
  `enqueueOutbound` resets every row to `pending` on republish because `mentions_out`
  holds no target version; spec §15.2 says unchanged references are not re-sent. Same
  missing fact as the freshness probe above — build them together.

### From the session-28 Fable round (2026-09-28) — the first 0.4 construct

- [x] **Partial transclusion** (decision #49, spec §16.4) — **built, released as 0.8.1, and
  exercised across both nodes (session 29)**. P1–P7 and P9 done; **gate G7 is open**. P8 —
  promoting §16.4 into §10.1–§10.3 and the `css-contract.md` line for `blyg-partial` — is the
  Fable session's, with the P4 call below as the rule to record.

  **The exercise (P9), all four parts passing:** PI item `0180khm1xmrgpsqqe65v51bp4w` stubs
  venkateshrao `54pwr12zqvvaj37zqx0f8vdbhk` v1, quoting one paragraph. (a) `selector` with
  `exact`/`prefix`/`suffix` on the wire beside `cited`, `blyg-partial` in the bake;
  (b) verified as `stub` on venkateshrao; (c) both classes and all three `data-blyg-*`
  intact through import; (d) a wrong passage refused at selection time. The public page
  reads *from Venkatesh Rao's Blyg ↗ · excerpt of v1*.

  **What the build settled and found:**
  - **P4 stands as written.** The bake is the selection's plain text in `<p>`s, not a carved
    sub-range of the source's inline HTML. No reason emerged to reverse it: the selection is
    defined on text, and cutting an HTML range faithfully (reopening the tags a cut crosses)
    is a second project. Emphasis in the source does not survive into the quote, which is
    the visible cost and is the right one to pay.
  - **The normalizer is the whole construct** and is one function, `selectionText` in
    `markdown.ts`, with a second entry point `normalizeSelection` for text that is already
    text (a browser selection). Its subtle rule: whitespace *within* a block collapses,
    including the raw newlines markdown-it leaves inside a `<p>`. Splitting on literal
    newlines would make a match depend on where the author pressed return.
  - **`injectProvenance` was matching the class attribute as a literal string**, so a
    partial got no provenance line — and, worse, did not advance the provenance index, so a
    thread mixing both forms mis-paired every line after the first partial. Found by opening
    the page; the suite was green. Fixed and pinned by a mixed-thread test.
  - **A partial says "excerpt of v2"** where a whole one says "snapshot of v2". §16.4 puts
    the disclosure on the second class; this is its human half, without which an excerpt and
    a whole transclusion are the same blockquote, differing only in being shorter.
  - **Select-to-quote checks at selection time**, not at publish: a passage that cannot be
    published is refused while the author is still choosing it.

  Original entry: **Implementation plan: `blygger-spec/docs/v0.4-plan.md` §7.3, tasks
  P1–P9; do this before remote sources, per §7.4.** Grammar: a `![[id]]` directive immediately followed — no blank
  line — by a markdown blockquote is a partial transclusion; the blockquote's text is the
  selection; a blank line detaches it (whole transclusion + the author's own quote stays
  writable). Publish: the selection MUST be a substring of the target snapshot's **text
  content** — `content_html` with tags stripped, whitespace collapsed within a block, block
  boundaries as line breaks; write that normalizer once and use it for publish-time check and
  any read-side re-check — else a publish error like an unresolvable directive. Wire: the
  `transclusions[]` entry gains `selector: { exact, prefix?, suffix? }` (W3C text-quote
  shape; keep prefix/suffix short, ~32 chars). `verifyMention` ignores it. Bake:
  `class="blyg-transclusion blyg-partial"` with the usual `data-blyg-*`; whether the bake
  carries inline formatting from the source HTML or plain text in `<p>`s is yours to settle
  and record. No length cap. Relation stays `transclusion`; staleness unchanged. `{url}`
  stubs get nothing — an ordinary blockquote. Studio: select text in the reading view →
  "quote" prefills the directive-plus-blockquote; the stub action prefills this form for
  long targets instead of the whole item. Record the cross-node exercise in your devlog — it
  is what lets Fable promote §16.4 into §10.
- [ ] **Read templated blygs — the manifest locates the surface** (decision #51, spec §16.6e; 0.4;
  **implementation plan: `blygger-spec/docs/v0.4-plan.md` §7.5, tasks M1–M4**). Reader side only —
  our own surface keeps the default paths and emits no template keys. Parse `feed`/`items`
  (authoritative, defaults) and the new `item`/`pin` RFC 6570 level-1 templates (`{id}`, `{n}`)
  from a fetched manifest; one expansion helper used everywhere an item or pin URL is built
  (importer, staleness check, remote `[[id]]` pages, verification). `resolve.ts` step 4: fetch
  the `rel="blyg"` href — a body that parses as a manifest *is* the manifest, else append
  `blyg.json`. Identity = manifest URL minus its last path segment, not "minus `blyg.json`".
  `page` may be absolute. One migration (subscription row gains the resolved locations,
  NULL = defaults). Gate: subscribe a live node to the first templated third-party blyg
  (the WordPress case from blygger-spec#2), transclude from it, and confirm the mention
  verifies on their side.
- [x] **Reader-side `[[id]]` affordance** — **built 0.7.0**: `copy [[id]]` in the reading
  entry's byline. See "Offer plain linking in the reader" under Feature refinements for
  what shipped and which of #50's conditions the tests pin. Opened by the Fable round in
  parallel with the build, so it was never open in practice. Original entry:
- [ ] ~~**Reader-side `[[id]]` affordance**~~ (decision #50, answering the ⚠️ FABLE flag raised
  2026-09-28 — the "distinction worth ruling on" in the feature-refinements entry above is
  the ruling): allowed, no collision with #27 — a link is not a response. Build it as the
  reader end of the `[[` picker work: an action on a reading-feed entry that **copies
  `[[id]]`** or **inserts** it into an open draft. Name it for what it does, place it beside
  copy-permalink, never as a peer of `stub ↗` in the response slot, never
  "respond"/"reply"/"answer". `stub ↗` stays the one affordance that means "I am responding".

- [x] **Remote generation sources** — **done 0.41.0 (session 44)**, R1–R8; findings (migration 0027, thread sources fed as baked text) in `v0.4-plan.md` §7.2 R8. Original entry: (decision #44, spec §16.3; 0.4). **Implementation plan:
  `blygger-spec/docs/v0.4-plan.md` §7.2, tasks R1–R8 with acceptance checks — build from that;
  this entry is the shape.** Widen `resolveFragment`'s
  TK-source rule to `resolveTarget`'s (#26 order: local published item → imported item with a
  current or pin-retained snapshot → error; threads allowed; more than one imported match is
  an error). What is fed to the provider is the **stored local snapshot** (`content_md` as
  held), never a fetch. `ScopeProvenance.sources[]` entries take the §5.9 reference shape:
  add `origin` for remote sources (omit for own — every existing document stays valid), and
  carry `cited` the way remote `transclusions[]` entries do. Disclosure is **direct only**: a
  thread fed as a source is disclosed as that thread. **Send a Webmention** for each remote
  source on publish with relation `source`, through the existing outbound queue (target
  version stored per migration 0011); **receive** it: `verifyMention` step 4 gains a fourth
  clause — a `generated[].sources[]` entry with `origin` = ours and `id` = target →
  `source`. Relation set becomes `stub | transclusion | fork | source` everywhere it is
  enumerated (types, D1 CHECK constraints if any, the mentions view, the responses list).
  Nothing new in `content_html`. Exercise it across both live nodes — a TK scope on one
  drawing on the other's item, verified `source` on the far side, provenance intact on
  import — because that exercise is what opens the 0.4 document (#43). Bump
  `PROTOCOL_VERSION` to "0.4" in the release that ships it (#18d: emit what you implement).

### Queued for the next version (session 28, Venkat — asked for before release)

Deferred when the session wrapped, not blocked on anything.

- [x] **SEO metadata and social cards** — **most of it already existed** (`f4ac2c9`,
  session 18): `PageMeta` has driven `description`, `og:*` and `twitter:card` on the feed,
  permalink, thread, pinned and archive pages since 2026-09-13, with `og:image` as the
  item's first attached image falling back to the avatar. Session 29 closed the three real
  gaps rather than rebuilding it. **The one that mattered was the `og:title` derivation
  this entry called out in advance:** items are titleless (§5.3), so the title was a
  70-character excerpt of the rendered item — and once #46 made a leading heading the
  item's title, a titled item unfurled as "On Protocols Protocols are the thin layer…",
  the heading followed by the heading again as the first words of the body. `itemHead()`
  now reads the declared heading where there is one and takes the description from what
  *follows* it, which is the same derivation the feed page, the permalink and the studio
  reader already do. `og:title` also dropped the site suffix (`og:site_name` is the tag
  that says where). The other two: a pinned page and the archive had no `og:image` (both
  now carry the blyg's avatar — never the item's *current* attachments on a pinned page,
  whose whole promise is the bytes from then), and the archive turned out to have the same
  title-into-body defect in its **visible rows**, not just its head. No wire effect
  anywhere; a client's own `<head>` stays its own business.
- [x] **Style the nav as a proper top menu** — **done session 29.** Sections are a `<ul>`
  of real targets (padded, hover wash, the current one filled and underlined), utilities
  are their own right-hand group, and below 640px the whole bar collapses behind a
  hamburger. The collapse is gated on an `html.js` marker set in the head: a stylesheet
  that hides navigation is only safe when something can bring it back, and putting the
  marker in the head rather than beside the menu is what stops a phone painting an
  expanded menu and then snapping it shut.
- [x] **Mobile pass** — **done session 29**, and checked by opening every studio and public
  page at 390px rather than by asserting on CSS. Three real problems, all fixed: horizontal
  overflow (one pasted URL sets the page's minimum width and *every* page scrolls sideways),
  tap targets (the action rows were ~26px, the public pages' version arrows ~18px), and
  page gutters. The reading sidebar now collapses behind a control that names the source
  you are filtered to, so a collapsed sidebar still answers "what am I looking at". Opening
  the pages found one defect the suite could not: the archive listing ran a titled item's
  heading into its body, which is the fourth naming surface #46 did not reach.

### New features

- [ ] **Quoted lists keep their structure** (session 78, decision #114, spec §16.15; ROADMAP
  row 136; shape fixed in `blygger-spec/docs/opus-brief.md` § New from session 78, item a).
  In the partial bake, a line that lies in a list item of the target bakes as `<li>` in a
  list like the target's; the structure comes from the target snapshot, never from the
  quoter's markers, and a mismatch is not an error. Test the invariant
  `selectionText(bake) === selector.exact`. Admit an integer `start` on `ol` in the import
  sanitizer. The cross-node exercise promotes §16.15.
- [ ] **Corrections are not generation** (session 78, decision #115, spec §5.7 rule 10; item
  b there). The spellcheck extension's accepted fixes go in bare; its AI proofread offers
  corrections only, and a rephrase goes through `[TK]impyrt`. Offer a changelog-note line,
  in words. Revise `docs/mods.md` "Model text is disclosed" to the same boundary. No
  `edited` member in any spelling.
- [ ] **Background 4b: let the owner turn off the disagreement default**, and put the owner's
  instruction first in the model's state (session 78 review; item d there).

- [ ] **A responses count on public pages** (session 73, decision #107; ROADMAP row 127;
  shape fixed in `blygger-spec/docs/opus-brief.md` § session 73). The count is the length
  of the public responses list the page already renders (verified, unhidden, list switched
  on for the item), shown as text on the item's page and on same-origin lists that show the
  item; nothing at zero or with the list off. **Never data:** not in any protocol document
  or feed, no `data-` attribute, microformat, JSON-LD or meta tag, with a test that says
  so. Nothing public sorted or selected by it; no blyg-wide total, no per-responder tally.
  Build with the studio-private counts and the Responses tab (Venkat, session 72), which
  need no ruling.
- [x] **`cited` on `{url}` stubs** — **done 0.18.0 (session 33)**. Finding: a hostname-only `cited` had been emitted since 0.4 (live on three venkateshrao stubs); what was missing was the import half (studio#12, now kept verbatim) and a useful citation (feed name + entry title, frozen at creation). Original entry: (session 31, decision #55; spec §16.1a — a ruled shape,
  normative once this ships and an import retains it): when a stub targets a plain URL, emit
  the §5.9 `cited` object on `stub_of` — `retrieved` always; `source`, `author`, `excerpt`
  (≤ ~200 chars, a caption) and `url` when the page offers them. The pour-over-links
  affordance (studio#17) is the natural producer. Importer: assert `cited` survives on a
  `{url}` stub. The cross-node exercise opens gate G10.
- [ ] **`page` never changes for an item** (session 31, decision #56; spec §5.8 SHOULD): the
  client already emits a fixed `f/{id}/`·`t/{id}/`; add the assertion so slug work
  (studio#19) cannot break it, and if slugs ever ship, a renamed slug keeps a redirect.

- [ ] **Reset the owner password in settings.** **Design is fixed (decision #31), build with
  or after tokens:** a reset rotates the root secret and invalidates sessions; tokens are
  independent and survive, and the reset flow MUST list them and offer revoke-all, because
  compromise is exactly when an attacker has minted one. Auth today is one shared
  `OWNER_PASSWORD` behind a 30-day HMAC cookie. Anything beyond that shape is Fable.
- [x] **Timezone localization for displayed dates** — **done session 28.** A `timezone`
  setting, filled from a list the *browser* supplies (`Intl.supportedValuesOf`) and
  preselected to the device's zone when unset. `formatDateIn(iso, timeZone)` takes the zone
  as a **required** parameter on purpose: that turned "find every date" into a compiler
  task, and it found 28 call sites across six files. Wire unchanged and tested — feed dates
  RFC-822 in GMT, item documents ISO-8601 UTC. An invalid zone is rejected on save *and*
  falls back to UTC on render; the second half matters because a bad row is not a typo.

## Anthropic keys for the production blygs (changed 2026-10-07)

Each deployed blyg Worker has its own Anthropic key in its `AI_PROVIDER_KEY` secret (the name `models.json` maps to Anthropic): `blyg-venkateshrao` → `ANTHROPIC_KEY_BLYGS_VENKATESHRAO`, `blyg-blygger-org` → `ANTHROPIC_KEY_BLYGS_BLYGGER_ORG` (**new** — it had no AI key before, so [TK] generation is now available there), `blyg-protocol-institute` → `ANTHROPIC_KEY_BLYGS_PI` (PI account, PI workspace). All three live in `Code/.env.keys` / `protocol-institute/.env.keys`, service account `blygs`, one single-workspace key each. Coding/dev work uses `ANTHROPIC_KEY_BLYGGER`. **Exercised 2026-10-07 (session 41):** one [TK] generation per blyg succeeded on all three (the official blyg first needed `ai_model_tk` set to `claude-sonnet-5-5`); Venkat confirmed usage on all three keys in the Console on 2026-10-09 (session 43). Set secrets with `wrangler secret put AI_PROVIDER_KEY --name <worker>` (explicit `--name`; see `Code/warnings-node.md`). Plan: `Code/anthropic-key-plan.md`.

## Session rituals

**Base:** [`Code/devops/rituals.md`](../../devops/rituals.md) — v1.0. Startup is S1–S7, wrap-up is W0–W7 (IDs reserved). Everything below is this
project's **local config**; it adds to the base and never replaces it.

**Ritual config**
- **Log:** `../blygger-spec/DEVLOG.md` (the one program log for all four repos; dated entry, non-skippable).
- **Startup extras (S5):** new PRs and issues in all four repos, new blygger.com listings and the ecosystem census (S5b and S5c in `../blygger-spec/CLAUDE.md`)
- **Verification (W2):** tests plus a real click-through on a node; for key changes see the Anthropic-keys section above.
- **Wrap-up extras (after W5):** update `../blygger-spec/ROADMAP.md` (W5b in `../blygger-spec/CLAUDE.md`)
- **Deploy policy:** `wrangler`-based; authenticate with `wrangler login`, always `--name` for secrets; only on request.
- **Carry-overs (S6):** none

<!-- BEGIN @tanstack/oracles (template 4) -->

## Oracle tests

This repository tests its design with `@tanstack/oracles`. An oracle
captures the code's design as laws and enforces them against an independent
model. Work oracle first, production second.

**Who owns what.** The laws belong to the people who maintain this
repository: what the code promises, the authority for each promise, and its
limits. Propose a law, but do not adopt or change one without their
approval. The production code that the oracles own is yours. Whenever you
change it, do a good job, not a minimal or lazy one: the fast, small,
elegant version, as an optimizing compiler for the oracle would write it.
Anything that keeps every oracle passing is allowed, so a big refactor is
fine when it makes the code better; the oracle is the review. Keep it in
proportion to the task: improve the code the work touches, and when you see
a larger win elsewhere, offer it instead of turning the task into a long
optimization project.

**How the work goes.**

- **Probe first.** Before you propose anything, call the real code with
  small scripts and show what they print. Every law and every finding comes
  with a probe that can be rerun.
- **Propose the laws, then build only the approved ones.** Each law is a
  "For every …" sentence with where its promise is written: the docs, a
  test, or a maintainer's decision. A question nobody has decided is fine:
  state it as a limit.
- **Red first, like TDD, but the oracle goes red.** A bug becomes a law and
  a history that fail on the unchanged code. Then fix production at once,
  and show the run going green.
- **Never weaken or quarantine an oracle:** no skip, no `test.fails`, no
  loosened expectation, no switch that turns a check off.
- **Build the strongest model the laws need.** Compare every observable
  result they speak about. The model states the rule a user relies on,
  never the code's algorithm, even when the docs describe that algorithm.
  Give each law a calibration: a wrong answer the check must reject.
- **Run the oracles only through the gap check, never Vitest alone.** It
  prints each test file's result first, then each gap as it is judged, and
  ends with one `oracle-gaps: done` line. A run
  can take minutes: start it in the background with output to a log at a
  path of its own (never a fixed path under `/tmp`), and read the new lines
  every few seconds, acting on a failure first. Stop a
  run only by the process ID you recorded, never by name.
- **Green is not done.** A gap is a change to the owned code that no law
  notices. There are no equivalent mutants: never call one equivalent.
  Widen the histories or the check until the oracle sees it, and keep going
  until a bug or a design question turns up.
- **Report classes of bugs:** the rule broken, and the measured share of
  generated inputs that break it. Never call one minor.

**Skills.**

- To explore an area of the code (or the whole repository), find where an
  oracle would help, or propose a new one, read
  `node_modules/@tanstack/oracles/skills/oracles-explore/SKILL.md` in full
  and follow it.
- Before you create or change an oracle, or change production code that an
  oracle owns, read `node_modules/@tanstack/oracles/skills/oracles-design/SKILL.md`
  in full and follow it.
- Before you review oracle work, read
  `node_modules/@tanstack/oracles/skills/oracles-review/SKILL.md` in full.
- Before you act on review findings, read
  `node_modules/@tanstack/oracles/skills/oracles-evaluate-review/SKILL.md` in
  full.
- Lint each oracle file and each changed production file after you edit it.
  Fix every report. Do not disable a rule.
- Oracle files: `{test,test-ui,test-browser,test-oracles}/**/*.oracle.test.ts`.
  Routine checks: `npm run test:oracles` (all runtimes), or
  `npm run test:oracles:worker`, `npm run test:oracles:studio`,
  `npm run test:oracles:browser`, and `npm run test:oracles:formatting`.
  The formatting routine runs both complete unmutated passes through the gap
  runner. CI partitions complete files and requires its full aggregate gate.
  Use `npm run test:formatting` for the full mutation audit, required for oracle
  changes, sensitivity evidence, gap closure and replacing prior tests.
  Ordinary Worker/UI commands exclude oracle files.

<!-- END @tanstack/oracles -->
