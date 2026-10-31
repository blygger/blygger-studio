import { testItemRevision } from './helpers.ts';
/**
 * Owner ruling: delegated grants have separate quotas and an aggregate ceiling;
 * owner capacity is reserved. OWASP DoS guidance requires bounded costly work:
 * https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html
 * Model: two grants are distinct principals. Exhausting one cannot spend another
 * grant's quota or the owner's quota. Delegated aggregate admission still bounds
 * fan-out across many grants. AI retains a total ceiling with an owner reserve.
 * Driver: real manual credentials, real REST and D1. Explicit low fixture limits
 * make statuses, not elapsed time, the refinement checkpoint. No quota helper
 * computes expectations. Limits: fixed-window histories, not load/latency proof.
 */
import { env } from 'cloudflare:test';
import { expect, it, beforeEach, vi } from 'vitest';
import { flow } from './oauth-flow-driver.ts';
beforeEach(async () => { await env.DB.prepare('DELETE FROM security_budgets').run(); });
async function fixture() {
  const f = await flow();
  const tokens: string[] = [];
  for (const name of ['delegated A', 'delegated B']) {
    const minted = await f.request('/blyg/api/authorizations', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, scope: ['owner:read'], resource: 'api' }) });
    expect(minted.status).toBe(200); tokens.push((await minted.json() as {accessToken:string}).accessToken);
  }
  return { ...f, tokens };
}
it('delegated aggregate exhaustion leaves the owner capacity available', async () => {
  const f = await fixture(), bindings = { ...env, API_READ_LIMIT: '2', API_DELEGATED_READ_LIMIT: '2' };
  for (let i=0;i<3;i++) expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + f.tokens[0] } }, bindings)).status).toBe(i<2?200:429);
  expect((await f.request('/blyg/api/settings', { headers: { cookie: f.owner } }, bindings)).status, 'a delegated grant cannot spend reserved owner capacity').toBe(200);
  expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + f.tokens[1] } }, bindings)).status, 'multiple grants cannot evade the delegated aggregate ceiling').toBe(429);
});
it('each grant has its own quota within the delegated aggregate ceiling', async () => {
  const f = await fixture(), bindings = { ...env, API_READ_LIMIT: '2', API_DELEGATED_READ_LIMIT: '4' };
  for (const token of f.tokens) {
    for (let i=0;i<3;i++) expect((await f.request('/blyg/api/settings', { headers: { Authorization: 'Bearer ' + token } }, bindings)).status, 'one grant must not spend another grant quota').toBe(i<2?200:429);
  }
  expect((await f.request('/blyg/api/settings', { headers: { cookie: f.owner } }, bindings)).status).toBe(200);
});

// Provider seam: authority is fixed by the driver at the same request-local
// boundary the REST guard uses. JWT verification is covered by the native-flow
// witnesses above. Count actual transport calls, including owner/background use.
it('delegated AI cannot spend the owner reserve or exceed the total cost ceiling', async () => {
  const { complete } = await import('../src/ai/provider.ts');
  const { withWorkPrincipal } = await import('../src/security-budgets.ts');
  const { putSettings } = await import('../src/model.ts');
  await putSettings(env.DB, { ai_model_tk: 'claude-opus-5' });
  const bindings = { ...env, AI_PROVIDER_KEY: 'disposable-provider-fixture', AI_DAILY_CALL_LIMIT: '4', AI_OWNER_RESERVED_CALLS: '2', AI_GRANT_DAILY_CALL_LIMIT: '4' };
  const delegated = withWorkPrincipal(bindings, {scope:['owner:draft'],clientId:'ai-client',grantId:'ai-grant',userId:'owner'});
  let calls = 0;
  const transport = async () => { calls++; return {ok:true,status:200,text:async()=>JSON.stringify({model:'claude-opus-5',content:[{type:'text',text:'Fixture'}]})}; };
  for (let i=0;i<2;i++) await complete(delegated,'system','user',transport,'tk');
  await expect(complete(delegated,'system','user',transport,'tk'),'delegated AI cannot consume reserved owner work').rejects.toThrow(/budget/i);
  expect(calls).toBe(2);
  for (let i=0;i<2;i++) await complete(bindings,'system','user',transport,'tk');
  await expect(complete(bindings,'system','user',transport,'tk'),'owner reservation must not bypass total AI ceiling').rejects.toThrow(/budget/i);
  expect(calls).toBe(4);
});
// The REST case above sets the principal by hand. This drives the real MCP hop,
// where losing the grant would charge delegated AI work to the owner reserve.
it('AI work through an MCP tool spends the grant share, not the owner reserve', async () => {
  const { putSettings } = await import('../src/model.ts');
  await putSettings(env.DB, { ai_model_tk: 'claude-opus-5' });
  const f = await flow(), bindings = { ...env, AI_PROVIDER_KEY: 'disposable-provider-fixture', AI_DAILY_CALL_LIMIT: '3', AI_OWNER_RESERVED_CALLS: '2', AI_GRANT_DAILY_CALL_LIMIT: '3' };
  const created = await f.request('/blyg/api/items', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ contentMd: '[TK]write more[/TK]' }) }, bindings);
  expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };
  const minted = await f.request('/blyg/api/authorizations', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'MCP AI', scope: ['owner:draft'], resource: 'mcp' }) }, bindings);
  expect(minted.status).toBe(200);
  const { accessToken } = await minted.json() as { accessToken: string };
  const original = globalThis.fetch;
  let calls = 0;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input instanceof Request ? input.url : input).startsWith('https://api.anthropic.com/')) return original(input, init);
    calls++;
    return Response.json({ model: 'claude-opus-5', content: [{ type: 'text', text: 'Fixture' }] });
  });
  try {
    const viaMcp = async () => {
      const response = await f.request('/blyg/studio/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'generateItem' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generateItem', arguments: { path: { id }, body: { scope: 0, expectedRevision: await testItemRevision(id) } }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) }, bindings);
      expect(response.status).toBe(200);
      return (await response.json() as { result: { isError?: boolean; content: { text: string }[] } }).result;
    };
    expect(Boolean((await viaMcp()).isError), 'the delegated share admits one MCP generation').toBe(false);
    const refused = await viaMcp();
    expect(refused.isError, 'MCP AI work cannot reach the owner reserve').toBe(true);
    expect(refused.content[0].text).toContain('budget');
    expect(calls).toBe(1);
    const viaOwner = async () => f.request('/blyg/api/items/' + id + '/generate', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 0, expectedRevision: await testItemRevision(id) }) }, bindings);
    for (let i = 0; i < 2; i++) expect((await viaOwner()).status, 'the owner reserve survives delegated MCP work').toBe(200);
    expect((await viaOwner()).status).toBe(429);
    expect(calls).toBe(3);
  } finally { spy.mockRestore(); }
});
