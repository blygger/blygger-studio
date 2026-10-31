/**
 * A mounted issuer must remain usable when host-root discovery is absent.
 * Metadata alone cannot show that an independent client can complete authorization.
 *
 * Contract: mounted OIDC discovery, PKCE code flow and explicit resource metadata.
 * OIDC Discovery §4 defines issuer-relative configuration retrieval:
 * https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfig
 * RFC9728 §5.1 defines challenge-linked resource metadata, while §3 separately
 * requires well-known publication. This suite does not waive that requirement:
 * https://www.rfc-editor.org/rfc/rfc9728.html#section-5.1
 * https://www.rfc-editor.org/rfc/rfc9728.html#section-3
 * Model: literal mounted paths, owner identity, resource and granted tool subset.
 * History grammar: root, one-level and nested mounts; native consent, exchange,
 * refresh, client disable and observed discovery fallback attempts.
 * Driver: createBetterAuthDriver's provider integration fixture, D1 and the official
 * MCP OAuth client. This is not the complete production forwarding surface; its
 * owner-session and introspection helpers are fixture-specific integration seams.
 * Refinement: endpoint origins, verified claims, real MCP results, inactive
 * introspection and the recorded404/200 discovery sequence.
 * Limits: one official client is an interoperability witness, not all clients.
 * Host-root publication is deferred; production coverage lives in mcp.oracle.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport, auth, type OAuthClientProvider, type OAuthTokens, type OAuthClientInformation, type OAuthDiscoveryState } from '@modelcontextprotocol/client';
import { createBetterAuthDriver } from './better-auth-driver.ts';
import { withOracleCleanup } from './oracle-cleanup.ts';

describe('Better Auth mounted OIDC receiving oracle', () => {
  it.each(['', '/blyg', '/nested/blyg'])('discovers and issues verifiable owner credentials at %s', async mount => {
    const d = await createBetterAuthDriver(mount), issuer = d.base + mount + '/studio/auth';
    const response = await d.fetch(issuer + '/.well-known/openid-configuration');
    expect(response.status).toBe(200);
    const metadata = await response.json() as Record<string, any>;
    expect(metadata.issuer).toBe(issuer);
    expect(metadata.subject_types_supported).toContain('public');
    expect(metadata.id_token_signing_alg_values_supported).toContain('RS256');
    expect(metadata.code_challenge_methods_supported).toContain('S256');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'jwks_uri']) {
      expect(metadata[key]).toMatch(new RegExp('^' + issuer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'));
    }
    expect((await d.fetch(issuer + '/owner-session', { method: 'POST', headers: { Origin: d.base } })).status).toBe(401);
    expect((await d.fetch(issuer + '/owner-session', { method: 'POST', headers: { cookie: d.ownerCookie, Origin: 'https://evil.example' } })).status).toBe(403);
    const session = await d.fetch(issuer + '/owner-session', { method: 'POST', headers: { cookie: d.ownerCookie, Origin: d.base } });
    expect(session.status).toBe(200);
    const cookie = session.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    expect(cookie).not.toBe('');
    let tokens: OAuthTokens | undefined, client: OAuthClientInformation | undefined, verifier = '', redirect: URL | undefined, discovery: OAuthDiscoveryState | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: 'https://client.example/callback', clientMetadata: { redirect_uris: ['https://client.example/callback'], client_name: 'mounted oracle', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access owner:read' },
      state: () => 'oracle-state', clientInformation: () => client, saveClientInformation: value => { client = value; },
      tokens: () => tokens, saveTokens: value => { tokens = value; }, codeVerifier: () => verifier, saveCodeVerifier: value => { verifier = value; },
      redirectToAuthorization: value => { redirect = value; }, discoveryState: () => discovery, saveDiscoveryState: value => { discovery = value; },
    };
    const options = { serverUrl: d.resource, resourceMetadataUrl: new URL(issuer + '/resources/mcp'), fetchFn: d.fetch, scope: 'openid offline_access owner:read' };
    expect(await auth(provider, options)).toBe('REDIRECT');
    expect(redirect).toBeDefined();
    const consent = await d.fetch(redirect!, { headers: { cookie } });
    expect(consent.status).toBe(302);
    const consentURL = new URL(consent.headers.get('location')!, d.base);
    expect(consentURL.pathname).toBe(mount + '/studio/consent');
    const accepted = await d.fetch(issuer + '/oauth2/consent', { method: 'POST', headers: { cookie, Origin: d.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ accept: true, oauth_query: consentURL.search.slice(1) }) });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const callback = new URL((await accepted.json() as { url: string }).url);
    expect(callback.searchParams.get('state')).toBe('oracle-state');
    expect(await auth(provider, { ...options, authorizationCode: callback.searchParams.get('code')!, iss: callback.searchParams.get('iss')! })).toBe('AUTHORIZED');
    expect(tokens?.access_token).toBeTruthy();
    expect(tokens?.refresh_token).toBeTruthy();
    const idToken = (tokens as OAuthTokens & { id_token: string }).id_token;
    const claims = await d.verifyIdToken(idToken);
    expect(claims.iss).toBe(issuer); expect(claims.aud).toBe(client!.client_id); expect(claims.sub).toBe('owner');
    const access = await d.verifyAccess(tokens!.access_token);
    await expect(d.verifyAccess(tokens!.access_token, 'https://wrong-resource.example')).rejects.toThrow();
    const tampered = idToken.split('.');
    tampered[2] = (tampered[2][0] === 'A' ? 'B' : 'A') + tampered[2].slice(1);
    await expect(d.verifyIdToken(tampered.join('.'))).rejects.toThrow();
    expect(access).toMatchObject({ sub: 'owner', scope: expect.stringContaining('owner:read') });
    expect(Array.isArray(access.aud) ? access.aud : [access.aud]).toContain(d.resource);
    expect(await (await d.introspect(tokens!.access_token, cookie)).json()).toMatchObject({ active: true });
    const mcp = new Client({ name: 'mounted oracle', version: '1' });
    await withOracleCleanup(async () => {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(d.resource), { fetch: d.fetch, authProvider: provider }));
      const names = (await mcp.listTools()).tools.map(tool => tool.name);
      expect(names).toContain('getSettings'); expect(names).not.toContain('createItem'); expect(names).not.toContain('publishItem');
      const result = await mcp.callTool({ name: 'getSettings', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0].text).siteTitle).toBeDefined();
    }, [() => mcp.close()]);
    const post = (endpoint: string, fields: Record<string, string>) => d.fetch(issuer + endpoint, { method: 'POST', body: new URLSearchParams(fields) });
    const refresh = await post('/oauth2/token', { grant_type: 'refresh_token', client_id: client!.client_id, refresh_token: tokens!.refresh_token!, resource: d.resource });
    expect(refresh.status, await refresh.clone().text()).toBe(200);
    const renewed = await refresh.json() as { access_token: string; refresh_token: string };
    expect(renewed.refresh_token).toBeTruthy();
    expect(renewed.refresh_token).not.toBe(tokens!.refresh_token);
    const live = await d.introspect(renewed.access_token, cookie);
    expect(live.status, await live.clone().text()).toBe(200);
    expect(await live.json()).toMatchObject({ active: true, sub: 'owner' });
    const revoked = await post('/oauth2/revoke', { client_id: client!.client_id, token: renewed.refresh_token, token_type_hint: 'refresh_token' });
    expect(revoked.status).toBe(200);
    // Refresh revocation is separate from owner revocation of the entire client.
    await d.disableClient(client!.client_id, cookie);
    const dead = await d.introspect(renewed.access_token, cookie);
    expect(dead.status).toBe(200);
    expect(await dead.json()).toMatchObject({ active: false });
    expect((await d.fetch(d.resource, { method: 'POST', headers: { Authorization: 'Bearer ' + renewed.access_token } })).status).toBe(401);
    const deniedRefresh = await post('/oauth2/token', { grant_type: 'refresh_token', client_id: client!.client_id, refresh_token: renewed.refresh_token, resource: d.resource });
    expect(deniedRefresh.status).toBe(400);
    expect(d.log).toContainEqual({ path: '/.well-known/oauth-authorization-server' + mount + '/studio/auth', status: 404 });
    expect(d.log).toContainEqual({ path: '/.well-known/openid-configuration' + mount + '/studio/auth', status: 404 });
    expect(d.log).toContainEqual({ path: mount + '/studio/auth/.well-known/openid-configuration', status: 200 });
  });
});
