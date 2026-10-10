/**
 * MCP exposes only the capabilities a grant permits, and it preserves REST values.
 * Discovery alone cannot prove that a forbidden tool call is denied.
 *
 * Contract: decision #52 selects four independent owner scopes and API/MCP audience
 * separation. MCP authorization requires token audience validation and forbids token
 * passthrough; transport specifies receiving Origin and protocol handling:
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 * RFC8707 §2 explains resource binding; RFC6750 §3 defines scope challenges:
 * https://www.rfc-editor.org/rfc/rfc8707.html#section-2
 * https://www.rfc-editor.org/rfc/rfc6750.html#section-3
 * Model: expectedTools below uses literal contract verbs and scope unions. It imports
 * no production route inventory or scope classifier. Relational checks compare REST
 * and MCP projections while preserving publication and provenance facts.
 * History grammar: all fifteen nonempty scope subsets, create/read/publish, hostile Origin,
 * audience/deadline neighbors and native request/header/version classifications.
 * Driver: official MCP client against makeApp and real provider-issued credentials.
 * Refinement: exact sorted tool inventory, operation challenges, response values and
 * public projections after awaited operations. Cleanup must preserve a primary fault.
 * Limits: bounded capability enumeration does not exhaust arbitrary tool arguments,
 * all clients, browser transport or metadata publication. Host-root discovery remains
 * deferred; mounted interop is a receiving witness, not full standards certification.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { Client, StreamableHTTPClientTransport, type OAuthClientProvider, type OAuthTokens, type OAuthClientInformation, type OAuthDiscoveryState } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { makeApp } from '../src/index.ts';
import { atCheckpoint } from './oracle-campaign.ts';
import { flow } from './oauth-flow-driver.ts';
import { withOracleCleanup } from './oracle-cleanup.ts';

const reads = ['getChanges','listItems','getItem','getSettings','listSubscriptions','getSubscription','listHoppers','getHopper','listSignals','listMentions','search','getVersion','listReading','listImportedReading','getImportedItem','getImportedHistory','getImportedVersion','getUpdateState','getMentionSource','listStaleThreads','getItemFreshness','getForkOptions','listInteractions','listThumbs','getAiModels'];
const drafting = ['createItem','updateItem','deleteItem','restoreItem','uploadMedia','generateItem','draftNote','preview'];
const publishing = ['publishItem','withdrawItem','pinItem','refreshItem','deleteMedia'];
const management = ['updateSettings','createSubscription','updateSubscription','resyncSubscription','pollAllSubscriptions','deleteSubscription','createHopper','updateHopper','deleteHopper','addHopperItem','removeHopperItem','setSignal','deleteSignal','updateMention'];
const readState = ['markRead','markReadBatch','markUnread','markUnreadBatch'];
const all = ['owner:read', 'owner:draft', 'owner:publish', 'owner:manage', 'reading:state'];
// Each explicit scope contributes exactly its named verbs. Union the lists;
// never infer read access from draft/publish/manage. This finite reference owns
// the capability law, independently of the production tool registry.
function expectedTools(scope: string[]) {
  return [...(scope.includes('owner:read') ? reads : []), ...(scope.includes('owner:draft') ? drafting : []), ...(scope.includes('owner:publish') ? publishing : []), ...(scope.includes('owner:manage') ? management : []), ...(scope.includes('reading:state') ? readState : [])].sort();
}
async function driver(mount = '/blyg') {
  const base = 'https://mcp-oracle.example.test', app = makeApp(mount), currentEnv = { ...env, MOUNT: mount };
  const edgeIP = '2001:db8:' + crypto.randomUUID().replaceAll('-', '').match(/.{4}/g)!.slice(0, 6).join(':');
  const log: { path: string; status: number }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), ctx = createExecutionContext();
    request.headers.set('CF-Connecting-IP', edgeIP);
    const response = await app.fetch(request, currentEnv, ctx); await waitOnExecutionContext(ctx);
    log.push({ path: new URL(request.url).pathname, status: response.status }); return response;
  };
  const login = await fetch(base + mount + '/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
  expect(login.status).toBe(302);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const owner = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const manual = async (scope: string[]) => {
    const response = await owner('/api/authorizations', 'POST', { name: 'MCP oracle', scope, resource: 'mcp' });
    expect(response.status).toBe(200); return await response.json() as { access_token: string; authorization: { id: string } };
  };
  const connect = async (token: string) => {
    const client = new Client({ name: 'oracle', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + mount + '/studio/mcp'), { fetch, authProvider: { token: async () => token } }));
    return client;
  };
  return { base, mount, fetch, owner, manual, connect, log, cookie };
}
async function rawMcp(d: Awaited<ReturnType<typeof driver>>, token: string | undefined, method = 'tools/call', params: Record<string, unknown> = { name: 'getSettings', arguments: {} }, headers: Record<string, string> = {}, version = '2026-07-28', omitHeaders: string[] = []) {
  const request = new Request(d.base + d.mount + '/studio/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token === undefined ? {} : { Authorization: 'Bearer ' + token }), 'mcp-protocol-version': version, 'mcp-method': method, ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
  });
  for (const header of omitHeaders) request.headers.delete(header);
  return d.fetch(request);
}
function content(result: unknown) {
  const value = result as { content: { type: string; text?: string }[]; isError?: boolean };
  expect(value.isError, value.content[0]?.text).not.toBe(true);
  return JSON.parse(value.content[0].text!) as Record<string, any>;
}
describe('MCP contract oracles', () => {
  it.each(['', '/blyg', '/nested/blyg'])('discovers mounted OAuth and completes a real tool call at mount %s', async mount => {
    const d = await driver(mount), redirect = 'https://client.example.test/callback';
    let tokens: OAuthTokens | undefined, information: OAuthClientInformation | undefined, verifier = '', redirectURL: URL | undefined, discovery: OAuthDiscoveryState | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: redirect, clientMetadata: { redirect_uris: [redirect], client_name: 'oracle', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: all.join(' ') },
      state: () => 'oracle-state', clientInformation: () => information, saveClientInformation: value => { information = value; },
      tokens: () => tokens, saveTokens: value => { tokens = value; }, codeVerifier: () => verifier, saveCodeVerifier: value => { verifier = value; },
      redirectToAuthorization: url => { redirectURL = url; }, discoveryState: () => discovery, saveDiscoveryState: value => { discovery = value; },
    };
    const transport = new StreamableHTTPClientTransport(new URL(d.base + mount + '/studio/mcp'), { fetch: d.fetch, authProvider: provider });
    const client = new Client({ name: 'oracle', version: '1' });
    await withOracleCleanup(async () => {
      let initialError: unknown;
      try { await client.connect(transport); } catch (error) { initialError = error; }
      expect(redirectURL, initialError instanceof Error ? initialError.message : 'authorization redirect missing').toBeDefined();
      const consent = await d.fetch(redirectURL!, { headers: { cookie: d.cookie } });
      const html = await consent.text(), handle = html.match(/name="handle" value="([^"]+)"/)![1];
      const binding = consent.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
      const response = await d.fetch(d.base + mount + '/studio/auth/consent', { method: 'POST', headers: { cookie: d.cookie + '; ' + binding, Origin: d.base }, body: new URLSearchParams([['handle', handle], ['decision', 'allow'], ...[...html.matchAll(/name="scope" value="([^"]+)"/g)].map(match => ['scope', match[1]])]) });
      expect(response.status, response.status === 302 ? '' : await response.text()).toBe(302);
      const callback = new URL(response.headers.get('location')!);
      expect(callback.searchParams.get('state')).toBe('oracle-state');
      await transport.finishAuth(callback.searchParams); await transport.close();
      await client.connect(new StreamableHTTPClientTransport(new URL(d.base + mount + '/studio/mcp'), { fetch: d.fetch, authProvider: provider }));
      const settings = content(await client.callTool({ name: 'getSettings', arguments: {} }));
      atCheckpoint('MCP OAuth real tool call', () => expect(settings.site_title).toBeDefined());
      atCheckpoint('MCP mounted discovery', () => {
        expect(d.log).toContainEqual({ path: '/.well-known/oauth-authorization-server' + mount + '/studio/auth', status: 404 });
        expect(d.log).toContainEqual({ path: '/.well-known/openid-configuration' + mount + '/studio/auth', status: 404 });
        expect(d.log).toContainEqual({ path: mount + '/studio/auth/.well-known/openid-configuration', status: 200 });
      });
    }, [() => client.close(), () => transport.close()]);
  });
  it('lists exactly the granted tool capabilities for every scope subset', async () => {
    const d = await driver();
    for (let mask = 1; mask < 16; mask++) {
      const scope = all.filter((_, index) => mask & 1 << index), credential = await d.manual(scope), client = await d.connect(credential.access_token);
      await withOracleCleanup(async () => { const observed = (await client.listTools()).tools.map(tool => tool.name).sort(); atCheckpoint('MCP scope capabilities', () => expect(observed).toEqual(expectedTools(scope))); }, [() => client.close()]);
    }
  }, 30_000);
  it('has the same item values and publication/provenance as REST', async () => {
    const d = await driver(), credential = await d.manual(all), client = await d.connect(credential.access_token);
    await withOracleCleanup(async () => {
      const provenance = [{ sources: [], model: 'oracle-agent' }];
      const created = content(await client.callTool({ name: 'createItem', arguments: { body: { content_md: '[TK]write a sentence[=]A generated sentence.[/TK]', provenance } } }));
      const rest = await (await d.owner('/api/items/' + created.id)).json();
      const mcp = content(await client.callTool({ name: 'getItem', arguments: { path: { id: created.id } } }));
      atCheckpoint('MCP REST item equivalence', () => expect(mcp).toEqual(rest));
      atCheckpoint('MCP generation provenance retained', () => expect(mcp.provenance).toEqual(provenance));
      content(await client.callTool({ name: 'publishItem', arguments: { path: { id: created.id } } }));
      const publicItem = await (await d.fetch(d.base + '/blyg/items/' + created.id + '.json')).json() as { generated: unknown; content_md: string };
      atCheckpoint('MCP public generation disclosure', () => { expect(publicItem.generated).toEqual(provenance); expect(publicItem.content_md).toContain('A generated sentence.'); expect(publicItem.content_md).not.toContain('[TK]'); });
      expect((await d.owner('/api/authorizations/' + credential.authorization.id, 'DELETE')).status).toBe(200);
      await expect(client.callTool({ name: 'getSettings', arguments: {} })).rejects.toThrow();
    }, [() => client.close()]);
  });
  it('returns complete MCP operation scope challenges without widening tool inventory', async () => {
    const d = await driver(), credential = await d.manual(['owner:draft']);
    const denied = await rawMcp(d, credential.access_token, 'tools/call', { name: 'publishItem', arguments: { path: { id: 'not-created' } } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(denied.headers.get('www-authenticate')).toContain('scope="owner:publish"');
    expect(denied.headers.get('www-authenticate')).toContain(d.base + d.mount + '/studio/auth/resources/mcp');
    const responseEdit = await rawMcp(d, credential.access_token, 'tools/call', { name: 'updateItem', arguments: { path: { id: 'not-created' }, body: { responses: [] } } });
    expect(responseEdit.status).toBe(403);
    expect(responseEdit.headers.get('www-authenticate')).toContain('scope="owner:draft owner:publish"');
    const highlightEdit = await rawMcp(d, credential.access_token, 'tools/call', { name: 'updateItem', arguments: { path: { id: 'not-created' }, body: { highlight: 'hide' } } });
    expect(highlightEdit.status, 'generated highlighting is a public edit').toBe(403);
    const read = await d.manual(['owner:read']);
    const allowed = await rawMcp(d, read.access_token, 'tools/call', { name: 'getSettings', arguments: {} });
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as any).result.isError).not.toBe(true);
  });
  it('checks Origin and bearer credentials on each independent MCP request', async () => {
    const d = await driver(), credential = await d.manual(['owner:read']);
    expect((await rawMcp(d, credential.access_token)).status).toBe(200);
    expect((await rawMcp(d, credential.access_token, 'tools/call', undefined, { Origin: d.base })).status).toBe(200);
    expect((await rawMcp(d, credential.access_token, 'tools/call', undefined, { Origin: 'https://foreign.example.test' })).status).toBe(403);
    for (const token of [undefined, 'not-a-token', credential.access_token.slice(0, -8) + 'tampered']) {
      const denied = await rawMcp(d, token);
      expect(denied.status).toBe(401);
      expect(denied.headers.get('www-authenticate')).toContain('/studio/auth/resources/mcp');
    }
    const draft = await d.manual(['owner:draft']);
    const overlap = await Promise.all([rawMcp(d, credential.access_token), rawMcp(d, draft.access_token)]);
    expect(overlap.map(response => response.status)).toEqual([200, 403]);
  });
  it('delegates contradictory modern headers and versions to the native SDK', async () => {
    const d = await driver(), credential = await d.manual(['owner:read']);
    expect((await rawMcp(d, credential.access_token)).status).toBe(200);
    for (const headers of [{ 'mcp-method': 'tools/list' }, { 'mcp-name': 'otherTool' }, { 'mcp-name': '%ZZ' }, { 'mcp-protocol-version': '2025-11-25' }] as Record<string, string>[]) {
      const denied = await rawMcp(d, credential.access_token, 'tools/call', undefined, headers);
      expect(denied.status).toBe(400);
      expect((await denied.json() as any).error.code).toBe(-32020);
    }
    for (const header of ['mcp-method', 'mcp-name', 'mcp-protocol-version']) {
      const missing = await rawMcp(d, credential.access_token, 'tools/call', undefined, {}, '2026-07-28', [header]);
      expect(missing.status).toBe(400);
      expect((await missing.json() as any).error.code).toBe(-32020);
    }
    const unsupported = await rawMcp(d, credential.access_token, 'tools/call', undefined, {}, '2099-01-01');
    expect(unsupported.status).toBe(400);
    expect(JSON.stringify(await unsupported.json())).toContain('2026-07-28');
    const unknown = await rawMcp(d, credential.access_token, 'not/a/method', {});
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as any).error.code).toBe(-32601);
    const metadata = await (await d.fetch(d.base + d.mount + '/studio/auth/resources/mcp')).json() as any;
    expect(metadata.resource).toBe(d.base + d.mount + '/studio/mcp');
    expect(metadata.authorization_servers).toEqual([d.base + d.mount + '/studio/auth']);
    expect(metadata.scopes_supported).not.toContain('offline_access');
    const oidc = await (await d.fetch(d.base + d.mount + '/studio/auth/.well-known/openid-configuration')).json() as any;
    expect(oidc.issuer).toBe(d.base + d.mount + '/studio/auth');
    expect(oidc.code_challenge_methods_supported).toEqual(['S256']);
    expect(oidc.authorization_response_iss_parameter_supported).toBe(true);
    const wrongMethod = await d.fetch(d.base + d.mount + '/studio/mcp', { headers: { Authorization: 'Bearer ' + credential.access_token } });
    expect(wrongMethod.status).toBe(405);

  });
  it('checks real OAuth token expiry at T-1/T and rejects the API audience at MCP', async () => {
    for (const resource of ['https://oauth-oracle.example.test/blyg/studio/mcp', 'https://oauth-oracle.example.test/api']) {
      const f = await flow({ authorize: { resource } });
      const approved = await f.decide('browser-a', true);
      expect(approved.status).toBe(302);
      const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
      const exchanged = await f.token(code, { resource }); expect(exchanged.status).toBe(200);
      const token = await exchanged.json() as { access_token: string; expires_in: number };
      expect(token.expires_in).toBe(3600);
      const call = () => f.request('/blyg/studio/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'getSettings' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getSettings', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
      if (resource.endsWith('/api')) { expect((await call()).status).toBe(401); continue; }
      expect((await call()).status).toBe(200);
      // Public signed claims select the clock boundary; no verifier helper supplies the verdict.
      const claims = JSON.parse(atob(token.access_token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as { exp: number };
      const clock = vi.spyOn(Date, 'now').mockReturnValue((claims.exp - 1) * 1000);
      try {
        expect((await call()).status).toBe(200);
        clock.mockReturnValue(claims.exp * 1000);
        const expired = await call(); expect(expired.status).toBe(401);
        expect(expired.headers.get('www-authenticate')).toContain('/studio/auth/resources/mcp');
      } finally { clock.mockRestore(); }
    }
  });
  it('handles notifications and rejects batched or response bodies through native HTTP classification', async () => {
    const d = await driver(), credential = await d.manual(['owner:read']);
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    const send = (body: unknown) => d.fetch(d.base + d.mount + '/studio/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + credential.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28' }, body: JSON.stringify(body) });
    const notification = await send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'unrelated', _meta: meta } });
    expect(notification.status).toBe(202); expect(await notification.text()).toBe('');
    for (const body of [[{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }], { jsonrpc: '2.0', id: 1, result: {} }]) {
      expect((await send(body)).status).toBe(400);
    }
  });
  it('rejects a wrong capability list in the checker', () => {
    expect(() => expect([...expectedTools(['owner:draft']), 'publishItem']).toEqual(expectedTools(['owner:draft']))).toThrow();
  });
});
