/**
 * Delegated permissions are independent capabilities, not a role hierarchy.
 * Decision #52 separates reading, drafting, publication and management. RFC6750
 * §3 requires an insufficient_scope challenge for an authenticated denial:
 * https://www.rfc-editor.org/rfc/rfc6750.html#section-3
 * OWASP recommends deny by default and authorization on every request:
 * https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
 *
 * Model: literal operation groups below own the expected permissions. They do
 * not call operationScopes or derive expectations from route methods. The route
 * inventory supplies only receiving URLs. An inventory equality check requires
 * a deliberate oracle decision whenever an operation is added or removed.
 * Grammar: all 16 scope subsets × every REST operation, plus all subsets for
 * changing public response visibility. The driver uses real Hono routing and
 * real handlers; injected access starts after token validation, which is tested
 * separately by native OAuth and SDK boundary oracles.
 * Refinement: denied requests return 403 with insufficient_scope before body
 * validation or business work. Authorized requests reach the handler/validator;
 * missing fixture resources may return 404. This is a permission oracle, not a
 * successful-business-operation oracle or proof about every argument value.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { Hono } from 'hono';
import { createOwnerApi } from '../src/owner-api.ts';
import { routes } from '../src/contract/routes.ts';

const model = {
  'owner:read': ['getChanges','listItems','getItem','getSettings','listSubscriptions','getSubscription','listHoppers','getHopper','listSignals','listMentions','search','getVersion','listReading','listImportedReading','getImportedItem','getImportedHistory','getImportedVersion','getUpdateState','getMentionSource','listStaleThreads','getItemFreshness','getForkOptions','listInteractions','listThumbs','getAiModels'],
  'owner:draft': ['createItem','updateItem','deleteItem','restoreItem','uploadMedia','generateItem','draftNote','preview'],
  'owner:publish': ['publishItem','withdrawItem','pinItem','refreshItem','deleteMedia'],
  'owner:manage': ['updateSettings','createSubscription','updateSubscription','resyncSubscription','pollAllSubscriptions','deleteSubscription','createHopper','updateHopper','deleteHopper','addHopperItem','removeHopperItem','setSignal','deleteSignal','updateMention'],
  'reading:state': ['markRead','markReadBatch','markUnread','markUnreadBatch'],
};
const capabilities = Object.keys(model);
const subsets = Array.from({ length: 1 << capabilities.length }, (_, mask) => capabilities.filter((_, bit) => mask & 1 << bit));
async function receive(app: Hono<any>, method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request('https://permissions.example.test/api' + path, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }), { ...env, API_READ_LIMIT: '10000', API_WRITE_LIMIT: '10000', API_DELEGATED_READ_LIMIT: '10000', API_DELEGATED_WRITE_LIMIT: '10000' }, ctx);
  await waitOnExecutionContext(ctx); return response;
}
it('the independent permission model accounts for every contract operation exactly once', () => {
  const names = Object.values(model).flat();
  expect(new Set(names).size).toBe(names.length);
  expect(names.sort()).toEqual(Object.keys(routes).sort());
});
it.each(subsets.map(scope => [scope.join(' ') || '(none)', scope] as const))('checks every REST operation for scope subset %s', async (_, scope) => {
  const app = new Hono().route('/api', createOwnerApi({ scope: [...scope], clientId: 'oracle', userId: 'owner' }));
  for (const [required, operations] of Object.entries(model)) {
    for (const operation of operations) {
      const route = routes[operation as keyof typeof routes];
      const path = route.path.replace(/\{(\w+)\}/g, (_, name) => ['v', 'version'].includes(name) ? '1' : 'missing-oracle-resource');
      const response = await receive(app, route.method.toUpperCase(), path, ['get','delete'].includes(route.method) ? undefined : {});
      const witness = `${operation}: ${scope.join(' ') || '(none)'} requires ${required}`;
      if (!scope.includes(required)) {
        expect(response.status, witness).toBe(403);
        expect(response.headers.get('www-authenticate'), witness).toContain('insufficient_scope');
      } else {
        // A server failure is not an authorization success. These requests
        // either read an empty collection, validate an empty body, or miss
        // a fixture resource. Business success histories live in other oracles.
        expect([200, 201, 400, 404, 409, 415, 422], witness).toContain(response.status);
      }
    }
  }
});
// A PATCH that changes public visibility crosses two independent capabilities.
// Test every subset rather than checking only draft-only and full-access roles.
// Every field that changes a public page without a publish event is listed here.
const publicEdits = [
  ['response visibility', 'owner:draft', '/items/missing-oracle-resource', { responses: 'hide' }],
  ['generated highlighting', 'owner:draft', '/items/missing-oracle-resource', { highlight: 'hide' }],
  ['the avatar', 'owner:manage', '/settings', { avatar_media_id: 'missing-oracle-media' }],
] as const;
it.each(publicEdits.flatMap(([what, base, path, body]) => subsets.map(scope => [what, scope.join(' ') || '(none)', base, path, body, scope] as const)))('requires publish to edit %s: %s', async (_, __, base, path, body, scope) => {
  const app = new Hono().route('/api', createOwnerApi({ scope: [...scope], clientId: 'oracle', userId: 'owner' }));
  const response = await receive(app, 'PATCH', path, body);
  if (scope.includes(base) && scope.includes('owner:publish')) expect(response.status, 'both capabilities admit the edit').not.toBe(403);
  else expect(response.status, 'a public edit needs ' + base + ' and owner:publish').toBe(403);
});
