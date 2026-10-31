# Blygger SDK

JavaScript and TypeScript client for the private Studio API, generated with
Hey API. It runs in browsers, Node.js 22+, and Cloudflare Workers using native
Fetch, File, and Blob APIs. No Node stream shim or framework is required.

Download `blygger-sdk-SDK_VERSION.tgz` from a
[Studio release](https://github.com/blygger/blygger-studio/releases), check its
digest against `SHA256SUMS`, and install it with
`npm install ./blygger-sdk-SDK_VERSION.tgz`. Choose the SDK shipped with your
Worker release; `release.json` records both versions. Downloads are on GitHub,
not the npm registry.

## Browser use

Sign into `{mount}/studio` first. Create a client for its full `{mount}/api` URL; the browser sends
its HttpOnly session cookie automatically. The SDK does not create a login
session. Delegated apps use resource-bound bearer tokens or OAuth.

```js
import { BlyggerApi, createBlyggerClient, unwrap } from "@blygger/sdk";

const client = createBlyggerClient({ baseUrl: new URL("/blyg/api", window.location.origin).href });
const draft = await unwrap(BlyggerApi.createItem({
  client, body: { content_md: "Hello", kind: "fragment" },
}));
await unwrap(BlyggerApi.publishItem({ client, path: { id: draft.id }, body: { expectedRevision: draft.revision } }));
const reading = await unwrap(BlyggerApi.listReading({ client, query: { offset: 0, limit: 25 } }));
```

## Node and Worker use

Create a separate client for each server request or owner so credentials stay
isolated. Node Fetch does not manage browser sessions: supply an existing owner
session cookie in `headers`. To use `auth` for an owner session, supply a callback that returns the raw cookie value only when `scheme.in === "cookie"`; a plain string now also configures Bearer authentication. A custom `fetch` transport is also supported.
Never embed server credentials in browser code.

```js
import { BlyggerApi, createBlyggerClient } from "@blygger/sdk";

const client = createBlyggerClient({
  baseUrl: "https://blyg.example.com/api",
  headers: { Cookie: ownerSessionCookie }, // received through your login/session flow
});
const { data, error, response } = await BlyggerApi.listReading({ client });
if (error) throw new Error(`Reading failed: ${response?.status}`);
```

Upload with `body: { file: new File([...], "image.png", { type: "image/png" }) }`.
Node callers can use a Blob from `node:fs`'s `openAsBlob()` with native FormData
handling. Filesystem streams are not accepted. Requests take a standard `signal`
for cancellation. Ordinary API calls do not retry automatically.

## Conditional item writes

Creation returns the first private `revision`. Every item command carries
`body.expectedRevision` from the snapshot it changes. Successful commands return
the resulting revision. Attached media uploads and deletes use the owning item’s
revision too. Unattached media operations have no item revision.

A stale command returns HTTP409 with `code: "revision-conflict"`. Reload and let
the owner reconcile their changes. Do not fetch a new revision to retry old text
silently. A publication version, content hash, and HTTP validator are separate
values and cannot replace the item revision. A lost mutation response does not
make a blind retry safe.

## Results and errors

Generated methods return typed `{ data, error, request, response }` fields.
`response.status` exposes HTTP status when a response exists; network failures
can have no response. `unwrap()` is an optional throwing interface: it returns
successful data, throws `BlyggerApiError` with `statusCode` and `body` for HTTP
failures, and preserves network/abort errors.

## Generation

Edit `src/contract/` at the repository root, then run `npm run sdk:generate` with
Node 22.18+. The exact generator version is pinned in the root package and
lockfile and recorded in `generation.json`. Generation reads the checked-in
`openapi.json` without overlays, auth removal, or generated-file patches. CI
checks drift.

`npm run build` bundles the package and declarations for browser and server
JavaScript. `npm pack ./sdk` creates the installable archive.

## Generated schemas

The same OpenAPI input also generates Zod 4 validators. Import them from the
SDK's schema export when you need runtime validation or TanStack DB row types:

```js
import { zItem } from '@blygger/sdk/schemas';

const item = zItem.parse(data);
```

Reusable definitions use names such as `zItem` and `zSubscription`. Endpoint
schemas include `zGetItemResponse` and `zListItemsResponse`. Generate these
files through `npm run sdk:generate`; do not edit them by hand. CI checks drift.
The schema export uses the SDK's Zod dependency, while the existing HTTP client
bundles remain self-contained.

## Bearer tokens

Create a resource-bound token in Studio's access page. For REST, select the API resource and the scopes your tool needs. Tokens work in browsers and Node:

```js
const client = createBlyggerClient({
  baseUrl: 'https://example.com/blyg/api',
  auth: scheme => scheme.scheme === 'bearer' ? accessToken : undefined,
});
```

Browser bearer requests support CORS. Tokens expire and can be revoked; load them from your credential store. See [client access](https://github.com/blygger/blygger-studio/blob/main/docs/client-access.md) for scopes, revocation and the OAuth/MCP implementation status.

The base URL includes the API path. Use `/api` on root nodes and the advertised `{mount}/api` on mounted nodes. OpenAPI operation paths are relative to that base. Old host-root REST credentials on mounted nodes require replacement or new consent; refresh cannot retarget them. MCP credentials keep their audience.
