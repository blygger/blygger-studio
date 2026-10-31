/**
 * User ruling: costly API/MCP work and anonymous registration storage need
 * configurable conservative limits. These are client/operator security policy,
 * not protocol-defined quotas. OWASP recommends admission and resource bounds:
 * https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html
 * Model: an explicit budget of two admits two actions, then refuses before work;
 * concurrent requests cannot overspend it. Owner and delegated API/MCP paths
 * have separate budgets; REST/MCP for one grant share its quota. AI counts actual provider calls, not a UI button or route.
 * Driver: actual OAuth/owner API and shared provider transport with disposable D1.
 * Refinement: statuses and item/client rows or provider-call counters, not time.
 * Limits: fixed windows and concurrency witnesses, not deployed spend/throughput.
 */
import { env } from 'cloudflare:test';
import { expect, it, beforeEach, vi } from 'vitest';
import { flow } from './oauth-flow-driver.ts';
import { complete } from '../src/ai/provider.ts';
import { putSettings } from '../src/model.ts';

beforeEach(async () => {
  // Each admission witness starts with an empty account. This is fixture setup,
  // not a production reset or a bypass within the measured history.
  await env.DB.prepare('DELETE FROM items').run();
  await env.DB.prepare('DELETE FROM oauthClient').run();
  for (const table of ['security_budgets', 'security_registrations']) {
    if (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first()) await env.DB.prepare('DELETE FROM ' + table).run();
  }
});
it('enforces a write budget before creating an extra item', async () => {
  const f = await flow(), bindings = { ...env, API_WRITE_LIMIT: '2' } as typeof env;
  for (let index = 0; index < 3; index++) {
    const response = await f.request('/blyg/api/items', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ contentMd: 'budget ' + index }) }, bindings);
    expect(response.status, 'write admission must stop before extra item work').toBe(index < 2 ? 201 : 429);
  }
  expect((await env.DB.prepare('SELECT id FROM items').all()).results).toHaveLength(2);
});
it('atomic admission cannot overspend a write budget under concurrency', async () => {
  const f = await flow(), bindings = { ...env, API_WRITE_LIMIT: '2' } as typeof env;
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => f.request('/blyg/api/items', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ contentMd: 'concurrent ' + index }) }, bindings)));
  expect(responses.filter(response => response.status === 201), 'concurrent writes share one atomic budget').toHaveLength(2);
  expect(responses.filter(response => response.status === 429)).toHaveLength(4);
});
it('bounds anonymous registration storage before creating another client', async () => {
  const f = await flow(), bindings = { ...env, OAUTH_CLIENT_LIMIT: '2' } as typeof env;
  for (let index = 0; index < 2; index++) {
    const response = await f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'storage ' + index, redirect_uris: [f.redirect], token_endpoint_auth_method: 'none' }) }, bindings);
    expect(response.status, 'registration cannot exceed the stored-client cap').toBe(index === 0 ? 201 : 429);
  }
  expect((await env.DB.prepare('SELECT clientId FROM oauthClient').all()).results).toHaveLength(2);
});
it('the daily AI budget counts provider calls across generation purposes', async () => {
  await putSettings(env.DB, { ai_model_tk: 'claude-opus-5', ai_model_changelog: 'claude-opus-5', ai_model_feed: 'claude-opus-5' });
  const bindings = { ...env, AI_PROVIDER_KEY: 'disposable-fixture-key', AI_DAILY_CALL_LIMIT: '2' } as typeof env;
  let calls = 0;
  const driver = async () => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'claude-opus-5', content: [{ type: 'text', text: 'Fixture output' }] }) }; };
  expect((await complete(bindings, 'system', 'user', driver, 'tk')).text).toBe('Fixture output');
  expect((await complete(bindings, 'system', 'user', driver, 'changelog')).text).toBe('Fixture output');
  await expect(complete(bindings, 'system', 'user', driver, 'feed'), 'AI budget must refuse before the provider call').rejects.toThrow(/budget/i);
  expect(calls).toBe(2);
});

// A quota is a capability budget, not a reason to burn work on refused scope.
// The owner and a verified injected MCP/REST capability share the same account
// budget. The injection skips JWT validation only, never the permission/admission
// machinery or actual create handlers.
it('scope denials do not burn the account write budget', async () => {
  const { Hono } = await import('hono');
  const { createOwnerApi } = await import('../src/owner-api.ts');
  const { createExecutionContext, waitOnExecutionContext } = await import('cloudflare:test');
  const bindings = { ...env, API_WRITE_LIMIT: '2' };
  const readOnly = new Hono().route('/api', createOwnerApi({ scope: ['owner:read'], clientId: 'denied', userId: 'owner' }));
  for (let index = 0; index < 3; index++) {
    const ctx = createExecutionContext();
    const response = await readOnly.fetch(new Request('https://admission.example/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentMd: 'denied' }) }), bindings, ctx);
    await waitOnExecutionContext(ctx); expect(response.status).toBe(403);
  }
  const f = await flow();
  for (let index = 0; index < 2; index++) expect((await f.request('/blyg/api/items', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ contentMd: 'admitted' }) }, bindings)).status).toBe(201);
});
it('concurrent registration claims cannot exceed the client storage cap', async () => {
  const f = await flow(), bindings = { ...env, OAUTH_CLIENT_LIMIT: '2' };
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'parallel ' + index, redirect_uris: [f.redirect], token_endpoint_auth_method: 'none' }) }, bindings)));
  expect(results.filter(response => response.status === 201)).toHaveLength(1);
  expect((await env.DB.prepare('SELECT clientId FROM oauthClient').all()).results).toHaveLength(2);
  expect((await env.DB.prepare('SELECT id FROM security_registrations').all()).results).toHaveLength(0);
});

it('MCP tools consume their grant read budget independently of owner reads', async () => {
  const f = await flow(), bindings = { ...env, API_READ_LIMIT: '2' };
  const minted = await f.request('/blyg/api/authorizations', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'budget MCP', scope: ['owner:read'], resource: 'mcp' }) }, bindings);
  expect(minted.status).toBe(200);
  const { accessToken } = await minted.json() as { accessToken: string };
  expect((await f.request('/blyg/api/settings', { headers: { cookie: f.owner } }, bindings)).status).toBe(200);
  for (let index = 0; index < 3; index++) {
    const response = await f.request('/blyg/studio/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'getSettings' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getSettings', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) }, bindings);
    expect(response.status).toBe(200);
    const value = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
    expect(Boolean(value.result.isError), 'MCP tools cannot evade the grant read budget').toBe(index === 2);
    if (index === 2) expect(value.result.content[0].text).toContain('budget exceeded');
  }
});
it('concurrent AI purposes cannot overspend the daily provider budget', async () => {
  await putSettings(env.DB, { ai_model_tk: 'claude-opus-5' });
  const bindings = { ...env, AI_PROVIDER_KEY: 'disposable-fixture-key', AI_DAILY_CALL_LIMIT: '2' };
  let calls = 0;
  const driver = async () => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'claude-opus-5', content: [{ type: 'text', text: 'Fixture' }] }) }; };
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => complete(bindings, 'system', 'user', driver, 'tk')));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
  expect(calls, 'actual provider work cannot overspend under concurrency').toBe(2);
});

it('a new minute restores admission without erasing earlier writes', async () => {
  const f = await flow(), bindings = { ...env, API_WRITE_LIMIT: '2' };
  const start = Math.floor(Date.now() / 60000) * 60000 + 1000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const write = () => f.request('/blyg/api/items', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ contentMd: 'window neighbor' }) }, bindings);
  try {
    expect((await write()).status).toBe(201); expect((await write()).status).toBe(201); expect((await write()).status).toBe(429);
    clock.mockReturnValue(start + 60000);
    expect((await write()).status, 'new-window admission must reset an exhausted counter').toBe(201);
    expect((await env.DB.prepare('SELECT id FROM items').all()).results).toHaveLength(3);
  } finally { clock.mockRestore(); }
});
it('failed registrations release their storage claims for a valid neighbor', async () => {
  const f = await flow(), bindings = { ...env, OAUTH_CLIENT_LIMIT: '2' };
  const bad = await f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['not a URL'] }) }, bindings);
  expect(bad.status).toBe(400);
  expect((await env.DB.prepare('SELECT id FROM security_registrations').all()).results).toHaveLength(0);
  const good = await f.request(f.issuer + '/oauth2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'neighbor', redirect_uris: [f.redirect], token_endpoint_auth_method: 'none' }) }, bindings);
  expect(good.status).toBe(201);
});
// Tool discovery does not dispatch a REST handler. Its own receiving budget must
// cover that control path before rebuilding request-local MCP handlers.
it('MCP discovery cannot bypass its request work budget', async () => {
  const f = await flow(), bindings = { ...env, MCP_REQUEST_LIMIT: '2' };
  const minted = await f.request('/blyg/api/authorizations', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'discovery budget', scope: ['owner:read'], resource: 'mcp' }) });
  expect(minted.status).toBe(200);
  const { accessToken } = await minted.json() as { accessToken: string };
  for (let index = 0; index < 3; index++) {
    const response = await f.request('/blyg/studio/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) }, bindings);
    expect(response.status, 'MCP control work requires admission too').toBe(index < 2 ? 200 : 429);
  }
});
