/*
 * The shelf (#135): a short list of items in the owner's order, each named as
 * { sub, remoteId } like hopper membership. The compose list shows the owner's
 * own entries (sub OWN_SUBSCRIPTION) at its top; imported entries keep their
 * places when those are reordered or removed. Studio-private and synced through
 * GET/PUT /api/shelf, so other clients (Blygger Desktop) show the same list.
 * The server drops withdrawn and discarded items; nothing here writes to the
 * interaction log.
 */
import { useLiveQuery, inArray } from '@tanstack/react-db';
import { Link } from '@tanstack/react-router';
import { items, shelf, setShelf, SHELF_MAX, type ShelfEntry } from './data.ts';
import { OWN_SUBSCRIPTION } from '../own-subscription.ts';
import { itemTitle } from './plain-text.ts';
import { useState } from 'react';
import { Button, Failure } from './components.tsx';
import { toast } from './sheets.tsx';

function useAction() {
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  return {
    error,
    busy,
    run: async (fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setError(undefined);
      try {
        await fn();
      } catch (error) {
        setError(error);
      } finally {
        setBusy(false);
      }
    },
  };
}

export function useShelf(): ShelfEntry[] {
  return useLiveQuery({ query: (q) => q.from({ row: shelf }) }).data?.[0]?.entries ?? [];
}

const same = (a: ShelfEntry, b: ShelfEntry) => a.sub === b.sub && a.remoteId === b.remoteId;
export const ownEntry = (id: string): ShelfEntry => ({ sub: OWN_SUBSCRIPTION, remoteId: id });
/** The owner's own shelved item ids, in shelf order. */
export const ownIds = (entries: readonly ShelfEntry[]) => entries.filter((entry) => entry.sub === OWN_SUBSCRIPTION).map((entry) => entry.remoteId);

/** Add or remove one entry; the label and the toast say which. */
export async function toggleShelf(entries: readonly ShelfEntry[], entry: ShelfEntry) {
  const on = entries.some((other) => same(other, entry));
  if (!on && entries.length >= SHELF_MAX) throw new Error(`The shelf holds at most ${SHELF_MAX} items. Remove one first.`);
  await setShelf(on ? entries.filter((other) => !same(other, entry)) : [...entries, entry]);
  toast(on ? 'Removed from shelf' : 'Added to shelf', { tone: 'ok' });
}

export const shelfLabel = (entries: readonly ShelfEntry[], entry: ShelfEntry) =>
  (entries.some((other) => same(other, entry)) ? 'remove from shelf' : 'add to shelf');

/** Swap one own item with its neighbouring own item; other entries keep their places. */
function move(entries: readonly ShelfEntry[], id: string, by: -1 | 1) {
  const own = entries.flatMap((entry, at) => (entry.sub === OWN_SUBSCRIPTION ? [at] : []));
  const from = own.find((at) => entries[at].remoteId === id);
  const to = own[own.indexOf(from ?? -1) + by];
  if (from === undefined || to === undefined) return [...entries];
  const next = [...entries];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function Shelf() {
  const entries = useShelf();
  const ids = ownIds(entries);
  const action = useAction();
  // Captured values (ids) are part of the derived query's identity, so no deps array.
  const rows = useLiveQuery({ query: (q) => q.from({ item: items }).where(({ item }) => inArray(item.id, ids)) }).data ?? [];
  if (!ids.length) return null;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (
    <section className="shelf" aria-labelledby="shelf-h">
      <h3 className="shelf-h" id="shelf-h">shelf</h3>
      <ol className="list shelf-list">
        {ids.map((id, index) => {
          const item = byId.get(id);
          const title = item ? itemTitle(item.contentMd) || '(empty draft)' : '…';
          return (
            <li key={id} className="shelf-row" data-shelf-id={id}>
              <Link className="shelf-title" to="/edit/$id" params={{ id }}>
                {title}
              </Link>
              {item ? <span className="shelf-meta">{item.kind === 'thread' ? 'thread · ' : ''}{item.version === 0 ? 'draft' : `v${item.version}`}</span> : null}
              <span className="shelf-actions">
                <Button className="btn btn-ghost btn-mini" aria-label="move up" title="move up" disabled={action.busy || index === 0}
                  onClick={() => void action.run(() => setShelf(move(entries, id, -1)))}>↑</Button>
                <Button className="btn btn-ghost btn-mini" aria-label="move down" title="move down" disabled={action.busy || index === ids.length - 1}
                  onClick={() => void action.run(() => setShelf(move(entries, id, 1)))}>↓</Button>
                <Button className="btn btn-ghost btn-mini" aria-label="remove from shelf" title="remove from shelf" disabled={action.busy}
                  onClick={() => void action.run(() => toggleShelf(entries, ownEntry(id)))}>✕</Button>
              </span>
            </li>
          );
        })}
      </ol>
      <Failure error={action.error} />
    </section>
  );
}
