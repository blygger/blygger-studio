import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { Hono } from 'hono';
import { createOwnerApi } from '../src/owner-api.ts';
import { serveAuthorizedMcp } from '../src/mcp.ts';
import { compiledServerExtensions } from '../build/extensions.server.ts';
import type { ServerExtension } from '../src/extensions/server.ts';
import type { OwnerAccess } from '../src/permissions.ts';
import { putSettings } from '../src/model.ts';
import spec from '../openapi.json';

const extensionOperations = ['extLineageGlyphGetLineage', 'extLineageGlyphListSummaries'];
const authority = (scope: string[]): OwnerAccess => ({ scope, clientId: crypto.randomUUID(), userId: 'owner' });
async function rest(access: OwnerAccess, path = '/capabilities', method = 'GET', body?: unknown, extensions = compiledServerExtensions) {
  const app = new Hono().route('/api', createOwnerApi(access, extensions)), ctx = createExecutionContext();
  const response = await app.fetch(new Request('https://policy.example/api' + path, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }), { ...env, MOUNT: '/nested/blyg' }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function mcp(access: OwnerAccess, method = 'tools/list', params: Record<string, unknown> = {}, extensions: readonly ServerExtension[] = compiledServerExtensions, bindings = env) {
  const ctx = createExecutionContext();
  const response = await serveAuthorizedMcp(new Request('https://policy.example/nested/blyg/studio/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
  }), bindings, ctx, access, extensions);
  await waitOnExecutionContext(ctx);
  return response;
}
async function inventory(access: OwnerAccess, extensions = compiledServerExtensions) {
  const response = await mcp(access, 'tools/list', {}, extensions);
  expect(response.status).toBe(200);
  return (await response.json() as any).result.tools as { name: string; annotations: Record<string, boolean>; description: string }[];
}
it.each([[], ['reading:state']].map(scope => [scope] as const))('lets any authenticated grant discover its own capabilities: %j', async scope => {
  await putSettings(env.DB, { extensions: '[]' });
  const access = authority(scope), response = await rest(access);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const value = await response.json() as any;
  const expected = ['getCapabilities', ...(scope.length ? ['markRead', 'markUnread', 'markReadBatch', 'markUnreadBatch', 'logBrowse', 'clearBrowse'] : [])].sort();
  expect(value.operations).toEqual(expected);
  expect((await inventory(access)).map(tool => tool.name).sort()).toEqual(expected);
  expect(value.endpoints).toEqual({ publicBase: 'https://policy.example/nested/blyg', studio: 'https://policy.example/nested/blyg/studio',
    api: 'https://policy.example/api', issuer: 'https://policy.example/nested/blyg/studio/auth', mcp: 'https://policy.example/nested/blyg/studio/mcp', media: 'https://policy.example/nested/blyg/media' });
});
it.each([
  ['declared only', [], true, ['owner:read'], false, true],
  ['compiled but disabled', compiledServerExtensions, false, ['owner:read'], true, true],
  ['enabled but ungranted', compiledServerExtensions, true, ['reading:state'], true, false],
  ['available', compiledServerExtensions, true, ['owner:read'], true, true],
] as const)('separates extension state and filters both discovery paths: %s', async (_, extensions, enabled, scope, compiled, granted) => {
  await putSettings(env.DB, { extensions: JSON.stringify(enabled ? ['lineage-glyph'] : []) });
  const access = authority([...scope]);
  const value = await (await rest(access, '/capabilities', 'GET', undefined, extensions)).json() as any;
  expect(value.extensions.find((extension: any) => extension.name === 'lineage-glyph')).toEqual({ name: 'lineage-glyph', declared: true, compiled, enabled, granted });
  const present = compiled && enabled && granted;
  for (const operation of extensionOperations) expect(value.operations.includes(operation)).toBe(present);
  expect((await inventory(access, extensions)).map(tool => tool.name).sort()).toEqual(value.operations);
});
it('rechecks an extension after discovery and rejects direct calls when unavailable', async () => {
  const access = authority(['owner:read']);
  await putSettings(env.DB, { extensions: '["lineage-glyph"]' });
  expect((await inventory(access)).map(tool => tool.name)).toContain('extLineageGlyphListSummaries');
  const call = () => mcp(access, 'tools/call', { name: 'extLineageGlyphListSummaries', arguments: { query: { keys: '[]' } } });
  expect((await (await call()).json() as any).result.isError).not.toBe(true);
  await putSettings(env.DB, { extensions: '[]' });
  expect((await (await call()).json() as any).result.isError).toBe(true);
  expect((await rest(access, '/ext/lineage-glyph/summaries?keys=[]')).status).toBe(404);
  await putSettings(env.DB, { extensions: '["lineage-glyph"]' });
  const uncompiled = await mcp(access, 'tools/call', { name: 'extLineageGlyphListSummaries', arguments: { query: { keys: '[]' } } }, []);
  expect((await uncompiled.json() as any).result.isError).toBe(true);
  expect((await rest(access, '/ext/lineage-glyph/summaries?keys=[]', 'GET', undefined, [])).status).toBe(404);
});
it('describes actual effects and conditional permission rules in MCP and OpenAPI', async () => {
  const tools = await inventory(authority(['owner:read', 'owner:draft', 'owner:manage', 'reading:state']));
  const tool = (name: string) => tools.find(tool => tool.name === name)!;
  expect(tool('preview').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  expect(tool('classifyLinks').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  expect(tool('getUpdateState').annotations.readOnlyHint).toBe(false);
  expect(tool('classifyChange').annotations.destructiveHint).toBe(true);
  expect(tool('setSignal').annotations.destructiveHint).toBe(true);
  expect(tool('markRead').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  expect(tool('updateItem').description).toContain('also requires owner:publish');
  expect(tool('updateSettings').description).toContain('also requires owner:publish');
  expect(spec.paths['/api/items/{id}'].patch.description).toContain('also requires owner:publish');
  expect(JSON.stringify(spec)).not.toContain('conditionalScopes');
  expect(JSON.stringify(spec)).not.toContain('"policy"');
});
it('validates null JSON without crashing conditional permission checks', async () => {
  expect((await rest(authority(['owner:draft']), '/items/missing', 'PATCH', null)).status).toBe(400);
  expect((await rest(authority(['owner:manage']), '/settings', 'PATCH', null)).status).toBe(400);
});
it('charges one declared API budget per REST or MCP operation', async () => {
  const access = authority(['owner:read', 'owner:draft']);
  expect((await rest(access, '/preview', 'POST', { content_md: 'preview' })).status).toBe(200);
  const result = await mcp(access, 'tools/call', { name: 'preview', arguments: { body: { content_md: 'preview' } } });
  expect((await result.json() as any).result.isError).not.toBe(true);
  expect((await rest(access, '/peek/links', 'POST', { urls: [] })).status).toBe(200);
  const rows = await env.DB.prepare('SELECT key, used FROM security_budgets WHERE key LIKE ? ORDER BY key').bind('%:grant:' + access.clientId).all<{ key: string; used: number }>();
  expect(rows.results).toEqual([{ key: 'api-read:grant:' + access.clientId, used: 2 }, { key: 'api-write:grant:' + access.clientId, used: 1 }]);
});
it.each([
  ['tools/list', {}, 1],
  ['tools/call', { name: 'preview', arguments: { body: { content_md: 'text' } } }, 0],
  ['tools/call', { name: 'getCapabilities', arguments: {} }, 1],
  ['tools/call', { name: 'extLineageGlyphListSummaries', arguments: { query: { keys: '[]' } } }, 1],
] as const)('bounds extension state reads for %s %j', async (method, params, expected) => {
  await putSettings(env.DB, { extensions: '["lineage-glyph"]' });
  let reads = 0;
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      if (sql === "SELECT value FROM settings WHERE key = 'extensions'") reads++;
      return target.prepare(sql);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const bindings = { ...env, DB: db }, access = authority(['owner:read', 'owner:draft']);
  const response = await mcp(access, method, params, compiledServerExtensions, bindings);
  expect(response.status).toBe(200);
  const value = await response.json() as any;
  expect(value.error).toBeUndefined();
  expect(value.result.isError).not.toBe(true);
  expect(reads).toBe(expected);
});
