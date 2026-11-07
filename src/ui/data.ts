import {
  createCollection,
  createLiveQueryCollection,
  and,
  gte,
  lt,
  eq,
  toArray,
  BasicIndex,
} from '@tanstack/react-db';
import {
  parseLoadSubsetOptions,
  queryCollectionOptions,
} from '@tanstack/query-db-collection';
import type { QueryFunctionContext } from '@tanstack/query-core';
import { z } from 'zod';
import type {
  UpdateItemData,
  Mention,
  OutboundMention,
  ListMentionsData,
  ListMentionGroupsData,
} from '../../sdk/dist/browser.js';
import {
  BlyggerApi,
  BlyggerApiError,
  createBlyggerClient,
  unwrap,
} from '../../sdk/dist/browser.js';
import { queryClient, collectionPollingOptions, collectionRefreshOptions } from './query-client.ts';
export { queryClient } from './query-client.ts';
import { readIfChanged, domainRevision, type Generation } from './revision-query.ts';
import type { ChangeDomain } from '../change-state.ts';
import { scoped } from './scoped.ts';
import { createPacedDraftAction } from './paced-write.ts';
import { createRowMutation } from './mutation.ts';
import { sourceSchemas } from './data-schemas.ts';
import { zGetItemResponse, zGetHopperResponse, zListItemsResponse, zListSubscriptionsResponse, zListHoppersResponse, zListSignalsResponse, zListReadingResponse, zListItemVersionsResponse, zListHopperMembershipsResponse, zListMentionsResponse, zListMentionGroupsResponse, zListThumbsResponse, zListInteractionsResponse, zListBrowseResponse } from '../../sdk/dist/schemas.js';
import { sequenceParts } from './sequence-order.ts';
import { readCursorWindow, type ApiPage } from './cursor-query.ts';
import { planReadWrites, type ReadWrite, type UnreadWrite } from './read-state.ts';
import { createReadBatchFetch } from './read-batch.ts';
import { createReadFlight } from './read-flight.ts';

export const apiBase = new URL(document.getElementById('studio-root')!.dataset.apiBase!, location.origin).href;
const transport = createReadBatchFetch(apiBase);
export const client = createBlyggerClient({ baseUrl: apiBase, fetch: (input, init) => {
  const request = new Request(input, init);
  if (['GET', 'HEAD'].includes(request.method)) return transport(request);
  // Mutation refreshes must not reuse checks started before a write.
  changesFlight.invalidate();
  return transport(request).finally(() => changesFlight.invalidate());
} });
const changesFlight = createReadFlight(signal => unwrap(BlyggerApi.getChanges({ client, signal })));
queryClient.mount();
/** Query resolves paused refetches without observing the server. */
function assertNotPaused(queryKey: readonly unknown[]) {
  if (queryClient.getQueryCache().findAll({ queryKey, type: 'active' })
    .some(query => query.state.fetchStatus === 'paused'))
    throw new Error('Could not confirm changes while offline. Reconnect and try again.');
}
function cachedQuery<S extends z.ZodType>(
  context: QueryFunctionContext,
  domain: ChangeDomain | readonly ChangeDomain[],
  schema: S,
  load: (context: QueryFunctionContext, generation: Generation) => Promise<z.input<S>>,
) {
  // Parse before caching the revision envelope. A bad response must remain a
  // failed read, so retry can fetch it again without waiting for a new revision.
  return readIfChanged(
    context,
    domain,
    ({ signal }) => changesFlight.read(signal),
    async (context, generation) => schema.parse(await load(context, generation)),
  );
}

// Source collections keep separate rows and optimistic overlays, but projections
// of one owner response share a validated read for the same server generation.
function ownerRead<S extends z.ZodType>(
  key: readonly unknown[],
  generation: Generation,
  schema: S,
  load: (signal: AbortSignal) => Promise<z.input<S>>,
) {
  return queryClient.fetchQuery({
    queryKey: ['owner-read', ...key, generation.epoch, generation.revision],
    queryFn: async ({ signal }) => schema.parse(await load(signal)),
  });
}
const readItem = (id: string, generation: Generation) =>
  ownerRead(['items', id], generation, zGetItemResponse,
    (signal) => unwrap(BlyggerApi.getItem({ client, path: { id }, signal })));
const readHopper = (id: string, generation: Generation) =>
  ownerRead(['hoppers', id], generation, zGetHopperResponse,
    (signal) => unwrap(BlyggerApi.getHopper({ client, path: { id }, signal })));

const cursorPageSchemas: Record<string, { parse(value: unknown): unknown }> = {
  items: zListItemsResponse, subscriptions: zListSubscriptionsResponse, hoppers: zListHoppersResponse,
  signals: zListSignalsResponse, reading: zListReadingResponse, 'item-versions': zListItemVersionsResponse,
  'hopper-memberships': zListHopperMembershipsResponse, 'mentions-in': zListMentionsResponse,
  'mentions-out': zListMentionsResponse, thumbs: zListThumbsResponse, interactions: zListInteractionsResponse, browse: zListBrowseResponse,
  'mention-groups': zListMentionGroupsResponse,
};
function cursorRows<T>(context: QueryFunctionContext, resource: string, generation: Generation, sequence: readonly unknown[], read: (cursor: string | undefined, signal: AbortSignal) => Promise<ApiPage<T>>, window: { offset?: number; limit?: number } = {}) {
  const schema = cursorPageSchemas[resource];
  if (!schema) throw new Error('Missing cursor page schema');
  return readCursorWindow({ queryClient, queryKey: [resource, 'pages', ...sequence, generation], window, signal: context.signal, read, validate: page => { schema.parse(page); } });
}
/** A bounded demand must use the server order. Full demands can sort locally. */
function pageWindow(context: QueryFunctionContext, order: readonly [string, 'asc' | 'desc'][]) {
  const { limit, sorts } = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
  if (limit !== undefined && sorts.some((sort, i) => sort.field.join('.') !== order[i]?.[0] || sort.direction !== order[i]?.[1] || sort.compare || sort.stringSort && sort.stringSort !== 'lexical'))
    throw new Error('Unsupported bounded collection order');
  const offset = (context.meta?.loadSubsetOptions as { offset?: number } | undefined)?.offset;
  return { limit, offset };
}
/** IDs requested by point queries or joins. Unfiltered list queries return null. */
function subsetIds(context: Pick<QueryFunctionContext, 'meta'>, field = 'id'): string[] | null {
  const subset = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
  const filter = subset.filters.find((filter) => filter.field.join('.') === field &&
    (filter.operator === 'eq' || filter.operator === 'in'));
  if (!filter) return null;
  let values: unknown[];
  if (filter.value instanceof Set) values = [...filter.value];
  else if (Array.isArray(filter.value)) values = filter.value;
  else values = [filter.value];
  if (!values.every((value): value is string => typeof value === 'string'))
    throw new Error(`Expected string ${field} predicates`);
  return values;
}

async function existing<T>(ids: string[], read: (id: string) => Promise<T>): Promise<Awaited<T>[]> {
  const rows = await Promise.all(ids.map(async (id) => {
    try {
      return await read(id);
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error && error.statusCode === 404)
        return null;
      throw error;
    }
  }));
  return rows.filter((row): row is Awaited<T> => row !== null);
}

export const items = createCollection(
  queryCollectionOptions({
    ...collectionPollingOptions,
    schema: sourceSchemas.items,
    id: 'items',
    syncMode: 'on-demand',
    queryKey: ['items', 'rows'],
    queryClient,
    getKey: (row) => row.id,
    queryFn: (context) =>
      cachedQuery(context, 'items', sourceSchemas.items.array(), async ({ signal }, generation) => {
        const ids = subsetIds(context);
        if (ids) {
          return existing(ids, async (id) => {
            const { media: _media, publishedMedia: _publishedMedia, published: _published, ...item } = await readItem(id, generation);
            return item;
          });
        }
        const { filters } = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
        const query: { status?: 'draft' | 'public' | 'withdrawn'; dirty?: 'true' | 'false'; version?: number; id?: string; updated?: string } = {};
        for (const filter of filters) {
          const field = filter.field.join('.');
          if (filter.operator !== 'eq') throw new Error('Unsupported item predicate');
          if (field === 'orderKey' && typeof filter.value === 'string') [query.updated, query.id] = sequenceParts(filter.value, ['desc', 'desc']);
          else if (field === 'status' && ['draft', 'public', 'withdrawn'].includes(String(filter.value))) query.status = filter.value as typeof query.status;
          else if (field === 'dirty' && typeof filter.value === 'boolean') query.dirty = filter.value ? 'true' : 'false';
          else if (field === 'version' && typeof filter.value === 'number' && Number.isSafeInteger(filter.value) && filter.value >= 0) query.version = filter.value;
          else throw new Error('Unsupported item predicate');
        }
        return cursorRows(context, 'items', generation, [query], (cursor, signal) => unwrap(BlyggerApi.listItems({ client, query: { ...query, cursor, limit: 25 }, signal })), pageWindow(context, [['orderKey', 'asc']]));
      }),
    select: (response) => response.data,
    onUpdate: async ({ transaction, collection }) => {
      for (const mutation of transaction.mutations) {
        const changes = mutation.changes;
        const body: UpdateItemData['body'] = { expectedRevision: mutation.original.revision };
        for (const field of ["contentMd", 'responses', 'highlight', "stubOf"] as const)
          if (field in changes)
            Object.assign(body, { [field]: changes[field] });
        if (changes.kind === 'fragment' || changes.kind === 'thread')
          body.kind = changes.kind;
        await unwrap(
          BlyggerApi.updateItem({
            client,
            path: { id: mutation.key as string },
            body,
          }),
        );
      }
      await collection.utils.refetch({ throwOnError: true });
      assertNotPaused(['items']);
    },
    onDelete: async ({ transaction, collection }) => {
      for (const mutation of transaction.mutations)
        await unwrap(
          BlyggerApi.deleteItem({
            client,
            path: { id: mutation.key as string },
            body: { expectedRevision: mutation.original.revision },
          }),
        );
      await collection.utils.refetch({ throwOnError: true });
      assertNotPaused(['items']);
    },
  }),
);
export const itemSummary = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.itemSummary, id: 'item-summary', syncMode: 'on-demand',
  queryKey: ['item-summary', 'rows'], queryClient, getKey: row => row.key,
  queryFn: context => cachedQuery(context, 'items', sourceSchemas.itemSummary.array(), async ({ signal }) => [{ ...await unwrap(BlyggerApi.getItemSummary({ client, signal })), key: 'items' as const }]),
  select: response => response.data,
}));
export const itemVersions = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.itemVersions, id: 'item-versions', syncMode: 'on-demand',
  queryKey: ['item-versions', 'rows'], queryClient, getKey: row => JSON.stringify([row.itemId, row.version]),
  queryFn: context => cachedQuery(context, 'items', sourceSchemas.itemVersions.array(), async (_context, generation) => {
    const ids = subsetIds(context, 'itemId');
    if (!ids) throw new Error('Version history requires an itemId predicate');
    const { filters } = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
    let version: number | undefined;
    for (const filter of filters) {
      if (filter.field.join('.') === 'itemId') continue;
      if (filter.field.join('.') !== 'version' || filter.operator !== 'eq' || typeof filter.value !== 'number') throw new Error('Unsupported history predicate');
      version = filter.value;
    }
    return (await existing(ids, id => cursorRows(context, 'item-versions', generation, [id, version ?? null], (cursor, signal) => unwrap(BlyggerApi.listItemVersions({ client, path: { id }, query: { cursor, version, limit: 25 }, signal })), pageWindow(context, [['version', 'desc']])))).flat();
  }), select: response => response.data,
}));
export const settings = createCollection(
  queryCollectionOptions({
    ...collectionRefreshOptions,
    schema: sourceSchemas.settings,
    id: 'settings',
    syncMode: 'on-demand',
    queryKey: ['settings'],
    queryClient,
    getKey: (row) => row.key,
    queryFn: (context) =>
      cachedQuery(context, 'settings', sourceSchemas.settings.array(), async ({ signal }) => [
        {
          ...(await unwrap(BlyggerApi.getSettings({ client, signal }))),
          key: 'settings' as const,
        },
      ],
      ),
    select: (response) => response.data,
    onUpdate: async ({ transaction, collection }) => {
      for (const { changes } of transaction.mutations) {
        const { key: _key, ...body } = changes;
        await unwrap(BlyggerApi.updateSettings({ client, body }));
      }
      await collection.utils.refetch({ throwOnError: true });
      assertNotPaused(['settings']);
    },
  }),
);
export const subscriptions = createCollection(
  queryCollectionOptions({
    ...collectionPollingOptions,
    schema: sourceSchemas.subscriptions,
    id: 'subscriptions',
    syncMode: 'on-demand',
    queryKey: ['subscriptions', 'rows'],
    queryClient,
    getKey: (row) => row.id,
    queryFn: (context) => cachedQuery(context, 'subscriptions', sourceSchemas.subscriptions.array(), async (_context, generation) => {
      const ids = subsetIds(context);
      if (ids) return existing(ids, id => unwrap(BlyggerApi.getSubscription({ client, path: { id }, signal: context.signal })));
      return cursorRows(context, 'subscriptions', generation, [], (cursor, signal) => unwrap(BlyggerApi.listSubscriptions({ client, query: { cursor, limit: 100 }, signal })), pageWindow(context, [['created', 'asc'], ['id', 'asc']]));
    }),
    select: (response) => response.data,
    onUpdate: async ({ transaction, collection }) => {
      for (const { key, changes } of transaction.mutations)
        await unwrap(
          BlyggerApi.updateSubscription({
            client,
            path: { id: key as string },
            body: {
              ...(changes.title !== undefined ? { title: changes.title } : {}),
              ...(changes.inBlogroll !== undefined
                ? { inBlogroll: changes.inBlogroll }
                : {}),
              ...(changes.status !== undefined
                ? { paused: changes.status === 'paused' }
                : {}),
            },
          }),
        );
      await collection.utils.refetch({ throwOnError: true });
      assertNotPaused(['subscriptions']);
    },
    onDelete: async ({ transaction, collection }) => {
      for (const { key } of transaction.mutations)
        await unwrap(
          BlyggerApi.deleteSubscription({
            client,
            path: { id: key as string },
          }),
        );
      await collection.utils.refetch({ throwOnError: true });
      assertNotPaused(['subscriptions']);
      await changed('hoppers', 'signals', 'reading');
    },
  }),
);
export const hoppers = createCollection(
  queryCollectionOptions({
    ...collectionPollingOptions,
    schema: sourceSchemas.hoppers,
    id: 'hoppers',
    syncMode: 'on-demand',
    queryKey: ['hoppers', 'rows'],
    queryClient,
    getKey: (row) => row.id,
    queryFn: (context) =>
      cachedQuery(context, 'hoppers', sourceSchemas.hoppers.array(), async ({ signal }, generation) => {
        const ids = subsetIds(context);
        if (ids) return existing(ids, async (id) =>
          (await readHopper(id, generation)).hopper);
        return cursorRows(context, 'hoppers', generation, [], (cursor, signal) => unwrap(BlyggerApi.listHoppers({ client, query: { cursor, limit: 100 }, signal })), pageWindow(context, [['created', 'asc'], ['id', 'asc']]));
      }),
    select: (response) => response.data,
    onUpdate: async ({ transaction, collection }) => {
      for (const { key, changes } of transaction.mutations)
        await unwrap(
          BlyggerApi.updateHopper({
            client,
            path: { id: String(key) },
            body: {
              ...(changes.name !== undefined ? { name: changes.name } : {}),
              ...(changes.public !== undefined
                ? { public: changes.public }
                : {}),
              ...(changes.description !== undefined ? { description: changes.description ?? '' } : {}),
            },
          }),
        );
      await collection.utils.refetch({ throwOnError: true });
      assertNotPaused(['hoppers']);
    },
    onDelete: async ({ transaction, collection }) => {
      for (const { key } of transaction.mutations)
        await unwrap(
          BlyggerApi.deleteHopper({ client, path: { id: String(key) } }),
        );
      await collection.utils.refetch({ throwOnError: true });
      assertNotPaused(['hoppers']);
    },
  }),
);
export const signals = createCollection(
  queryCollectionOptions({
    ...collectionPollingOptions,
    schema: sourceSchemas.signals,
    id: 'signals',
    syncMode: 'on-demand',
    queryKey: ['signals', 'rows'],
    queryClient,
    getKey: (row) => JSON.stringify([row.subscriptionId, row.remoteId]),
    queryFn: (context) => cachedQuery(context, 'signals', sourceSchemas.signals.array(), async (_context, generation) =>
      cursorRows(context, 'signals', generation, [], (cursor, signal) => unwrap(BlyggerApi.listSignals({ client, query: { cursor, limit: 100 }, signal })), pageWindow(context, [['at', 'desc'], ['subscriptionId', 'asc'], ['remoteId', 'asc']]))),
    select: (response) => response.data,
  }),
);
/** Update the actual signal row immediately; retain it until read-back confirms it. */
export const setThumb = createRowMutation<{
  sub: string; remoteId: string; thumb: 1 | -1 | null;
}>({
  scope: ({ sub, remoteId }) => JSON.stringify([sub, remoteId]),
  onMutate: ({ sub, remoteId, thumb }) => {
    const key = JSON.stringify([sub, remoteId]);
    if (thumb === null) {
      if (signals.has(key)) signals.delete(key);
    } else if (signals.has(key)) {
      signals.update(key, row => { row.thumb = thumb; });
    } else {
      signals.insert({ subscriptionId: sub, remoteId, thumb, at: new Date().toISOString() });
    }
  },
  mutationFn: async ({ sub, remoteId, thumb }) => {
    const path = { sub, remoteId };
    if (thumb === null) await unwrap(BlyggerApi.deleteSignal({ client, path }));
    else await unwrap(BlyggerApi.setSignal({ client, path, body: { thumb } }));
    await signals.utils.refetch({ throwOnError: true });
    assertNotPaused(['signals']);
    await changed('thumbs', 'interactions', 'signal-summary');
  },
});
export const thumbs = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.thumbs, id: 'thumbs', syncMode: 'on-demand', queryKey: ['thumbs', 'rows'], queryClient,
  getKey: row => JSON.stringify([row.subscriptionId, row.origin, row.remoteId]),
  queryFn: context => cachedQuery(context, ['signals', 'reading', 'subscriptions'], sourceSchemas.thumbs.array(), async (_context, generation) => {
    const { filters } = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
    let thumb: '1' | '-1' | undefined;
    const query: { at?: string; subscriptionId?: string; remoteId?: string } = {};
    for (const filter of filters) {
      if (filter.operator === 'eq' && filter.field.join('.') === 'orderKey' && typeof filter.value === 'string') { [query.at, query.subscriptionId, query.remoteId] = sequenceParts(filter.value, ['desc', 'asc', 'asc']); continue; }
      if (filter.field.join('.') !== 'thumb' || filter.operator !== 'eq' || filter.value !== 1 && filter.value !== -1) throw new Error('Unsupported thumb predicate');
      thumb = String(filter.value) as '1' | '-1';
    }
    return cursorRows(context, 'thumbs', generation, [thumb ?? null, query], (cursor, signal) => unwrap(BlyggerApi.listThumbs({ client, query: { ...query, thumb, cursor, limit: 50 }, signal })), pageWindow(context, [['orderKey', 'asc']]));
  }), select: response => response.data,
}));
export const interactions = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.interactions, id: 'interactions', syncMode: 'on-demand', queryKey: ['interactions', 'rows'], queryClient, getKey: row => row.id,
  queryFn: context => cachedQuery(context, ['interactions', 'reading', 'subscriptions'], sourceSchemas.interactions.array(), async (_context, generation) => {
    const { filters } = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
    const query: { at?: string; id?: number } = {};
    for (const filter of filters) {
      if (filter.field.join('.') !== 'orderKey' || filter.operator !== 'eq' || typeof filter.value !== 'string') throw new Error('Unsupported activity predicate');
      const [at, id] = sequenceParts(filter.value, ['desc', 'desc']); query.at = at; query.id = Number.parseInt(id, 16);
    }
    return cursorRows(context, 'interactions', generation, [query], (cursor, signal) => unwrap(BlyggerApi.listInteractions({ client, query: { ...query, cursor, limit: 50 }, signal })), pageWindow(context, [['orderKey', 'asc']]));
  }),
  select: response => response.data,
}));
export const browse = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.browse, id: 'browse', syncMode: 'on-demand', queryKey: ['browse', 'rows'], queryClient, getKey: row => row.id,
  queryFn: context => cachedQuery(context, 'browse', sourceSchemas.browse.array(), async (_context, generation) => {
    const { filters } = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
    let id: number | undefined;
    for (const filter of filters) {
      if (filter.field.join('.') !== 'id' || filter.operator !== 'eq' || typeof filter.value !== 'number') throw new Error('Unsupported browse predicate');
      id = filter.value;
    }
    return cursorRows(context, 'browse', generation, [id ?? null], (cursor, signal) => unwrap(BlyggerApi.listBrowse({ client, query: { id, cursor, limit: 100 }, signal })), pageWindow(context, [['id', 'desc']]));
  }),
  select: response => response.data,
}));
export const signalSummary = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.signalSummary, id: 'signal-summary', syncMode: 'on-demand', queryKey: ['signal-summary', 'rows'], queryClient, getKey: row => row.key,
  queryFn: context => cachedQuery(context, ['signals', 'interactions'], sourceSchemas.signalSummary.array(), async ({ signal }) => [{ ...await unwrap(BlyggerApi.getSignalSummary({ client, signal })), key: 'signals' as const }]),
  select: response => response.data,
}));
export const staleThreads = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.staleThreads, id: 'stale-threads', syncMode: 'on-demand',
  queryKey: ['stale-threads', 'rows'], queryClient, getKey: row => row.id,
  queryFn: context => cachedQuery(context, ['items', 'reading', 'subscriptions'], sourceSchemas.staleThreads.array(), async ({ signal }) =>
    (await unwrap(BlyggerApi.listStaleThreads({ client, signal }))).items.map((row, rank) => ({ ...row, rank }))),
  select: response => response.data,
}));
/** Only stale queue IDs demand item labels; no archive subscription is needed. */
export const staleThreadItemsView = createLiveQueryCollection(q => q.from({ freshness: staleThreads })
  .leftJoin({ item: items }, ({ freshness, item }) => eq(freshness.id, item.id))
  .orderBy(({ freshness }) => freshness.rank)
  .select(({ freshness, item }) => ({ freshness, item })));
export type Detail = z.infer<typeof zGetItemResponse>;

// History and attachments have their own row type. Mutable item fields live
// only in `items`; editor details join them rather than keeping a second copy.
export const itemHistory = createCollection(
  queryCollectionOptions({
    ...collectionPollingOptions,
    schema: sourceSchemas.itemHistory,
    id: 'item-history',
    syncMode: 'on-demand',
    queryKey: ['item-history'],
    queryClient,
    getKey: (row) => row.id,
    queryFn: (context) =>
      cachedQuery(context, 'items', sourceSchemas.itemHistory.array(), async (_context, generation) => {
        const ids = subsetIds(context);
        if (!ids) throw new Error('Item history requires an id predicate');
        return existing(ids, async (id) => {
          const { media, publishedMedia, published } =
            await readItem(id, generation);
          return { id, media, publishedMedia, published };
        });
      }),
    select: (response) => response.data,
  }),
);
export const itemDetail = scoped((id) => createLiveQueryCollection({
  id: `item-view:${id}`,
  query: (q) => q.from({ item: items })
    .innerJoin({ history: itemHistory }, ({ item, history }) => eq(item.id, history.id))
    .where(({ item, history }) => and(eq(item.id, id), eq(history.id, id)))
    .fn.select(({ item, history }): Detail => ({ ...item, ...history })),
}));
export function createDraftAction(id?: string, observedRevision?: number) {
  let itemId = id, revision = observedRevision;
  return createPacedDraftAction(async command => {
    let result;
    if (command.type === 'save' && !itemId) {
      result = await unwrap(BlyggerApi.createItem({ client, body: {
        contentMd: command.text, kind: command.kind,
      } }));
      itemId = result.id;
    } else {
      if (!itemId) throw new Error('Save the draft before running this command');
      if (revision === undefined) throw new Error('Load the item revision before changing it');
      const path = { id: itemId }, condition = { expectedRevision: revision };
      switch (command.type) {
        case 'upload': result = await unwrap(BlyggerApi.uploadMedia({ client, body: { file: command.file, inline: command.inline ? 'true' : 'false', itemId: itemId, ...condition } })); break;
        case 'delete-media': result = await unwrap(BlyggerApi.deleteMedia({ client, path: { id: command.mediaId }, body: condition })); break;
        case 'refresh': result = await unwrap(BlyggerApi.refreshItem({ client, path, body: { ...condition, note: command.note } })); break;
        case 'save': result = await unwrap(BlyggerApi.updateItem({ client, path, body: { ...condition, contentMd: command.text, kind: command.kind } })); break;
        case 'generate': result = await unwrap(BlyggerApi.generateItem({ client, path, body: { ...condition, scope: command.scope } })); break;
        case 'restore': {
          const restored = await unwrap(BlyggerApi.restoreItem({ client, path, body: { ...condition, version: command.version } }));
          revision = restored.revision;
          result = await unwrap(BlyggerApi.getItem({ client, path }));
          if (result.revision !== revision) throw new BlyggerApiError(409, { message: 'item changed after restore; reload and try again', code: 'revision-conflict', details: { itemId, expectedRevision: revision } });
          break;
        }
        case 'publish': result = await unwrap(BlyggerApi.publishItem({ client, path, body: { ...condition, note: command.note, noteGenerated: command.generated, ...(command.category !== undefined ? { changeCategory: command.category } : {}) } })); break;
        case 'delete': result = await unwrap(BlyggerApi.deleteItem({ client, path, body: condition })); break;
        case 'withdraw': result = await unwrap(BlyggerApi.withdrawItem({ client, path, body: condition })); break;
        case 'pin': result = await unwrap(BlyggerApi.pinItem({ client, path: { ...path, version: command.version }, body: condition })); break;
        case 'draft-note': result = await unwrap(BlyggerApi.draftNote({ client, path, body: condition })); break;
        case 'classify': result = await unwrap(BlyggerApi.classifyChange({ client, path, body: condition })); break;
        case 'update': result = await unwrap(BlyggerApi.updateItem({ client, path, body: { ...command.changes, ...condition } })); break;
      }
    }
    if (result && 'revision' in result && typeof result.revision === 'number') revision = result.revision;
    // Finish read-back inside the handler, before another command starts.
    if (command.type === 'save' || command.type === 'update') {
      const item = result as { version: number };
      // A new draft has no version pins. For an unloaded published item, read
      // the summaries rather than replacing unknown pins with an empty list.
      const pins = item.version === 0 ? [] : items.get(itemId!)?.pins
        ?? (await unwrap(BlyggerApi.getItem({ client, path: { id: itemId! } }))).pins;
      await items.utils.writeUpsert(sourceSchemas.items.parse({ ...result, pins }));
    }
    if (command.type === 'save' || command.type === 'update') {
      // The response confirms the row. Count refresh failures stay visible
      // in collection health without reporting this save as failed.
      await Promise.allSettled([changed('item-summary')]);
    } else if (command.type === 'delete') {
      // Keep the row until refreshes finish, then apply the confirmed deletion
      // even if a secondary read failed. The caller can navigate immediately.
      await Promise.allSettled([changed('item-summary', 'reading')]);
      await items.utils.writeDelete(itemId!);
    } else if (command.type === 'draft-note' || command.type === 'classify') {
      // These commands return suggestions without changing the item.
    } else {
      await changed('item', 'items', 'reading');
    }
    return result;
  }, command => {
    if (!itemId || !items.has(itemId)) return;
    if (command.type === 'save') items.update(itemId, row => {
      row.contentMd = command.text;
      if (command.kind) row.kind = command.kind;
    });
    else if (command.type === 'update') items.update(itemId, row => {
      Object.assign(row, command.changes);
    });
  });
}

export type Reading = Omit<z.infer<typeof sourceSchemas.reading>, 'view'>;
/**
 * Reading lenses (0.25.0). "threads" and "fragments" narrow a timeline and its
 * counts by kind; "background" and "smart" are placeholders for features that
 * are not built yet (procedural updates with ignyr; the AI-ranked feed).
 */
export const LENSES = ['all', 'threads', 'fragments', 'mentions', 'background', 'smart'] as const;
export type Lens = (typeof LENSES)[number];
export const lensKind = (lens: Lens | undefined): 'thread' | 'fragment' | undefined =>
  lens === 'threads' ? 'thread' : lens === 'fragments' ? 'fragment' : undefined;
/**
 * The cache key for one source under one lens: the source alone for the
 * unfiltered view (so every existing key is unchanged), `sub~kind` otherwise.
 */
export const readingKey = (sub: string, lens?: Lens) => {
  if (lens === 'background' || lens === 'mentions') return `${sub}~${lens}`;
  const kind = lensKind(lens);
  return kind ? `${sub}~${kind}` : sub;
};
function readingSubset(context: Pick<QueryFunctionContext, 'meta'>): { view: string; offset: number; limit: number } {
  const subset = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
  const view = subset.filters.find((filter) => filter.field.join('.') === 'view' && filter.operator === 'eq')?.value;
  if (typeof view !== 'string') throw new Error('Reading requires a view predicate');
  const start = subset.filters.find((filter) => filter.field.join('.') === 'rank' && filter.operator === 'gte');
  const end = subset.filters.find((filter) => filter.field.join('.') === 'rank' && filter.operator === 'lt');
  const offset = typeof start?.value === 'number' ? start.value : 0;
  const limit = typeof end?.value === 'number' ? end.value - offset : 25;
  return { view, offset, limit };
}
// Rank belongs to a feed/lens position, not to the underlying item. A row can
// occupy different ranks in "all" and a subscription without either overwriting it.
export const reading = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.reading, id: 'reading', syncMode: 'on-demand',
  queryKey: ['reading', 'rows'], queryClient,
  getKey: row => JSON.stringify([row.view, row.key]),
  queryFn: context => cachedQuery(context, readingDomains(readingSubset(context).view), sourceSchemas.reading.array(), async (_context, generation) => {
    const { view, offset, limit } = readingSubset(context);
    const query = readingQuery(view);
    const rows = await cursorRows(context, 'reading', generation, [view], (cursor, signal) => unwrap(BlyggerApi.listReading({ client, query: { ...query, cursor, limit: 50 }, signal })), { offset, limit });
    return rows.map((row, i) => ({ ...row, view, rank: offset + i }));
  }),
  select: response => response.data,
}));
function readingDomains(view: string): readonly ChangeDomain[] {
  return view.startsWith('hopper:') ? ['reading', 'subscriptions', 'hoppers'] : ['reading', 'subscriptions'];
}
export function readingQuery(view: string) {
  const [sub, filter] = view.split('~') as [string, 'thread' | 'fragment' | 'background' | 'mentions' | undefined];
  return { ...(sub.startsWith('hopper:') ? { hopper: sub.slice('hopper:'.length) } : { sub }), ...(filter === 'background' ? { background: 'true' as const } : filter === 'mentions' ? { mentions: 'true' as const } : filter ? { kind: filter } : {}) };
}
export const readingSummaries = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.readingSummaries, id: 'reading-summary', syncMode: 'on-demand',
  queryKey: ['reading-summary', 'rows'], queryClient, getKey: row => row.view,
  queryFn: context => cachedQuery(context, ['reading', 'subscriptions', 'hoppers'], sourceSchemas.readingSummaries.array(), async ({ signal }) => {
    const views = subsetIds(context, 'view');
    if (!views) throw new Error('Reading summary requires a view predicate');
    return Promise.all(views.map(async view => {
      const summary = await unwrap(BlyggerApi.getReadingSummary({ client, query: readingQuery(view), signal }));
      const total = summary.selected === 'all' ? summary.counts.all : summary.selected === 'own' ? summary.counts.own : summary.counts.subscriptions[summary.selected] ?? 0;
      return { ...summary, view, total };
    }));
  }),
  select: response => response.data,
}));
export async function readAllReading(view: string, signal = new AbortController().signal) {
  const changes = await unwrap(BlyggerApi.getChanges({ client, signal }));
  const generation = { epoch: changes.epoch, revision: domainRevision(changes, readingDomains(view)) };
  return readCursorWindow<z.infer<typeof zListReadingResponse>['items'][number]>({ queryClient, queryKey: ['reading', 'pages', view, generation], signal, window: {}, validate: page => { zListReadingResponse.parse(page); },
    read: (cursor, signal) => unwrap(BlyggerApi.listReading({ client, query: { ...readingQuery(view), cursor, limit: 50 }, signal })),
  });
}
export const readingSummaryView = scoped(view => createLiveQueryCollection({
  id: `reading-summary:${view}`, query: q => q.from({ summary: readingSummaries }).where(({ summary }) => eq(summary.view, view)),
}));
function readingViewCollection(sub: string, offset: number) {
  return createLiveQueryCollection({
    id: `reading-view:${sub}:${offset}`,
    gcTime: 1_000,
    query: (q) =>
      q
        .from({ entry: reading })
        .where(({ entry }) =>
          and(eq(entry.view, sub), gte(entry.rank, offset), lt(entry.rank, offset + 25)),
        )
        .orderBy(({ entry }) => entry.rank, 'asc'),
  });
}
const readingViews = scoped((key) => {
  const [sub, offset] = JSON.parse(key) as [string, number];
  return readingViewCollection(sub, offset);
});
export const readingView = (sub: string, offset: number) =>
  readingViews(JSON.stringify([sub, offset]));

/** Store read marks: one PUT or DELETE for a single row, else batches of ≤ 500. */
async function saveReadState(read: ReadWrite[], unread: UnreadWrite[]) {
  for (const step of planReadWrites(read, unread)) {
    if (step.op === 'put')
      await unwrap(BlyggerApi.markRead({ client, path: { sub: step.mark.sub, remoteId: step.mark.remoteId }, body: { version: step.mark.version } }));
    else if (step.op === 'delete')
      await unwrap(BlyggerApi.markUnread({ client, path: { sub: step.mark.sub, remoteId: step.mark.remoteId } }));
    else if (step.op === 'read') await unwrap(BlyggerApi.markReadBatch({ client, body: { items: step.items } }));
    else await unwrap(BlyggerApi.markUnreadBatch({ client, body: { items: step.items } }));
  }
}
/**
 * Mark reading entries read or unread, by entry key. Every loaded reading row
 * for those entries changes at once, under every view and lens that holds
 * one; the writes may also cover rows not loaded here ("mark all read" pages
 * through the view). If a write fails the optimistic change is rolled back.
 * The reading source refetches before the transaction settles, so nothing
 * flickers back.
 */
export const markReading = createRowMutation<{
  keys: string[];
  read: boolean;
  writes: { read: ReadWrite[]; unread: UnreadWrite[] };
}>({
  // Batches can overlap with one-entry marks. Keep their server order while
  // every loaded row still reflects the latest intent immediately.
  scope: () => 'reading-state',
  onMutate: ({ keys, read }) => {
    const wanted = new Set(keys);
    const present = reading.toArray
      .filter((row) => wanted.has(row.key) && row.imported)
      .map((row) => JSON.stringify([row.view, row.key]));
    if (!present.length) return;
    reading.update(present, (drafts) => {
      for (const draft of drafts)
        if (draft.imported) draft.imported.readVersion = read ? draft.imported.version : null;
    });
  },
  mutationFn: async ({ writes }) => {
    await saveReadState(writes.read, writes.unread);
    await changed('reading');
  },
});

export const hopperStats = createCollection(
  queryCollectionOptions({
    ...collectionPollingOptions,
    schema: sourceSchemas.hopperStats,
    id: 'hopper-stats',
    syncMode: 'on-demand',
    queryKey: ['hopper-stats'],
    queryClient,
    getKey: (row) => row.id,
    queryFn: (context) =>
      cachedQuery(context, 'hoppers', sourceSchemas.hopperStats.array(), async (_context, generation) => {
        const ids = subsetIds(context);
        if (!ids) throw new Error('Hopper stats require an id predicate');
        return existing(ids, async (id) => {
          const { total, sourceCount } = await readHopper(id, generation);
          return { id, total, sourceCount };
        });
      }),
    select: (response) => response.data,
  }),
);
function hopperSubset(context: QueryFunctionContext) {
  const ids = subsetIds(context, "hopperId");
  if (!ids) throw new Error('Hopper rows require a hopper_id predicate');
  const { limit: requestedLimit, filters } = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
  const start = filters.find((filter) => filter.field.join('.') === 'rank' && filter.operator === 'gte');
  const end = filters.find((filter) => filter.field.join('.') === 'rank' && filter.operator === 'lt');
  const exact = filters.find(filter => filter.field.join('.') === 'rank' && filter.operator === 'eq');
  const offset = typeof exact?.value === 'number' ? exact.value : typeof start?.value === 'number' ? start.value : (context.meta?.loadSubsetOptions as { offset?: number } | undefined)?.offset ?? 0;
  const limit = typeof exact?.value === 'number' ? 1 : typeof end?.value === 'number' ? end.value - offset : requestedLimit;
  return { ids, offset, limit };
}
async function readMembers(context: QueryFunctionContext, generation: Generation, id: string, window: { offset: number; limit?: number }) {
  return cursorRows(context, 'hopper-memberships', generation, [id], (cursor, signal) => unwrap(BlyggerApi.listHopperMemberships({ client, path: { id }, query: { cursor, limit: Math.min(100, window.limit ?? 100) }, signal })), window);
}
export const hopperEntries = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.hopperEntries, id: 'hopper-entries', syncMode: 'on-demand',
  queryKey: ['hopper-entries', 'rows'], queryClient,
  getKey: row => JSON.stringify([row.hopperId, row.item.subscriptionId, row.item.remoteId]),
  queryFn: context => cachedQuery(context, ['hoppers', 'reading', 'subscriptions'], sourceSchemas.hopperEntries.array(), async (_context, generation) => {
    const { ids, offset, limit } = hopperSubset(context);
    return (await existing(ids, async id => (await readMembers(context, generation, id, { offset, limit }))
      .flatMap((row, index) => row.item ? [{ hopperId: id, rank: offset + index, item: row.item }] : []))).flat();
  }), select: response => response.data,
}));
export const hopperMemberships = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.hopperMemberships, id: 'hopper-memberships', syncMode: 'on-demand',
  queryKey: ['hopper-memberships', 'rows'], queryClient,
  getKey: row => JSON.stringify([row.hopperId, row.subscriptionId, row.remoteId]),
  queryFn: context => cachedQuery(context, ['hoppers', 'reading', 'subscriptions'], sourceSchemas.hopperMemberships.array(), async (_context, generation) => {
    const { ids, offset, limit } = hopperSubset(context);
    return (await existing(ids, async id => (await readMembers(context, generation, id, { offset, limit }))
      .map((row, index) => ({ ...row, rank: offset + index })))).flat();
  }), select: response => response.data,
}));
hoppers.createIndex((row) => row.id, { indexType: BasicIndex });
hopperStats.createIndex((row) => row.id, { indexType: BasicIndex });
hopperEntries.createIndex((row) => row.hopperId, { indexType: BasicIndex });
hopperMemberships.createIndex((row) => row.hopperId, { indexType: BasicIndex });
function hopperView(id: string, preview: boolean) {
  return createLiveQueryCollection({
    id: `hopper-${preview ? 'preview' : 'detail'}-view:${id}`,
    query: (q) => q.from({ hopper: hoppers })
      .innerJoin({ stats: hopperStats }, ({ hopper, stats }) => eq(hopper.id, stats.id))
      .where(({ hopper, stats }) => and(eq(hopper.id, id), eq(stats.id, id)))
      .select(({ hopper, stats }) => {
        const entries = q.from({ entry: hopperEntries })
          .where(({ entry }) => and(eq(entry.hopperId, hopper.id), gte(entry.rank, 0), lt(entry.rank, preview ? 3 : 25)))
          .orderBy(({ entry }) => entry.rank);
        const memberships = q.from({ member: hopperMemberships })
          .where(({ member }) => and(eq(member.hopperId, hopper.id), gte(member.rank, 0), lt(member.rank, preview ? 3 : 25)))
          .orderBy(({ member }) => member.rank);
        return {
          hopper,
          total: stats.total,
          sourceCount: stats.sourceCount,
          items: toArray(entries.select(({ entry }) => entry.item)),
          memberships: toArray(memberships.select(({ member }) => member)),
        };
      }),
  });
}
export const hopperInfo = scoped(id => createLiveQueryCollection({
  id: `hopper-info:${id}`, query: q => q.from({ hopper: hoppers })
    .innerJoin({ stats: hopperStats }, ({ hopper, stats }) => eq(hopper.id, stats.id))
    .where(({ hopper, stats }) => and(eq(hopper.id, id), eq(stats.id, id)))
    .select(({ hopper, stats }) => ({ hopper, total: stats.total, sourceCount: stats.sourceCount })),
}));
export const hopperDetail = scoped((id) => hopperView(id, false));
export const hopperPreview = scoped((id) => hopperView(id, true));
// Persistence handlers refresh only projections their confirmed write cannot
// supply. UI callbacks must not invalidate after a mutation has settled.
// Cancel older reads first so they cannot replace acknowledged writes.
export async function changed(...keys: string[]) {
  // The old API names now refer to derived views. Invalidate their sources.
  const sourceKeys = [...new Set(keys.flatMap((key) => {
    switch (key) {
      case 'item':
      case 'items':
        return ['items', 'item-history', 'item-versions', 'item-summary', 'stale-threads'];
      case 'hopper':
      case 'hopper-preview':
      case 'hoppers':
        return ['hoppers', 'hopper-stats', 'hopper-entries', 'hopper-memberships', 'reading', 'reading-summary'];
      case 'reading': return ['reading', 'reading-summary', 'stale-threads'];
      case 'signals': return ['signals', 'thumbs', 'interactions', 'signal-summary'];
      default:
        return [key];
    }
  }))];
  // Reader intent caches must not survive a local write to their sources.
  const readKeys = sourceKeys.map(key => [key]);
  if (sourceKeys.some(key => ['items', 'reading', 'subscriptions'].includes(key)))
    readKeys.push(['owner-read', 'reading-article']);
  await Promise.all([
    ...readKeys.map((queryKey) => queryClient.cancelQueries({ queryKey })),
    ...['items', 'hoppers'].filter((key) => sourceKeys.includes(key))
      .map((key) => queryClient.cancelQueries({ queryKey: ['owner-read', key] })),
  ]);
  await Promise.all(
    readKeys.map((queryKey) =>
      queryClient.invalidateQueries({ queryKey, refetchType: 'active' }, { throwOnError: true }),
    ),
  );
  for (const queryKey of readKeys) assertNotPaused(queryKey);
}

export const updates = createCollection(
  queryCollectionOptions({
    ...collectionPollingOptions,
    schema: sourceSchemas.updates,
    id: 'updates',
    syncMode: 'on-demand',
    queryKey: ['updates'],
    queryClient,
    getKey: (row) => row.key,
    queryFn: async ({ signal }) => sourceSchemas.updates.array().parse([
      {
        ...(await unwrap(BlyggerApi.getUpdateState({ client, signal }))),
        key: 'updates',
      },
    ]),
  }),
);

export const authorizations = createCollection(queryCollectionOptions({
  ...collectionRefreshOptions,
  schema: sourceSchemas.authorizations,
  id: 'authorizations', syncMode: 'on-demand', queryKey: ['authorizations'], queryClient, getKey: row => row.id,
  queryFn: async ({ signal }) => {
    const { items } = await unwrap(BlyggerApi.listAuthorizations({ client, signal }));
    return sourceSchemas.authorizations.array().parse(items);
  },
}));

async function mentions(context: QueryFunctionContext, direction: 'inbound' | 'outbound', generation: Generation) {
  const resource = direction === 'inbound' ? 'mentions-in' : 'mentions-out';
  const { filters } = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
  const query: NonNullable<ListMentionsData['query']> = { direction };
  const targets = direction === 'inbound' ? subsetIds(context, 'targetItemId') : null;
  for (const filter of filters) {
    const field = filter.field.join('.');
    if (direction === 'inbound' && field === 'targetItemId' && ['eq', 'in'].includes(filter.operator)) continue;
    if (field !== 'orderKey' || filter.operator !== 'eq' || typeof filter.value !== 'string') throw new Error('Unsupported mention predicate');
    if (direction === 'outbound') [query.created, query.id] = sequenceParts(filter.value, ['desc', 'asc']);
    else {
      const [nullFlag, verifiedAt, lastSeen, id] = sequenceParts(filter.value, ['asc', 'desc', 'desc', 'asc']);
      const flag = Number.parseInt(nullFlag, 16);
      if (flag === 1) query.verifiedAtNull = 'true';
      else if (flag === 0) query.verifiedAt = verifiedAt;
      else throw new Error('Invalid mention sequence boundary');
      Object.assign(query, { lastSeen, id });
    }
  }
  const window = pageWindow(context, [['orderKey', 'asc']]);
  return (await Promise.all((targets ?? [undefined]).map(targetItemId => {
    const selected = { ...query, ...(targetItemId === undefined ? {} : { targetItemId }) };
    return cursorRows(context, resource, generation, [selected], (cursor, signal) => unwrap(BlyggerApi.listMentions({ client,
      query: { ...selected, cursor, limit: direction === 'inbound' ? 11 : 26 }, signal })), window);
  }))).flat();
}
// Mentions views poll every tick, as before, but an unchanged `mentions`
// counter (0032) answers from cache: before it, each tick re-read both lists
// in full and every row's source card.
export const inbound = createCollection(queryCollectionOptions({
  ...collectionPollingOptions,
  schema: sourceSchemas.inbound,
  id: 'mentions-in', syncMode: 'on-demand', queryKey: ['mentions-in', 'rows'], queryClient,
  getKey: (row) => row.id,
  queryFn: (context) =>
    cachedQuery(context, 'mentions', sourceSchemas.inbound.array(), async (_context, generation) =>
      (await mentions(context, 'inbound', generation)).filter((row): row is Mention => 'hidden' in row)),
  select: (response) => response.data,
  onUpdate: async ({ transaction, collection }) => {
    for (const mutation of transaction.mutations) {
      const result = await unwrap(BlyggerApi.updateMention({ client,
        path: { id: String(mutation.key) }, body: { hidden: mutation.modified.hidden },
      }));
      await collection.utils.writeUpdate({ id: String(mutation.key), hidden: result.hidden });
    }
    // The receipt is confirmed; refresh the server aggregate before settling.
    // A failed secondary read stays visible through collection health.
    await Promise.allSettled([changed('mention-groups')]);
  },
}));
inbound.createIndex(row => row.targetItemId, { indexType: BasicIndex });
export const mentionGroups = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.mentionGroups, id: 'mention-groups', syncMode: 'on-demand',
  queryKey: ['mention-groups', 'rows'], queryClient, getKey: row => row.targetItemId,
  queryFn: context => cachedQuery(context, 'mentions', sourceSchemas.mentionGroups.array(), async (_context, generation) => {
    const { filters } = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
    const ids = subsetIds(context, 'targetItemId');
    const query: NonNullable<ListMentionGroupsData['query']> = {};
    for (const filter of filters) {
      const field = filter.field.join('.');
      if (field === 'targetItemId' && ['eq', 'in'].includes(filter.operator)) continue;
      if (field !== 'orderKey' || filter.operator !== 'eq' || typeof filter.value !== 'string') throw new Error('Unsupported mention group predicate');
      [query.verifiedAt, query.lastSeen, query.firstId] = sequenceParts(filter.value, ['desc', 'desc', 'asc']);
    }
    const window = pageWindow(context, [['orderKey', 'asc']]);
    return (await Promise.all((ids ?? [undefined]).map(targetItemId => {
      const selected = { ...query, ...(targetItemId === undefined ? {} : { targetItemId }) };
      return cursorRows(context, 'mention-groups', generation, [selected], (cursor, signal) =>
        unwrap(BlyggerApi.listMentionGroups({ client, query: { ...selected, cursor, limit: 11 }, signal })), window);
    }))).flat();
  }), select: response => response.data,
}));
export const mentionSummary = createCollection(queryCollectionOptions({
  ...collectionPollingOptions, schema: sourceSchemas.mentionSummary, id: 'mention-summary', syncMode: 'on-demand',
  queryKey: ['mention-summary', 'rows'], queryClient, getKey: row => row.key,
  queryFn: context => cachedQuery(context, 'mentions', sourceSchemas.mentionSummary.array(), async ({ signal }) =>
    [{ ...await unwrap(BlyggerApi.getMentionSummary({ client, signal })), key: 'mentions' as const }]),
  select: response => response.data,
}));
export const mentionGroupItemsView = createLiveQueryCollection(q => q.from({ group: mentionGroups })
  .leftJoin({ item: items }, ({ group, item }) => eq(group.targetItemId, item.id))
  .orderBy(({ group }) => group.orderKey, { direction: 'asc', stringSort: 'lexical' }).limit(11)
  .select(({ group, item }) => ({ group, item })));
export const outbound = createCollection(queryCollectionOptions({
  ...collectionPollingOptions,
  schema: sourceSchemas.outbound,
  id: 'mentions-out', syncMode: 'on-demand', queryKey: ['mentions-out', 'rows'], queryClient,
  getKey: (row) => row.id,
  queryFn: (context) =>
    cachedQuery(context, 'mentions', sourceSchemas.outbound.array(), async (_context, generation) =>
      (await mentions(context, 'outbound', generation)).filter((row): row is OutboundMention => "nextAttemptAt" in row)),
  select: (response) => response.data,
}));
// A source card joins the mention to the Reading tables: whether an import of
// the source is held (stub back) and whether its origin is subscribed. Both
// tables advance `reading`, so the card follows mentions + reading.
export const mentionSources = createCollection(queryCollectionOptions({
  ...collectionPollingOptions,
  schema: sourceSchemas.mentionSources,
  id: 'mention-sources', syncMode: 'on-demand', queryKey: ['mention-sources'], queryClient,
  getKey: (row) => row.key,
  queryFn: (context) =>
    cachedQuery(context, ['mentions', 'reading'], sourceSchemas.mentionSources.array(), async ({ signal }) => {
      const ids = subsetIds(context, 'key');
      if (!ids) throw new Error('Mention sources require a key predicate');
      return existing(ids, async (id) => ({
        ...(await unwrap(BlyggerApi.getMentionSource({ client, path: { id }, signal }))),
        key: id,
      }));
    }),
  select: (response) => response.data,
}));
export const mentionSource = scoped((id) => createLiveQueryCollection({
  id: `mention-source-view:${id}`,
  query: (q) => q.from({ source: mentionSources }).where(({ source }) => eq(source.key, id)),
}));

// On-demand source.preload() is a no-op. Route loaders preload these stable
// live queries so their unfiltered demand is fetched before the page mounts.
export const listViews = {
  items: createLiveQueryCollection((q) => q.from({ item: items }).orderBy(({ item }) => item.orderKey, { direction: 'asc', stringSort: 'lexical' }).limit(25)),
  settings: createLiveQueryCollection((q) => q.from({ setting: settings })),
  updates: createLiveQueryCollection((q) => q.from({ update: updates })),
  subscriptions: createLiveQueryCollection((q) => q.from({ subscription: subscriptions })),
  hoppers: createLiveQueryCollection((q) => q.from({ hopper: hoppers })),
  signals: createLiveQueryCollection((q) => q.from({ signal: signals })),
  signalTotals: createLiveQueryCollection(q => q.from({ summary: signalSummary }).findOne()),
  likedThumbs: createLiveQueryCollection(q => q.from({ thumb: thumbs }).where(({ thumb }) => eq(thumb.thumb, 1))
    .orderBy(({ thumb }) => thumb.orderKey, { direction: 'asc', stringSort: 'lexical' }).limit(51)),
  mentionSummary: createLiveQueryCollection(q => q.from({ summary: mentionSummary }).findOne()),
  authorizations: createLiveQueryCollection((q) => q.from({ authorization: authorizations })),
};

/** A failed derived graph must restart after the Query cache recovers. */
export async function preloadView(view: {
  status: string;
  reload(): Promise<unknown>;
  preload(): Promise<unknown>;
}) {
  if (view.status === 'error') return view.reload();
  return view.preload();
}

export async function preloadDetail(view: Parameters<typeof preloadView>[0] & {
  readonly toArray: unknown[];
}, resource: string) {
  await preloadView(view);
  if (!view.toArray.length) throw new Error(`${resource} not found`);
}

/** Preload the same derived previews that hopper cards render. */
export async function preloadHopperPreviews() {
  await preloadView(listViews.hoppers);
  await Promise.all(listViews.hoppers.toArray.map((hopper) => preloadView(hopperPreview(hopper.id))));
}

export async function preloadHopperInfos() {
  await preloadView(listViews.hoppers);
  await Promise.all(listViews.hoppers.toArray.map(hopper => preloadView(hopperInfo(hopper.id))));
}

const hopperManagementMembers = scoped(id => createLiveQueryCollection(q => q.from({ member: hopperMemberships })
  .where(({ member }) => eq(member.hopperId, id)).orderBy(({ member }) => member.rank, 'asc').limit(26)));
export async function preloadHopperManagement(id: string) {
  await Promise.all([preloadDetail(hopperInfo(id), 'Hopper'), preloadView(hopperManagementMembers(id))]);
}

export const preloadStaleThreads = () => preloadView(staleThreadItemsView);
export const preloadSignals = () => Promise.all([preloadView(listViews.signalTotals), preloadView(listViews.likedThumbs)]);

export async function preloadMentions() {
  await Promise.all([
    preloadView(mentionGroupItemsView),
    preloadView(listViews.mentionSummary),
  ]);
}
