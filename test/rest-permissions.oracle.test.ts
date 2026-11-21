/** Delegated permissions are independent capabilities at every REST receiving
 * boundary. This oracle owns createOwnerApi's scope guards and public-edit gate.
 *
 * ```ts
 * GET /api/settings // → 403 insufficient_scope without owner:read
 * PATCH /api/items/id { responses: 'hide' } // → 403 without draft + publish
 * GET /api/capabilities // → handler reached by any authenticated client
 * ```
 * A draft grant cannot acquire publication authority through a PATCH. Decision
 * #52 separates the capabilities; RFC6750 §3 requires the scope challenge.
 * The deprecated getChanges read remains during its two-release window
 * (Kyle Mathews, GitHub KyleAMathews, 2026-11-19).
 * For every scope subset and declared operation, the independent permission
 * inventory below decides whether the guard must deny before business work.
 * For every public edit, both its base capability and publish are required.
 *
 * Histories carry scopes and edit inputs, never expected statuses. The model's
 * literal operation groups are independent of route policies. The driver uses
 * route metadata only to build receiving URLs, then records statuses/challenges.
 * Checks compare each completed response and require the full walk. Authorized
 * empty/missing-resource requests may fail validation; this is not business
 * success coverage. JWT verification and arbitrary body values are separate.
 */
import { differs, oracleProperty, pass, type Observation } from '@tanstack/oracles';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { createOwnerApi } from '../src/owner-api.ts';
import { routes } from '../src/contract/routes.ts';
import { withOracleStorage } from './oracle-storage.ts';

// Decision #52 and docs/auth-oracles.md own these independent capability groups.
// No route classifier, verb rule, or production permission helper supplies them.
const permissionGroups = {
  authenticated: ['getCapabilities'],
  'owner:read': ['getDictionary','getShelf','listContacts','batchRead','getChanges','getItemSummary','listItemVersions','listHopperMemberships','getReadingSummary','getSignalSummary','listItems','getItem','getSettings','listSubscriptions','getSubscription','listHoppers','getHopper','listSignals','listMentions','listMentionGroups','getMentionSummary','search','getVersion','listReading','listImportedReading','getImportedItem','getImportedHistory','getImportedVersion','getUpdateState','getMentionSource','listStaleThreads','getItemFreshness','getForkOptions','listInteractions','listThumbs','getAiModels','peekItem','classifyLinks','listBrowse','extLineageGlyphGetLineage','extLineageGlyphListSummaries','extSpellcheckGetWords','extSpellcheckProofread','extWordCountListCounts'],
  'owner:draft': ['createItem','updateItem','deleteItem','restoreItem','uploadMedia','generateItem','draftNote','summarizeChangelog','classifyChange','preview'],
  'owner:publish': ['publishItem','withdrawItem','pinItem','refreshItem','deleteMedia'],
  'owner:manage': ['setReadingPlacement','putDictionarySource','putShelf','createContact','updateContact','resolveContact','deleteContact','updateSettings','createSubscription','updateSubscription','resyncSubscription','pollAllSubscriptions','deleteSubscription','createHopper','updateHopper','deleteHopper','addHopperItem','removeHopperItem','setSignal','deleteSignal','updateMention'],
  'reading:state': ['markRead','markReadBatch','markUnread','markUnreadBatch','logBrowse','clearBrowse'],
};
const capabilities = Object.keys(permissionGroups).filter(scope => scope !== 'authenticated');
const subsets = Array.from({ length: 1 << capabilities.length }, (_, mask) => capabilities.filter((_, bit) => mask & 1 << bit));
const publicEdits = [
  { what: 'response visibility', resource: 'item', path: '/items/missing-oracle-resource', body: { responses: 'hide' } },
  { what: 'generated highlighting', resource: 'item', path: '/items/missing-oracle-resource', body: { highlight: 'hide' } },
  { what: 'the avatar', resource: 'settings', path: '/settings', body: { avatarMediaId: 'missing-oracle-media' } },
] as const;
type History = { kind: 'inventory' } | { kind: 'operations'; scope: string[] } | { kind: 'public-edit'; scope: string[]; edit: typeof publicEdits[number] };
const histories: History[] = [{ kind: 'inventory' }, ...subsets.map(scope => ({ kind: 'operations' as const, scope })), ...publicEdits.flatMap(edit => subsets.map(scope => ({ kind: 'public-edit' as const, scope, edit })))];
const label = (history: History) => history.kind === 'inventory' ? 'the independent permission model accounts for every contract operation exactly once' : history.kind === 'operations' ? `checks every REST operation for scope subset ${history.scope.join(' ') || '(none)'}` : `requires publish to edit ${history.edit.what}: ${history.scope.join(' ') || '(none)'}`;
// Admission is a set-membership law; the model does not infer authority from HTTP
// verbs. Allowed handler results retain the original validator/missing-row freedom.
function model(history: History) {
  const names = Object.values(permissionGroups).flat();
  if (history.kind === 'inventory') return { kind: history.kind, names: [...names].sort(), unique: names.length };
  if (history.kind === 'public-edit') return { kind: history.kind, denied: !history.scope.includes(history.edit.resource === 'settings' ? 'owner:manage' : 'owner:draft') || !history.scope.includes('owner:publish') };
  return { kind: history.kind, operations: Object.entries(permissionGroups).flatMap(([required, operations]) => operations.map(operation => ({ operation, denied: required !== 'authenticated' && !history.scope.includes(required) }))) };
}
async function receive(app: Hono<any>, method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request('https://permissions.example.test/api' + path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }), { ...env, API_READ_LIMIT: '10000', API_WRITE_LIMIT: '10000', API_DELEGATED_READ_LIMIT: '10000', API_DELEGATED_WRITE_LIMIT: '10000' }, ctx);
  await waitOnExecutionContext(ctx); return response;
}
async function driver(history: History, observe: (checkpoint: string, value: unknown) => void) {
  await withOracleStorage(async () => {
    if (history.kind === 'inventory') {
      observe('permission inventory', { names: Object.keys(routes).sort(), unique: new Set(Object.values(permissionGroups).flat()).size }); return;
    }
    const app = new Hono().route('/api', createOwnerApi({ scope: [...history.scope], clientId: 'oracle', userId: 'owner' }));
    if (history.kind === 'public-edit') {
      const response = await receive(app, 'PATCH', history.edit.path, history.edit.body);
      observe('public edit receiving decision', response.status); return;
    }
    for (const operations of Object.values(permissionGroups)) for (const operation of operations) {
      // The retained contract still supplies its receiving URL when the
      // implementation accidentally drops it; absence must reach real HTTP.
      const route = routes[operation as keyof typeof routes] ?? (operation === 'getChanges' ? { method: 'get', path: '/changes' } : undefined);
      if (!route) throw new Error(`Missing receiving route for ${operation}`);
      const path = route.path.replace(/\{(\w+)\}/g, (_, name) => ['v', 'version'].includes(name) ? '1' : 'missing-oracle-resource');
      const response = await receive(app, route.method.toUpperCase(), path, ['get','delete'].includes(route.method) ? undefined : {});
      observe('REST receiving permission', { operation, status: response.status, challenge: response.headers.get('www-authenticate') });
    }
  });
  observe('permission cleanup complete', true);
}
function check(_history: History, trace: readonly Observation[], expected: ReturnType<typeof model>) {
  const received = trace.filter(entry => entry.checkpoint !== 'permission cleanup complete');
  const completed = (count: number) => differs('permission cleanup complete', 'independent capabilities', trace.filter(entry => entry.checkpoint === 'permission cleanup complete').map(entry => entry.value), [true]) ?? differs('REST permission walk completion', 'independent capabilities', received.length, count) ?? pass;
  if (expected.kind === 'inventory') return differs('permission inventory', 'independent capabilities', received, [{ checkpoint: 'permission inventory', value: { names: expected.names, unique: expected.unique } }]) ?? completed(1);
  if (expected.kind === 'public-edit') {
    const first = received[0];
    return differs('public edit receiving decision', 'independent capabilities', { checkpoint: first?.checkpoint, denied: first?.value === 403 }, { checkpoint: 'public edit receiving decision', denied: expected.denied }) ?? completed(1);
  }
  for (let index = 0; index < Math.min(received.length, expected.operations!.length); index++) {
    const wanted = expected.operations![index], entry = received[index], actual = entry?.value as { operation?: string; status?: number; challenge?: string | null } | undefined;
    const result = differs('REST receiving permission', 'independent capabilities', { checkpoint: entry?.checkpoint, operation: actual?.operation, admitted: wanted.denied ? actual?.status === 403 : [200, 201, 400, 404, 409, 415, 422].includes(actual?.status ?? 0), scopeChallenge: !wanted.denied || actual?.challenge?.includes('insufficient_scope') === true }, { checkpoint: 'REST receiving permission', operation: wanted.operation, admitted: true, scopeChallenge: true });
    if (result) return result;
  }
  return completed(expected.operations!.length);
}
oracleProperty({
  id: 'rest-permissions', owns: ['src/owner-api.ts#createOwnerApi', 'src/operation-policy.ts#resolve'],
  law: { statement: 'For every defined REST operation and scope subset, permission guards require its explicit independent capability, and a public edit requires its base capability plus publication.', authority: 'Decision #52; Kyle Mathews (KyleAMathews), 2026-11-19, retain getChanges unchanged for two releases; docs/auth-oracles.md complete REST permission inventory; RFC6750 §3 https://www.rfc-editor.org/rfc/rfc6750.html#section-3', limits: 'All 32 subsets and current operations; empty/missing-resource arguments exercise guard admission, not successful business effects; native JWT verification is separate.' },
  histories, label, model, driver, check,
  calibrations: [{ name: 'scope-denied operation admitted', law: 'independent capabilities', history: { enumerated: 1 }, corrupt: trace => trace.map((entry, index) => index === 1 ? { ...entry, value: { ...(entry.value as object), status: 200 } } : entry) }],
});
