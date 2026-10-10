# Client access

This branch adds owner-approved OAuth grants and manual tokens. Studio keeps its owner login. The owner password belongs only on the Studio login page; client tools use bearer tokens.

## Manual tokens

Open **More → Client access** in Studio. Enter a client name, choose REST API or MCP, select its permissions, and create a token. Copy the token from the dialog before closing it. It expires after 30 days and has no refresh token. Mint a replacement when needed.

The REST API remains at `/api`. MCP is at `{mount}/studio/mcp`, such as `https://example.com/blyg/studio/mcp`. A token is bound to the selected resource: an MCP token cannot call REST, and a REST token cannot connect to MCP.

| Scope | Allows |
| --- | --- |
| `owner:read` | Private reads: drafts, reading material, media, settings, and history |
| `owner:draft` | Creating, editing, restoring and deleting drafts, media uploads, preview, and configured AI generation |
| `owner:publish` | Publication, withdrawal, refresh, permanent pins, public response display, and media deletion |
| `owner:manage` | Settings, subscriptions, signals, collections and response moderation, including their public effects |
| `reading:state` | Marking reading entries read or unread (read state is private, reversible bookkeeping) |

Scopes do not imply each other. Choose each permission the client needs. Uploading media attached to an item that has been published requires both drafting and publishing permission, including after withdrawal. Draft-only clients can upload unattached media or attach it to a never-published draft. Editing an item's `responses` field requires both drafting and publishing permission because the public page changes immediately. Choosing the avatar (`avatar_media_id`) requires both managing and publishing permission for the same reason.

## JavaScript clients

Use the release SDK in browsers and Node.js. Configure the generated client's native Bearer scheme:

```js
import { BlyggerApi, createBlyggerClient, unwrap } from '@blygger/sdk';

const client = createBlyggerClient({
  baseUrl: 'https://example.com',
  auth: scheme => scheme.scheme === 'bearer' ? accessToken : undefined,
});
const items = await unwrap(BlyggerApi.listItems({ client }));
```

Load `accessToken` from the client's credential store. Do not put it in browser source or a URL. Browser bearer requests support CORS. Owner-cookie requests remain same-origin; Studio does not expose credential-management operations to bearer clients.

A Studio browser uses its HttpOnly cookie through `credentials: 'same-origin'` without an `auth` option. A Node owner client can pass its complete session cookie in `headers.Cookie`. A plain `auth` string is unsuitable for owner sessions now that the contract has both cookie and Bearer schemes.

## Revocation and password reset

Studio lists each grant, its permissions, resource and expiry. Revoke one authorization to disable its access and refresh credentials, or choose revoke-all. Revoke-all leaves your Studio session active. Revoking one OAuth grant also removes remembered consent for that client. Existing sibling access grants remain valid; a new grant requires a fresh owner decision.

Changing `OWNER_PASSWORD` invalidates existing Studio sessions and preserves delegated access and refresh credentials. Existing permissions and grant deadlines stay unchanged. Log in again and open **More → Client access** to review the surviving grants. Choose revoke-all when you want to remove their access. Changing `COOKIE_SECRET` invalidates both owner sessions and delegated grants. Set secrets through Wrangler's interactive prompts; do not place them in committed config.

## OAuth and MCP status

OAuth uses S256 PKCE, explicit owner consent, one-hour access tokens and rotating refresh credentials. Grants end no later than 30 days after the owner session began. Resource metadata, login, consent, registration, tokens and MCP are under the Studio mount.

Authorization requests that omit `resource` default to `{mount}/studio/mcp`. The login continuation and consent page include that resource, and the resulting access and refresh credentials cannot gain REST API access. REST OAuth clients must request `resource=https://example.com/api` explicitly. Token requests may omit `resource` to retain the audience approved at authorization.

Better Auth and its OAuth Provider supply native OIDC discovery at `{mount}/studio/auth/.well-known/openid-configuration`. The official MCP client has completed discovery, owner consent and tool calls through the Worker at root, `/blyg` and `/nested/blyg` mounts. Protected-resource challenges point to mounted metadata at `{mount}/studio/auth/resources/mcp`. No host-root discovery route is exposed.

This mount-only profile does not meet RFC 9728's host-root protected-resource metadata publication rule. The explicit challenge works with the tested client; that result does not establish full RFC 9728 conformance or compatibility with every client. See [the source survey](auth-security-survey.md) and [the protocol boundaries](oauth-implementation-hardening.md).

MCP uses the same REST handlers and Zod definitions. Tools require the operation's permissions; a denied call returns an HTTP 403 scope challenge. The tool list shows permitted operations. `uploadMedia` accepts `body.file` with `filename`, `contentType` and `dataBase64`, plus the REST metadata fields. Its adapter sends a multipart request to the REST handler. The same image types and 5 MiB raw-file limit apply; the encoded MCP request must fit within 8 MiB.

For generated text, clients submit `provenance` with one entry per TK scope, using `null` for scopes with no claim. Each claim has `sources: [{ id, version }]`, and optional `model` and `at`. The claim is client-asserted. Publication strips TK authoring syntax and emits the provenance in the public item. See [the oracle coverage record](auth-oracles.md) for verified behavior and open boundaries.

### Cloudflare MCP Portals

Enter the full MCP URL, such as `https://example.com/blyg/studio/mcp`. For manual OAuth credentials, register the callback displayed by Cloudflare, currently `https://oauth-callbacks.cloudflareaccess.com/cdn-cgi/access/outbound-oauth-callback`, through `{mount}/studio/auth/oauth2/register`. Request `client_secret_basic`, `authorization_code` and `refresh_token`, and the scopes you need. Use the returned client ID and secret in the portal.

If discovery fails, enter `{mount}/studio/auth/oauth2/authorize` and `{mount}/studio/auth/oauth2/token` as the authorization and token endpoints. The issuer is `{mount}/studio/auth`; the optional revocation endpoint is `{mount}/studio/auth/oauth2/revoke`. These are absolute URLs on the blyg's host. Do not replace the MCP URL with the site homepage or issuer URL.

Cloudflare supports manual endpoint configuration and Streamable HTTP. Local tests cover the report's registration fields, omitted resource indicators, Basic token exchange, refresh and MCP calls at root and nested mounts. They also cover the 2025 Streamable HTTP handshakes. These checks do not establish successful registration in a live portal. See [the issue 54 investigation](issue-54-cloudflare-mcp.md) and [Cloudflare's setup guide](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/).

CI also runs pinned MCP Inspector and selected OpenID Foundation checks against disposable root and mounted Workers. See [external OAuth checks](oauth-interop.md) for their coverage, the original-bug comparison and the corrected browser-fixture finding.

## Installation

Apply D1 migrations `0021_oauth.sql` and `0022_security_budgets.sql` and enable `nodejs_compat` before deploying this branch. Source installs use `npm run upgrade`; Worker archives use the release's D1 migration instructions. OAuth records use the existing DB binding, so no KV namespace or new deployment secret is needed.

Resetting the owner password or cookie secret also invalidates owner login cookies. Log in again after either change. Rate limits use shared D1 counters and the Cloudflare client address; see [deployment boundaries](auth-deployment-hardening.md) for the ingress and rollout checks.

## Upgrade compatibility

Upgrading to 0.28.0 invalidates owner cookies from earlier releases. Log in again in Studio and refresh the cookies used by owner tools. SDK 0.2.0 changes owner credential configuration: replace a plain `auth` session string with `headers.Cookie` in Node.js or the cookie scheme callback shown in the SDK README. Browser Studio sessions use their HttpOnly cookie without an `auth` option.

Protected Studio and API routes refuse plain HTTP outside loopback. For LAN testing from a phone, use an HTTPS tunnel or an HTTPS development proxy. Configure HTTPS at the ingress before deploying; the Worker refuses cleartext auth requests rather than redirecting credentials that have already arrived over HTTP.
