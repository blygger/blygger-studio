# External OAuth checks

CI runs a separate `oauth-interop` job against disposable HTTPS Workers at root
and `/nested/blyg` mounts. It uses MCP Inspector 2.10.1 and OpenID Foundation
conformance suite 5.3.2. The Inspector package version and container digests are
pinned. The job uses dummy accounts, fresh D1/R2 storage and no production
credentials. Worker outbound requests cannot reach live services.

## What CI checks

`npm run test:oauth:interop` runs eight cases:

- Inspector discovers each mounted issuer, registers a client, completes real
  browser login and consent, and lists tools using the modern protocol.
- Inspector reuses that OAuth grant for a legacy Streamable HTTP settings call.
- Generic confidential clients use Basic and POST client authentication. They
  omit `resource` during authorization, code exchange and refresh. Consent must
  name MCP, tokens must work at MCP, REST must reject them, and refresh must
  reject an attempt to add the REST audience.

`npm run test:oauth:conformance` runs four official modules:

- `oidcc-discovery-endpoint-verification` at both mounts.
- `oidcc-ensure-request-with-valid-pkce-succeeds` at both mounts, with
  `client_secret_basic` and `openid owner:read`. The official module constructs
  authorization, code exchange and token-validation requests. It omits `resource`.

The job saves sanitized results in `build/oauth-interop-results.json` and
`build/oidc-conformance-results.json`. It uploads those files as CI evidence and
removes its Docker stack even after a failure.

These are selected interoperability checks, not full Basic/Dynamic OP
certification. The older Basic OP happy flow omits PKCE and fails on both
revisions because this server requires PKCE. Full certification, public TLS,
Cloudflare portal registration and the deferred RFC 9728 host-root publication
rule remain outside this job.

## Would these checks have found issue 54?

Yes, the official PKCE module catches the missing-resource failure. With the
upstream OAuth route from `d06f221`, it fails at
`CheckTokenEndpointHttpStatus200`: expected 200, received 400 `invalid_grant`.
It passes with the default-resource fix. Registration and authorization must
use the same issuer hostname, including in a local test.

Inspector alone would not catch that failure. Its standard OAuth flow sends
`resource` explicitly, and the same Inspector flow succeeds on upstream. The
generic no-resource cases retain the scenario that the portal report exposed.

## Corrected browser finding

The first ad hoc run reported a JSON redirect as a product defect. That verdict
was wrong. Its Miniflare proxy changed browser `Sec-Fetch-Mode: navigate` to
`cors`, which caused the provider to treat navigation as a fetch request.
The corrected browser checks show ordinary consent on both upstream and the PR,
with `prompt` omitted and with `prompt=consent`. No production redirect change
was necessary.

The reusable fixture forwards navigation through Miniflare's documented
`MF-Sec-Fetch-Mode` bridge. A test-only wrapper reports the value received by the
Worker, and the proxy checks that it matches the original browser value. The
confidential client's backchannel uses a separate cookie jar from the owner
browser. Each browser has a distinct fixture edge address, so independent tests
retain real rate limits without exhausting one shared login budget.

## Run locally

Install the pinned Inspector in its isolated directory:

```sh
npm install --prefix build/oauth-inspector --no-audit --no-fund @modelcontextprotocol/inspector@2.10.1
npx playwright install chromium
npm run test:oauth:interop
```

Use Node 24.5.0, OpenSSL and a terminal on macOS. Inspector's interactive flow
uses a PTY without opening the host browser. The runner supplies its own browser
and temporary callback port. Linux CI supplies the PTY with `script`.

Run the selected OpenID checks with Docker:

```sh
docker compose -p oauth-conformance -f scripts/oauth-conformance.compose.yml up -d
npm run test:oauth:conformance
docker compose -p oauth-conformance -f scripts/oauth-conformance.compose.yml down
```

The suite publishes port 8443 on loopback. Its development-mode certificate and
the Worker's temporary certificate establish local HTTPS behavior only. They
do not test a production certificate chain.
