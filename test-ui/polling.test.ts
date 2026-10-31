import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
// Query Core installs interval timers only in browser runtimes.
vi.hoisted(() => vi.stubGlobal('window', {}));
import { focusManager, onlineManager, QueryObserver, type QueryFunction } from '@tanstack/query-core';
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/react-db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { queryClient, collectionPollingOptions, collectionRefreshOptions } from '../src/ui/query-client.ts';

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
  queryClient.mount();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  queryClient.unmount();
  queryClient.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.useRealTimers();
});
afterAll(() => vi.unstubAllGlobals());

function rows(queryKey: string, queryFn: QueryFunction<{ id: string; value: number }[]>, poll = true) {
  const collection = createCollection(queryCollectionOptions({
    ...(poll ? collectionPollingOptions : collectionRefreshOptions),
    queryKey: [queryKey], queryClient, queryFn, getKey: row => row.id,
  }));
  const subscription = collection.subscribeChanges(() => {});
  cleanups.push(() => collection.cleanup(), () => subscription.unsubscribe());
  return { collection, subscription };
}

it('opted-in collections poll while active, pause while hidden, and refresh on return or reconnect', async () => {
  const load = vi.fn(async () => [{ id: 'a', value: 1 }]);
  const { collection, subscription } = rows('items', load);
  await collection.preload();
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(load).toHaveBeenCalledTimes(2);

  focusManager.setFocused(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(load).toHaveBeenCalledTimes(2);
  focusManager.setFocused(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(3);

  onlineManager.setOnline(false);
  onlineManager.setOnline(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(4);

  subscription.unsubscribe();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(load).toHaveBeenCalledTimes(4);
});

it('canceled and failed interval reads retain cached rows and the next poll can recover', async () => {
  let mode: 'success' | 'hold' | 'fail' = 'success';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(() => release());
  const failure = new Error('read failed');
  const { collection } = rows('items', async ({ signal }) => {
    if (mode === 'hold') await gate;
    signal.throwIfAborted();
    if (mode === 'fail') throw failure;
    return [{ id: 'a', value: mode === 'hold' ? 99 : 1 }];
  });
  await collection.preload();
  mode = 'hold';
  await vi.advanceTimersByTimeAsync(15_000);
  await queryClient.cancelQueries({ queryKey: ['items'] });
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(collection.get('a')?.value).toBe(1);
  expect(queryClient.getQueryState(['items'])?.error).toBeNull();

  mode = 'fail';
  await vi.advanceTimersByTimeAsync(15_000);
  expect(queryClient.getQueryState(['items'])?.error).toBe(failure);
  expect(collection.get('a')?.value).toBe(1);

  mode = 'success';
  await vi.advanceTimersByTimeAsync(15_000);
  expect(queryClient.getQueryState(['items'])?.error).toBeNull();
  expect(collection.get('a')?.value).toBe(1);
});

it('on-demand route views poll while retained and stop after the last subscriber releases demand', async () => {
  const load = vi.fn(async () => [{ id: 'a', value: 1 }]);
  const source = createCollection(queryCollectionOptions({
    ...collectionPollingOptions,
    queryKey: ['reading'], queryClient, queryFn: load,
    syncMode: 'on-demand', getKey: row => row.id,
  }));
  const view = createLiveQueryCollection({
    // Match the reading page's short retention after its last subscriber leaves.
    gcTime: 1_000,
    query: q => q.from({ row: source }).where(({ row }) => eq(row.id, 'a')),
  });
  cleanups.push(() => source.cleanup(), () => view.cleanup());

  // Hover preloads the derived graph before a component subscribes.
  await view.preload();
  expect(load).toHaveBeenCalledTimes(1);
  expect(source.subscriberCount).toBeGreaterThan(0);
  const subscription = view.subscribeChanges(() => {});
  cleanups.push(() => subscription.unsubscribe());
  await vi.advanceTimersByTimeAsync(15_000);
  expect(load).toHaveBeenCalledTimes(2);

  subscription.unsubscribe();
  await vi.advanceTimersByTimeAsync(1_001);
  expect(source.subscriberCount).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(load).toHaveBeenCalledTimes(2);
});

it('collections and ordinary queries without polling opt-in do not acquire timers', async () => {
  const settingsLoad = vi.fn(async () => [{ id: 'settings', value: 1 }]);
  const { collection } = rows('settings', settingsLoad, false);
  const auxiliaryLoad = vi.fn(async () => 'cached');
  const observer = new QueryObserver(queryClient, {
    queryKey: ['auxiliary'], queryFn: auxiliaryLoad,
  });
  const unsubscribe = observer.subscribe(() => {});
  cleanups.push(unsubscribe);
  await Promise.all([
    collection.preload(),
    queryClient.fetchQuery({ queryKey: ['auxiliary'], queryFn: auxiliaryLoad }),
  ]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settingsLoad).toHaveBeenCalledTimes(1);
  expect(auxiliaryLoad).toHaveBeenCalledTimes(1);

  // Settings still refresh when the user returns, without a periodic timer.
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(settingsLoad).toHaveBeenCalledTimes(2);
  expect(auxiliaryLoad).toHaveBeenCalledTimes(1);
});
