import {
  createCollection,
  createLiveQueryCollection,
  createOptimisticAction,
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
  ListReadingResponses,
  UpdateItemData,
  Mention,
  MentionOutRow,
} from '../../sdk/dist/browser.js';
import {
  BlyggerApi,
  BlyggerApiError,
  createBlyggerClient,
  unwrap,
} from '../../sdk/dist/browser.js';
import { queryClient, collectionPollingOptions, collectionRefreshOptions } from './query-client.ts';
export { queryClient } from './query-client.ts';
import { readIfChanged, type CachedResponse, type Generation } from './revision-query.ts';
import type { ChangeDomain } from '../change-state.ts';
import { scoped } from './scoped.ts';
import { createPacedDraftAction } from './paced-write.ts';
import { sourceSchemas, readingResponseSchema } from './data-schemas.ts';
import { zGetItemResponse, zGetHopperResponse } from '../../sdk/dist/schemas.js';
import { planReadWrites, type ReadWrite, type UnreadWrite } from './read-state.ts';

export const apiBase = new URL(document.getElementById('studio-root')!.dataset.apiBase!, location.origin).href;
export const client = createBlyggerClient({ baseUrl: apiBase });
queryClient.mount();
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
    ({ signal }) => unwrap(BlyggerApi.getChanges({ client, signal })),
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
const readHopper = (id: string, preview: boolean, generation: Generation) =>
  ownerRead(['hoppers', id, preview], generation, zGetHopperResponse,
    (signal) => unwrap(BlyggerApi.getHopper({ client, path: { id }, query: preview ? { preview: 'true' } : {}, signal })));

async function pages<T>(
  read: (offset: number) => Promise<{ items: T[]; total: number }>,
) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await read(offset);
    rows.push(...page.items);
    if (offset + page.items.length >= page.total) return rows;
    if (!page.items.length)
      throw new Error('Collection ended before its declared total');
  }
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
    // Sorting the full list is local. Its route preload and sorted component
    // demand use the same complete server response and one Query observer.
    queryKey: (options) => {
      const ids = subsetIds({ meta: { loadSubsetOptions: options } });
      return ids ? ['items', [...new Set(ids)].sort()] : ['items'];
    },
    queryClient,
    getKey: (row) => row.id,
    queryFn: (context) =>
      cachedQuery(context, 'items', sourceSchemas.items.array(), async ({ signal }, generation) => {
        const ids = subsetIds(context);
        if (ids) {
          return existing(ids, async (id) => {
            const { authored_kind: _kind, media: _media, versions, published: _published, ...item } =
              await readItem(id, generation);
            const pins = versions
              .filter((version) => version.pinned)
              .map(({ version, kind }) => ({
                version,
                kind: kind === 'thread' ? 'thread' as const : 'fragment' as const,
              }));
            return { ...item, pins };
          });
        }
        return pages((offset) =>
          unwrap(
            BlyggerApi.listItems({
              client,
              query: { offset, limit: 100 },
              signal,
            }),
          ),
        );
      }),
    select: (response) => response.data,
    onUpdate: async ({ transaction, collection }) => {
      for (const mutation of transaction.mutations) {
        const changes = mutation.changes;
        const body: UpdateItemData['body'] = { expectedRevision: mutation.original.revision };
        for (const field of ['content_md', 'responses', 'highlight', 'stub_of'] as const)
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
    },
  }),
);
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
    },
  }),
);
export const subscriptions = createCollection(
  queryCollectionOptions({
    ...collectionPollingOptions,
    schema: sourceSchemas.subscriptions,
    id: 'subscriptions',
    syncMode: 'on-demand',
    queryKey: ['subscriptions'],
    queryClient,
    getKey: (row) => row.id,
    queryFn: (context) =>
      cachedQuery(context, 'subscriptions', sourceSchemas.subscriptions.array(), ({ signal }) =>
        pages((offset) =>
          unwrap(
            BlyggerApi.listSubscriptions({
              client,
              query: { offset, limit: 100 },
              signal,
            }),
          ),
        ),
      ),
    select: (response) => response.data,
    onUpdate: async ({ transaction, collection }) => {
      for (const { key, changes } of transaction.mutations)
        await unwrap(
          BlyggerApi.updateSubscription({
            client,
            path: { id: key as string },
            body: {
              ...(changes.title !== undefined ? { title: changes.title } : {}),
              ...(changes.in_blogroll !== undefined
                ? { in_blogroll: changes.in_blogroll }
                : {}),
              ...(changes.status !== undefined
                ? { paused: changes.status === 'paused' }
                : {}),
            },
          }),
        );
      await collection.utils.refetch({ throwOnError: true });
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
    },
  }),
);
export const hoppers = createCollection(
  queryCollectionOptions({
    ...collectionPollingOptions,
    schema: sourceSchemas.hoppers,
    id: 'hoppers',
    syncMode: 'on-demand',
    queryKey: (options) => {
      const ids = subsetIds({ meta: { loadSubsetOptions: options } });
      return ids ? ['hoppers', [...new Set(ids)].sort()] : ['hoppers'];
    },
    queryClient,
    getKey: (row) => row.id,
    queryFn: (context) =>
      cachedQuery(context, 'hoppers', sourceSchemas.hoppers.array(), async ({ signal }, generation) => {
        const ids = subsetIds(context);
        if (ids) return existing(ids, async (id) =>
          (await readHopper(id, true, generation)).hopper);
        return pages((offset) =>
          unwrap(
            BlyggerApi.listHoppers({
              client,
              query: { offset, limit: 100 },
              signal,
            }),
          ),
        );
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
            },
          }),
        );
      await collection.utils.refetch({ throwOnError: true });
    },
    onDelete: async ({ transaction, collection }) => {
      for (const { key } of transaction.mutations)
        await unwrap(
          BlyggerApi.deleteHopper({ client, path: { id: String(key) } }),
        );
      await collection.utils.refetch({ throwOnError: true });
    },
  }),
);
export const signals = createCollection(
  queryCollectionOptions({
    ...collectionPollingOptions,
    schema: sourceSchemas.signals,
    id: 'signals',
    syncMode: 'on-demand',
    queryKey: ['signals'],
    queryClient,
    getKey: (row) => JSON.stringify([row.subscription_id, row.remote_id]),
    queryFn: (context) =>
      cachedQuery(context, 'signals', sourceSchemas.signals.array(), ({ signal }) =>
        pages((offset) =>
          unwrap(
            BlyggerApi.listSignals({
              client,
              query: { offset, limit: 100 },
              signal,
            }),
          ),
        ),
      ),
    select: (response) => response.data,
  }),
);
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
          const { authored_kind, media, published_media, versions, published } =
            await readItem(id, generation);
          return { id, authored_kind, media, published_media, versions, published };
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
        content_md: command.text, kind: command.kind,
      } }));
      itemId = result.id;
    } else {
      if (!itemId) throw new Error('Save the draft before running this command');
      if (revision === undefined) throw new Error('Load the item revision before changing it');
      const path = { id: itemId }, condition = { expectedRevision: revision };
      switch (command.type) {
        case 'upload': result = await unwrap(BlyggerApi.uploadMedia({ client, body: { file: command.file, inline: command.inline ? 'true' : 'false', item_id: itemId, ...condition } })); break;
        case 'delete-media': result = await unwrap(BlyggerApi.deleteMedia({ client, path: { id: command.mediaId }, body: condition })); break;
        case 'refresh': result = await unwrap(BlyggerApi.refreshItem({ client, path, body: { ...condition, note: command.note } })); break;
        case 'save': result = await unwrap(BlyggerApi.updateItem({ client, path, body: { ...condition, content_md: command.text, kind: command.kind } })); break;
        case 'generate': result = await unwrap(BlyggerApi.generateItem({ client, path, body: { ...condition, scope: command.scope } })); break;
        case 'restore': {
          const restored = await unwrap(BlyggerApi.restoreItem({ client, path, body: { ...condition, version: command.version } }));
          revision = restored.revision;
          result = await unwrap(BlyggerApi.getItem({ client, path }));
          if (result.revision !== revision) throw new BlyggerApiError(409, { error: 'item changed after restore; reload and try again', code: 'revision-conflict', itemId, expectedRevision: revision });
          break;
        }
        case 'publish': result = await unwrap(BlyggerApi.publishItem({ client, path, body: { ...condition, note: command.note, note_generated: command.generated, ...(command.category !== undefined ? { change_category: command.category } : {}) } })); break;
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
    if (command.type === 'save' || command.type === 'update') await items.utils.writeUpsert(sourceSchemas.items.parse({ ...result, pins: items.get(itemId!)?.pins }));
    // A delete caller refreshes after leaving the editor, so its active view
    // does not report the discarded item as missing before navigation.
    if (command.type !== 'delete') await changed('item', 'items', 'reading');
    return result;
  });
}

export type Reading = Omit<z.infer<typeof sourceSchemas.reading>, 'view'>;
/**
 * Reading lenses (0.25.0). "threads" and "fragments" narrow a timeline and its
 * counts by kind; "background" and "smart" are placeholders for features that
 * are not built yet (procedural updates with ignyr; the AI-ranked feed).
 */
export const LENSES = ['all', 'threads', 'fragments', 'background', 'smart'] as const;
export type Lens = (typeof LENSES)[number];
export const lensKind = (lens: Lens | undefined): 'thread' | 'fragment' | undefined =>
  lens === 'threads' ? 'thread' : lens === 'fragments' ? 'fragment' : undefined;
/**
 * The cache key for one source under one lens: the source alone for the
 * unfiltered view (so every existing key is unchanged), `sub~kind` otherwise.
 */
export const readingKey = (sub: string, lens?: Lens) => {
  if (lens === 'background') return `${sub}~background`;
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
export const reading = createCollection(
  queryCollectionOptions({
    ...collectionPollingOptions,
    schema: sourceSchemas.reading,
    id: 'reading',
    syncMode: 'on-demand',
    queryKey: (options) => {
      if (!options.where) return ['reading'];
      const { view, offset, limit } = readingSubset({ meta: { loadSubsetOptions: options } });
      return ['reading', view, offset, limit];
    },
    queryClient,
    getKey: (row) => JSON.stringify([row.view, row.key]),
    queryFn: (context) =>
      cachedQuery(context, 'reading', readingResponseSchema, async ({ signal, meta }) => {
        const { view, offset, limit } = readingSubset({ meta });
        const [sub, filter] = view.split('~') as [string, 'thread' | 'fragment' | 'background' | undefined];
        const kind = filter === 'background' ? undefined : filter;
        const page = await unwrap(
          BlyggerApi.listReading({
            client,
            query: { sub, offset, limit, ...(kind ? { kind } : {}), ...(filter === 'background' ? { background: 'true' as const } : {}) },
            signal,
          }),
        );
        sourceSchemas.reading.array().parse(page.items.map((row, i) => ({
          ...row, view, rank: page.offset + i,
        })));
        return { ...page, view };
      },
      ),
    select: ({ data: page }: CachedResponse<ListReadingResponses[200] & { view: string }>) =>
      // Preserve the requested view even when the API falls back to "all";
      // the router reads `selected` and redirects that invalid subscription.
      page.items.map((row, i) => ({ ...row, view: page.view, rank: page.offset + i })),
  }),
);
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
export async function saveReadState(read: ReadWrite[], unread: UnreadWrite[]) {
  for (const step of planReadWrites(read, unread)) {
    if (step.op === 'put')
      await unwrap(BlyggerApi.markRead({ client, path: { sub: step.mark.sub, remoteId: step.mark.remote_id }, body: { version: step.mark.version } }));
    else if (step.op === 'delete')
      await unwrap(BlyggerApi.markUnread({ client, path: { sub: step.mark.sub, remoteId: step.mark.remote_id } }));
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
export const markReading = createOptimisticAction<{
  keys: string[];
  read: boolean;
  writes: { read: ReadWrite[]; unread: UnreadWrite[] };
}>({
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
          const { total, source_count } = await readHopper(id, true, generation);
          return { id, total, source_count };
        });
      }),
    select: (response) => response.data,
  }),
);
function hopperSubset(context: QueryFunctionContext) {
  const ids = subsetIds(context, 'hopper_id');
  if (!ids) throw new Error('Hopper rows require a hopper_id predicate');
  const { limit: requestedLimit, filters } = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
  const start = filters.find((filter) => filter.field.join('.') === 'rank' && filter.operator === 'gte');
  const end = filters.find((filter) => filter.field.join('.') === 'rank' && filter.operator === 'lt');
  const offset = typeof start?.value === 'number' ? start.value : 0;
  const limit = typeof end?.value === 'number' ? end.value - offset : requestedLimit;
  return { ids, offset, limit, preview: offset === 0 && limit !== undefined && limit <= 3 };
}
export const hopperEntries = createCollection(queryCollectionOptions({
  ...collectionPollingOptions,
  schema: sourceSchemas.hopperEntries,
  id: 'hopper-entries',
  syncMode: 'on-demand',
  queryKey: ['hopper-entries'],
  queryClient,
  getKey: (row) => JSON.stringify([row.hopper_id, row.item.subscription_id, row.item.remote_id]),
  queryFn: (context) => cachedQuery(context, 'hoppers', sourceSchemas.hopperEntries.array(), async (_context, generation) => {
    const { ids, offset, limit, preview } = hopperSubset(context);
    const groups = await existing(ids, async (id) => {
      const result = await readHopper(id, preview, generation);
      const entries = result.items.map((item, rank) => ({ hopper_id: id, rank, item }));
      return entries.slice(offset, limit === undefined ? undefined : offset + limit);
    });
    return groups.flat();
  }),
  select: (response) => response.data,
}));
// The API permits memberships whose imported body is not present yet. Keep
// those rows too, so the owner's hopper page can still display and remove them.
export const hopperMemberships = createCollection(queryCollectionOptions({
  ...collectionPollingOptions,
  schema: sourceSchemas.hopperMemberships,
  id: 'hopper-memberships', syncMode: 'on-demand', queryKey: ['hopper-memberships'], queryClient,
  getKey: (row) => JSON.stringify([row.hopper_id, row.subscription_id, row.remote_id]),
  queryFn: (context) => cachedQuery(context, 'hoppers', sourceSchemas.hopperMemberships.array(), async (_context, generation) => {
    const { ids, offset, limit, preview } = hopperSubset(context);
    const groups = await existing(ids, async (id) => {
      const result = await readHopper(id, preview, generation);
      return result.memberships.map((member, rank) => ({ ...member, rank }))
        .slice(offset, limit === undefined ? undefined : offset + limit);
    });
    return groups.flat();
  }),
  select: (response) => response.data,
}));
hoppers.createIndex((row) => row.id, { indexType: BasicIndex });
hopperStats.createIndex((row) => row.id, { indexType: BasicIndex });
hopperEntries.createIndex((row) => row.hopper_id, { indexType: BasicIndex });
hopperMemberships.createIndex((row) => row.hopper_id, { indexType: BasicIndex });
function hopperView(id: string, preview: boolean) {
  return createLiveQueryCollection({
    id: `hopper-${preview ? 'preview' : 'detail'}-view:${id}`,
    query: (q) => q.from({ hopper: hoppers })
      .innerJoin({ stats: hopperStats }, ({ hopper, stats }) => eq(hopper.id, stats.id))
      .where(({ hopper, stats }) => and(eq(hopper.id, id), eq(stats.id, id)))
      .select(({ hopper, stats }) => {
        const entries = q.from({ entry: hopperEntries })
          .where(({ entry }) => preview
            ? and(eq(entry.hopper_id, hopper.id), gte(entry.rank, 0), lt(entry.rank, 3))
            : eq(entry.hopper_id, hopper.id))
          .orderBy(({ entry }) => entry.rank);
        const memberships = q.from({ member: hopperMemberships })
          .where(({ member }) => preview
            ? and(eq(member.hopper_id, hopper.id), gte(member.rank, 0), lt(member.rank, 3))
            : eq(member.hopper_id, hopper.id))
          .orderBy(({ member }) => member.rank);
        return {
          hopper,
          total: stats.total,
          source_count: stats.source_count,
          items: toArray(entries.select(({ entry }) => entry.item)),
          memberships: toArray(memberships.select(({ member }) => member)),
        };
      }),
  });
}
export const hopperDetail = scoped((id) => hopperView(id, false));
export const hopperPreview = scoped((id) => hopperView(id, true));
// Cancel pending reads before invalidation, so earlier responses cannot replace
// acknowledged writes. Query collection mutation handlers own rollback on failure.
export async function changed(...keys: string[]) {
  // The old API names now refer to derived views. Invalidate their sources.
  const sourceKeys = [...new Set(keys.flatMap((key) => {
    switch (key) {
      case 'item':
      case 'items':
        return ['items', 'item-history'];
      case 'hopper':
      case 'hopper-preview':
      case 'hoppers':
        return ['hoppers', 'hopper-stats', 'hopper-entries', 'hopper-memberships'];
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
      queryClient.invalidateQueries({ queryKey, refetchType: 'active' }),
    ),
  );
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

async function mentions(direction: 'inbound' | 'outbound', signal: AbortSignal) {
  return pages((offset) => unwrap(BlyggerApi.listMentions({
    client, query: { direction, offset, limit: 100 }, signal,
  })));
}
// Mentions views poll every tick, as before, but an unchanged `mentions`
// counter (0032) answers from cache: before it, each tick re-read both lists
// in full and every row's source card.
export const inbound = createCollection(queryCollectionOptions({
  ...collectionPollingOptions,
  schema: sourceSchemas.inbound,
  id: 'mentions-in', syncMode: 'on-demand', queryKey: ['mentions-in'], queryClient,
  getKey: (row) => row.id,
  queryFn: (context) =>
    cachedQuery(context, 'mentions', sourceSchemas.inbound.array(), async ({ signal }) =>
      (await mentions('inbound', signal)).filter((row): row is Mention => 'hidden' in row)),
  select: (response) => response.data,
}));
inbound.createIndex(row => row.target_item_id, { indexType: BasicIndex });
export const outbound = createCollection(queryCollectionOptions({
  ...collectionPollingOptions,
  schema: sourceSchemas.outbound,
  id: 'mentions-out', syncMode: 'on-demand', queryKey: ['mentions-out'], queryClient,
  getKey: (row) => row.id,
  queryFn: (context) =>
    cachedQuery(context, 'mentions', sourceSchemas.outbound.array(), async ({ signal }) =>
      (await mentions('outbound', signal)).filter((row): row is MentionOutRow => 'next_attempt_at' in row)),
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
  items: createLiveQueryCollection((q) => q.from({ item: items })),
  settings: createLiveQueryCollection((q) => q.from({ setting: settings })),
  updates: createLiveQueryCollection((q) => q.from({ update: updates })),
  subscriptions: createLiveQueryCollection((q) => q.from({ subscription: subscriptions })),
  hoppers: createLiveQueryCollection((q) => q.from({ hopper: hoppers })),
  signals: createLiveQueryCollection((q) => q.from({ signal: signals })),
  inbound: createLiveQueryCollection((q) => q.from({ mention: inbound })),
  outbound: createLiveQueryCollection((q) => q.from({ mention: outbound })),
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

export async function preloadMentions() {
  await Promise.all([
    preloadView(listViews.inbound),
    preloadView(listViews.outbound),
    preloadView(listViews.items),
  ]);
  await Promise.all(listViews.inbound.toArray.map((mention) => preloadView(mentionSource(mention.id))));
}
