import { env } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Hono } from 'hono';
import { createOwnerApi } from '../src/owner-api.ts';
import { operationDefinitions } from '../src/operations.ts';
import { runOperation } from '../src/operation-runner.ts';
import { success, type OperationContext } from '../src/operation-types.ts';
import { workPrincipal } from '../src/security-budgets.ts';

function context(scope: string[]): OperationContext {
  return { env, access: { scope, clientId: crypto.randomUUID(), userId: 'owner' }, url: 'https://runner.example/blyg/studio/mcp', extensions: [], defer: () => {} };
}
const input = { path: {}, query: {} };
it('executes domain work without an HTTP context and returns typed outcomes', async () => {
  const definitions = operationDefinitions([]), ctx = context(['owner:draft', 'owner:read']);
  const created = await runOperation(definitions.get('createItem')!, { ...input, body: { contentMd: 'direct operation' } }, ctx);
  expect(created).toMatchObject({ ok: true, created: true, value: { contentMd: 'direct operation', status: 'draft' } });
  if (!created.ok) throw new Error('creation failed');
  const id = (created.value as { id: string }).id;
  expect(created.location).toBe('/blyg/api/items/' + id);
  const read = await runOperation(definitions.get('getItem')!, { ...input, path: { id } }, ctx);
  expect(read).toMatchObject({ ok: true, created: false, value: { id, contentMd: 'direct operation' } });
  const invalid = await runOperation(definitions.get('createItem')!, { ...input, body: { unknown: true } }, ctx);
  expect(invalid).toMatchObject({ ok: false, kind: 'invalid-input' });
});
it('rejects authority before work and charges the verified grant once', async () => {
  const definition = operationDefinitions([]).get('createItem')!, ctx = context([]);
  let calls = 0, observed: string | undefined;
  const measured = { ...definition, handler: async (context: OperationContext) => { calls++; observed = workPrincipal(context.env); return success({ ok: true }); } };
  const denied = await runOperation(measured, { ...input, body: {} }, ctx);
  expect(denied).toMatchObject({ ok: false, kind: 'forbidden', requiredScopes: ['owner:draft'] });
  expect(calls).toBe(0);
  expect(await env.DB.prepare('SELECT used FROM security_budgets WHERE key = ?').bind('api-write:grant:' + ctx.access!.clientId).first()).toBeNull();
  ctx.access!.scope = ['owner:draft'];
  expect((await runOperation(measured, { ...input, body: {} }, ctx)).ok).toBe(true);
  expect(calls).toBe(1);
  expect(observed).toBe(ctx.access!.clientId);
  expect(await env.DB.prepare('SELECT used FROM security_budgets WHERE key = ?').bind('api-write:grant:' + ctx.access!.clientId).first()).toEqual({ used: 1 });
});
it('keeps domain/output schema failures internal instead of blaming client input', async () => {
  const definition = operationDefinitions([]).get('getSettings')!, log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await runOperation({ ...definition, handler: async () => { z.string().parse(12); return success({}); } }, input, context(['owner:read']));
    expect(result).toEqual({ ok: false, kind: 'internal', value: { code: 'internal', message: 'internal server error' }, requiredScopes: undefined });
    expect(log).toHaveBeenCalledWith('Operation failed', { operation: 'getSettings', errorType: 'ZodError' });
  } finally { log.mockRestore(); }
});
it.each(['bad inline', 'file as item id'])('rejects malformed multipart metadata: %s', async kind => {
  const ctx = context(['owner:draft']);
  const app = new Hono().route('/api', createOwnerApi(ctx.access!));
  const form = new FormData();
  form.set('file', new File(['bytes'], 'file.png', { type: 'image/png' }));
  if (kind === 'bad inline') form.set('inline', 'sometimes');
  else form.set('itemId', new File(['not an id'], 'id.txt'));
  const response = await app.fetch(new Request('https://runner.example/api/media', { method: 'POST', body: form }), env);
  expect(response.status).toBe(400);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM media').first()).toEqual({ n: 0 });
});
