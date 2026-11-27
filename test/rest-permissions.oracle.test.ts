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
import { getItem, putSettings } from '../src/model.ts';
import { runGenerateScope } from '../src/tk-generate.ts';
import { withOracleStorage } from './oracle-storage.ts';

// Decision #52 and docs/auth-oracles.md own these independent capability groups.
// No route classifier, verb rule, or production permission helper supplies them.
const permissionGroups = {
  authenticated: ['getCapabilities'],
  'owner:read': ['getDictionary','getSyndication','listHelpers','catchUp','getShelf','listContacts','batchRead','getItemSummary','listItemVersions','listHopperMemberships','getReadingSummary','getSignalSummary','listItems','getItem','getSettings','listSubscriptions','getSubscription','listHoppers','getHopper','listSignals','listMentions','listMentionGroups','getMentionSummary','search','getVersion','listReading','listImportedReading','getImportedItem','getImportedHistory','getImportedVersion','getUpdateState','getMentionSource','listStaleThreads','getItemFreshness','getForkOptions','listInteractions','listThumbs','getAiModels','peekItem','classifyLinks','listBrowse','extLineageGlyphGetLineage','extLineageGlyphListSummaries','extSpellcheckGetWords','extSpellcheckProofread','extWordCountListCounts'],
  // The notebook (sealed-content-build-plan §1 0d): owner:read does not imply it.
  'owner:private': ['listPrivateVersions','listAgenticFeeds','getAgentic'],
  // A conjunction: the Agentic feed may name any own item, so writing it is notebook access too
  // (Venkat, session 88). Denied unless the subset holds every scope named in the key.
  'owner:manage+owner:private': ['putAgentic', 'regenerateAgentic'],
  'owner:draft': ['createItem','updateItem','deleteItem','restoreItem','uploadMedia','generateItem','draftNote','summarizeChangelog','summarizeCatchUp','classifyChange','preview'],
  'owner:publish': ['publishItem','withdrawItem','pinItem','putSyndication','refreshItem','deleteMedia'],
  'owner:manage': ['setReadingPlacement','putDictionarySource','putShelf','createContact','updateContact','resolveContact','deleteContact','updateSettings','createSubscription','updateSubscription','resyncSubscription','pollAllSubscriptions','deleteSubscription','createHopper','updateHopper','deleteHopper','addHopperItem','removeHopperItem','setSignal','deleteSignal','updateMention'],
  'reading:state': ['markRead','markReadBatch','markUnread','markUnreadBatch','logBrowse','clearBrowse'],
};
const capabilities = Object.keys(permissionGroups).filter(scope => scope !== 'authenticated' && !scope.includes('+'));
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
  return { kind: history.kind, operations: Object.entries(permissionGroups).flatMap(([required, operations]) => operations.map(operation => ({ operation, denied: required !== 'authenticated' && !required.split('+').every(scope => history.scope.includes(scope)) }))) };
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
      const route = routes[operation as keyof typeof routes];
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
  law: { statement: 'For every defined REST operation and scope subset, permission guards require its explicit independent capability, and a public edit requires its base capability plus publication.', authority: 'Decision #52; docs/auth-oracles.md complete REST permission inventory; RFC6750 §3 https://www.rfc-editor.org/rfc/rfc6750.html#section-3', limits: 'All 32 subsets and current operations; empty/missing-resource arguments exercise guard admission, not successful business effects; native JWT verification is separate.' },
  histories, label, model, driver, check,
  calibrations: [{ name: 'scope-denied operation admitted', law: 'independent capabilities', history: { enumerated: 1 }, corrupt: trace => trace.map((entry, index) => index === 1 ? { ...entry, value: { ...(entry.value as object), status: 200 } } : entry) }],
});

// The notebook dimension (studio#178, Kyle's coverage follow-up; blygger-spec
// docs/sealed-content-build-plan.md §1 0f law 1). For every scope subset, every
// `/items/{id}` operation and every resource kind: a grant without owner:private
// gets, for a private item or a draft whose working copy drew on one, exactly the
// answer it gets for an id that does not exist. Answers are compared raw, not with
// ids normalized, and neither may echo the id it was asked about: a normalized
// comparison could hide a difference that only the id carries.
const MISSING = 'zzzzzzzzzzzzzzzzzzzzzzzzzz';
type Resource = 'missing' | 'draft' | 'private' | 'tainted draft';
const RESOURCES: Resource[] = ['missing', 'draft', 'private', 'tainted draft'];
type NotebookHistory = { scope: string[] };
const notebookHistories: NotebookHistory[] = subsets.map(scope => ({ scope }));
const itemOperations = Object.entries(routes).filter(([, route]) => route.path.startsWith('/items/{id}')).map(([name]) => name).sort();
const required = (operation: string) => Object.entries(permissionGroups).find(([, operations]) => (operations as readonly string[]).includes(operation))?.[0];
function notebookModel(history: NotebookHistory) {
  const sees = history.scope.includes('owner:private');
  return itemOperations.map(operation => {
    const scope = required(operation);
    const admitted = scope === 'authenticated' || (scope !== undefined && history.scope.includes(scope));
    // Denied by scope: one answer for every resource. Admitted without owner:private:
    // hidden resources answer as the missing one. With it, no equality is owed.
    return { operation, hiddenAsMissing: !admitted || !sees, echoes: false };
  });
}
async function seedNotebook() {
  const owner = new Hono().route('/api', createOwnerApi({ scope: [...capabilities], clientId: 'oracle-owner', userId: 'owner' }));
  const call = async (method: string, path: string, body?: unknown) => (await receive(owner, method, path, body)).json<any>();
  const draft = (await call('POST', '/items', { contentMd: 'a plain draft', kind: 'fragment' })).id as string;
  const kept = (await call('POST', '/items', { contentMd: 'notebook words', kind: 'fragment' })).id as string;
  await call('POST', `/items/${kept}/publish`, { visibility: 'private', expectedRevision: (await call('GET', `/items/${kept}`)).revision });
  const tainted = (await call('POST', '/items', { contentMd: `[TK]summarize ![[${kept}]][/TK]`, kind: 'fragment' })).id as string;
  await putSettings(env.DB, { ai_model: 'claude-opus-5' });
  const provider = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'derived words' }] }) });
  const generated = await runGenerateScope({ ...env, AI_PROVIDER_KEY: 'k' }, (await getItem(env.DB, tainted))!, 0, provider, undefined, { privateSources: true });
  if (!generated.ok) throw new Error('notebook fixture could not taint its draft');
  return { missing: MISSING, draft, private: kept, 'tainted draft': tainted } as Record<Resource, string>;
}
async function notebookDriver(history: NotebookHistory, observe: (checkpoint: string, value: unknown) => void) {
  await withOracleStorage(async () => {
    const ids = await seedNotebook();
    const app = new Hono().route('/api', createOwnerApi({ scope: [...history.scope], clientId: 'oracle', userId: 'owner' }));
    for (const operation of itemOperations) {
      const route = routes[operation as keyof typeof routes];
      const answers = {} as Record<Resource, { status: number; text: string; challenge: string | null }>;
      for (const resource of RESOURCES) {
        const id = ids[resource];
        const revision = (await getItem(env.DB, id))?.revision ?? 1;
        const path = route.path.replace(/\{(\w+)\}/g, (_, name) => ['v', 'version'].includes(name) ? '1' : id);
        const body = ['get', 'delete'].includes(route.method) ? (route.method === 'delete' ? { expectedRevision: revision } : undefined) : { expectedRevision: revision, ...(operation === 'generateItem' ? { scope: 0 } : {}), ...(operation === 'restoreItem' ? { version: 1 } : {}) };
        const response = await receive(app, route.method.toUpperCase(), path, body);
        answers[resource] = { status: response.status, text: await response.text(), challenge: response.headers.get('www-authenticate') };
      }
      const asMissing = (resource: Resource) => JSON.stringify(answers[resource]) === JSON.stringify(answers.missing);
      observe('notebook receiving', {
        operation,
        hiddenAsMissing: asMissing('private') && asMissing('tainted draft') && answers.missing.status < 500,
        echoes: answers.missing.text.includes(MISSING) || answers.private.text.includes(ids.private) || answers['tainted draft'].text.includes(ids['tainted draft']),
        statuses: Object.fromEntries(RESOURCES.map(resource => [resource, answers[resource].status])),
      });
    }
  });
  observe('notebook cleanup complete', true);
}
function notebookCheck(history: NotebookHistory, trace: readonly Observation[], expected: ReturnType<typeof notebookModel>) {
  const received = trace.filter(entry => entry.checkpoint === 'notebook receiving');
  const sees = history.scope.includes('owner:private');
  for (let index = 0; index < Math.min(received.length, expected.length); index++) {
    const wanted = expected[index], actual = received[index].value as { operation: string; hiddenAsMissing: boolean; echoes: boolean };
    // A grant that sees private items, admitted to the operation, is owed no equality and may read their ids.
    const owed = sees && !wanted.hiddenAsMissing ? { operation: wanted.operation, hiddenAsMissing: actual.hiddenAsMissing, echoes: actual.echoes } : wanted;
    const result = differs('notebook receiving', 'notebook as missing', { operation: actual.operation, hiddenAsMissing: actual.hiddenAsMissing, echoes: actual.echoes }, owed);
    if (result) return result;
  }
  return differs('notebook walk completion', 'notebook as missing', received.length, expected.length) ?? pass;
}
oracleProperty({
  id: 'rest-permissions-notebook', owns: ['src/operation-runner.ts#executeOperation', 'src/private-access.ts', 'src/owner-api.ts#createOwnerApi'],
  law: { statement: 'For every scope subset and every /items/{id} operation, a grant without owner:private receives for a private item, or a draft whose working copy drew on one, exactly the answer it receives for an id that does not exist, without echoing the id, and never a server error.', authority: 'blygger-spec docs/sealed-content-build-plan.md §1 0f law 1; decisions by Venkat Rao (GitHub vgururao), 2026-11-23 (private scope) and 2026-11-24 (private taint, Q1–Q3); Kyle Mathews\' coverage follow-up on studio#178.', limits: 'All 64 subsets, in-process createOwnerApi with one seeded fixture per subset. Path-addressed operations only; body-addressed ids, MCP and read-batch are private-scope\'s. Status, challenge and body are compared raw.' },
  histories: notebookHistories, label: history => `a grant of ${history.scope.join(' ') || '(none)'} learns nothing about hidden items`, model: notebookModel, driver: notebookDriver, check: notebookCheck,
  calibrations: [{ name: 'a private item answers differently from a missing one', law: 'notebook as missing', history: { enumerated: 1 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'notebook receiving' ? { ...entry, value: { ...(entry.value as object), hiddenAsMissing: false } } : entry) }],
});
