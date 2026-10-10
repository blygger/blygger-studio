# Issue 54: Cloudflare MCP Portal investigation

The report's manual registration fields work locally. A subsequent authorization
flow that omits `resource` failed on upstream revision `d06f221`: owner consent
succeeded, but the token endpoint returned HTTP 400 `invalid_grant`. The fix
defaults an omitted authorization resource to the mounted MCP URL before login
and consent. This is a confirmed server defect and a possible cause of the
portal error; the actual portal request trace remains unavailable.

Report: [issue 54 and maintainer comment](https://github.com/blygger/blygger-studio/issues/54#issuecomment-6091676802).
Investigation date: October 10, 2026.

## Reproduction and fix

`test/mcp.oracle.test.ts` registers a confidential client with the exact callback,
grant types, scopes and `client_secret_basic` method in the report. It completes
S256 authorization and owner consent, then exchanges the code with HTTP Basic
credentials. Neither authorization nor token requests send `resource`.
Before the fix, the three root/mounted cases failed at code exchange with HTTP
400 `invalid_grant`. The provider issued a credential without the MCP or API
audience, and the owner's token-response checks rejected it.

`clientRegistrationDefaultResources` permits client access to registered resources;
it does not select an audience for an authorization request that omits `resource`.
The new default selects MCP alone. The owner sees that URL at consent, the signed
code carries it, and refresh retains it. Explicit resource requests still go
through provider validation. No token-exchange fallback adds audiences to an
existing grant. [RFC 8707 section 2.1](https://www.rfc-editor.org/rfc/rfc8707.html#section-2.1)
allows a predefined default when authorization omits the resource parameter.

The regression checks cover login continuation, consent display, token exchange,
a real MCP settings read, refresh rotation, API rejection and rejection of a
refresh request that tries to add the API audience. Existing tests cover explicit
API authorization and malformed/foreign resources.

## Transport, discovery and registration

| Boundary | Evidence |
| --- | --- |
| Transport | Local initialize → initialized → tools/list → getSettings sequences pass for `2025-03-26`, `2025-06-18` and `2025-11-25`. Existing modern client tests also pass. |
| Protected resource | Public GET and unauthenticated initialize POST at `https://blyg.suryakasturi.com/studio/mcp` returned 401 with `resource_metadata="https://blyg.suryakasturi.com/studio/auth/resources/mcp"`. That metadata returned 200 and named the correct MCP resource and issuer. |
| Authorization metadata | Both mounted `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server` under `/studio/auth` returned 200 on the reported host and advertised its authorize, token and register endpoints, S256 and Basic authentication. |
| Registration | The report's confidential registration payload returned 201 locally at root, `/blyg` and `/nested/blyg` mounts. No client was registered on the live host during this investigation. |
| Host-root discovery | No new host-root routes are required by this fix. Existing mounted client discovery tests remain unchanged. |

[Cloudflare's portal guide](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
documents Streamable HTTP upstream support, manual OAuth endpoints and Basic
authentication. It requires the full MCP URL and uses the report's shared
callback for manual credentials. This documented manual flow provides a route
around host-root discovery; it does not prove Cloudflare follows our mounted
challenge during automatic discovery. The existing RFC 9728 publication limit
in [client access](client-access.md) remains.

## Remaining live check

Retry with the fix deployed and the full server URL
`https://blyg.suryakasturi.com/studio/mcp`. Use manual OAuth credentials and the
mounted endpoints listed in [client access](client-access.md#cloudflare-mcp-portals).
If registration still fails, capture the exact URL and Cloudflare's `status_code`,
`mcp_code`, `is_upstream` and `cause`, or a sanitized Worker request trace.
That distinguishes discovery, Origin rejection, callback, token exchange and
transport errors. An authenticated portal registration was not run here, so
the issue should stay open until that receiving check succeeds.

## Validation

The final local run passed 351 tests across 17 files covering MCP, OAuth,
authorization, consent, token headers and mount routing. `npm run typecheck`
and `git diff --check` passed. Tests ran with Node 24.5.0 and local Worker/D1
fixtures; no Cloudflare account credentials or live OAuth grants were used.

External follow-up passed eight Inspector/generic browser cases and four
selected OpenID Foundation discovery/PKCE modules. The official PKCE module
failed at token exchange on the upstream OAuth route and passed with this fix.
Inspector alone passed on upstream because it sends `resource` explicitly.
These checks now run in a separate CI job. See [external OAuth checks](oauth-interop.md)
for the exact scope and the corrected browser-proxy finding.
