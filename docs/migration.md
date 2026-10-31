# Studio migration

Land the API/SDK and SPA changes as complete chunks, then tackle ecosystem compatibility, OAuth, and MCP. Keep the public protocol files, public SSR pages, static export, D1 data, R2 objects, and subscription cron behavior intact.

## 1. API and SDK

Keep the existing Studio UI. Put its data access behind authenticated OpenAPI Hono routes, generate a JavaScript/TypeScript SDK with Hey API from the unchanged OpenAPI spec, including cookie auth, and use that SDK for both server-rendered reads and browser writes. Use resource routes with POST for creation, PATCH for partial edits, and PUT for permanent version pins. Remove the replaced routes and migrate all Studio callers in this chunk. Share Zod definitions for request validation, resource responses, and the OpenAPI 3.1 contract. See [the API guide](api.md) for the resulting routes and update rules.

The contract lives in `src/contract/`; `npm run openapi` writes `openapi.json`. The owner can also fetch `{mount}/api/openapi.json`. Generation is pinned and CI checks contract and SDK drift. Tests check API response shapes, SDK uploads/errors, and browser flows. Build output is ignored and rebuilt before development, tests, and deployment. Each pushed `v{version}` tag runs CI and publishes the OpenAPI spec, an installable SDK archive, and a bundled Worker with migrations and generic config. A manifest and checksums record the versions and source commit; CI verifies the extracted downloads before publication.

## 2. SPA — implemented in Studio 0.10.0

The SPA replaces all three legacy Studio modules and their inline scripts with React, TanStack Router, TanStack DB, and Base UI. It keeps the existing themes, spacing, navigation, and mounted Studio URLs. Login/logout, previews, bracket search, editor history, attachments, TK generation, subscriptions, hoppers, signals, mentions, and settings use the production SPA.

Route loaders preload TanStack DB collections through the SDK. Active views poll the D1-backed API every 15 seconds, pause in hidden tabs, and refresh on focus. Reading loads only the current 25-entry page. Writes refresh affected collections. Polling never replaces unsaved editor drafts, and navigation waits for draft saves. Failed reads keep cached data and show a retry. The API sanitizes imported HTML before the browser sees it.

The old SSR Studio, inline scripts, compatibility adapter, and unused read wrappers are removed. Public SSR pages and subscription cron remain. Desktop/mobile browser checks replace retired Studio HTML assertions. Worker tests retain the API, public-output, lifecycle, grammar, and malformed-storage checks. See [test coverage and limits](testing.md).

Migration 0013 adds an index for signal polling order. A local 5,000-record fixture measures the slice query's D1 rows read. Counts and deep offsets can still scan rows. Compose and catalog collections load in batches of 100. This change does not promise constant database cost or resolve concurrent text-edit conflicts.

## 3. Ecosystem compatibility, OAuth, and MCP

Get each separate ecosystem client running against the canonical OpenAPI API, including Burrow and Blygger Desktop. Use the [ecosystem directory](https://blygger.org/ecosystem/) as the discovery list and refresh it when this phase starts. The initial inventory below was checked on 2026-09-30; a listing is not proof of API compatibility.

- Authoring clients: Burrow (locate its canonical repository), [Blygger Desktop](https://github.com/aneeshsathe/blygger-desktop), and [drafts-blyg](https://github.com/miguelito4/drafts-blyg).
- Independent publishers: Blynger, caseyjr-blyg, sachin-blyg, and thinking.drwip.com's client. The directory has no source links for these; locate their code before claiming they run against the API.
- Publishing integrations: [blyg-publisher](https://github.com/brndnpink/blyg-publisher), [hugo-blyg](https://github.com/chrisbodhi/hugo-blyg), and goddinpotty-blyg. The directory links [goddinpotty](https://github.com/mtravers/goddinpotty), but its Blygger fork still needs locating.
- Unclassified: [pioneering-spirit-blyg](https://github.com/patwater/pioneering-spirit-blyg); inspect it to establish its client/API needs.

Track every project in a compatibility matrix: repository and pinned revision, runtime/language, existing backend, operations needed, auth, request/response shapes, errors, pagination, polling, sync/conflicts, and test status. Keep missing source or runtime access explicit as blockers. Refresh the inventory to include new clients rather than treating this snapshot as exhaustive.

For each runnable client, add an API-backed connection or adapter using the generated SDK where supported, or a contract-checked HTTP client for other languages. Publishing tools need an API-backed publishing path while retaining their static output support. Reconcile shared gaps in the OpenAPI Hono routes and regenerate the SDK; avoid separate Worker forks and undocumented endpoints. Land complete, tested integrations in as many PRs as needed.

Acceptance per client: run it against a local Worker with disposable D1/R2 data and record a reproducible command or integration suite. Exercise its supported connect, read/poll, create/edit, publish/withdraw, attachment, and error flows, plus conflicts and AI provenance where applicable. Validate actual requests and responses against the spec, and record unsupported operations explicitly. A source-unavailable client stays blocked, not marked compatible. Keep public protocol interoperability distinct from these authenticated API checks.

Audit [Blygger Desktop](https://github.com/aneeshsathe/blygger-desktop) against our OpenAPI contract before adding OAuth and MCP. Compare its actual Rust API calls and [server extension contracts](https://github.com/aneeshsathe/blygger-desktop/blob/main/docs/SERVER.md), including endpoint paths, request and response shapes, errors, pagination, sync/conflict behavior, and authentication.

Its current requirements include bearer-token owner auth, JSON reads for items and subscriptions, reads for reading/mentions/settings/hoppers, and client-recorded AI provenance. Our read API may overlap, but compatibility must be checked rather than inferred from matching feature names. Reconcile required additions in the canonical OpenAPI Hono routes and regenerate the SDK. Plan how its existing token flow fits the OAuth rollout and preserve disclosure for text generated on the desktop.

Acceptance: run the desktop repository's local Worker integration suite against this Worker checkout and test connect, reads, edits, publish, uploads, conflict handling, and AI provenance. The desktop app must work against our documented API without a separate server fork or undocumented endpoints.

Roll out OAuth for these clients through shared auth middleware and document the token/refresh flow, scopes, and migration from existing credentials. Complete client connection tests against that auth flow. Then add MCP using the same API contract and domain operations. Do not add client-specific extensions, OAuth placeholders, or an MCP server during the first two changes.

## Initial state

The app used Hono on Cloudflare Workers, D1 with 12 migrations, R2 for uploads, and Markdown rendering. Studio was three server-rendered modules with inline JavaScript and direct data-store reads. Public pages and protocol output are separate. TypeScript was strict, with unused-local checks. The baseline suite had 755 tests: 750 passed and five required private deployment configuration. There was no browser suite or CI workflow.

## Mounted API cutover

The private REST contract is now version 2.0.0, with SDK version 0.3.0. REST lives at `{mount}/api`, with no host-root alias on mounted nodes. Set the generated SDK base URL to this complete API URL. Replace old mounted REST credentials or request new consent for the mounted resource. Existing MCP credentials retain their audience. See [client access](client-access.md#mounted-rest-cutover). No database migration is required.
