/*
 * The shelf (#135): a short list of the owner's own items, in the owner's
 * order, at the top of the compose list. Studio-private and synced through
 * GET/PUT /api/shelf, so other clients (Blygger Desktop) show the same list.
 * The server drops withdrawn and discarded items; nothing here writes to the
 * interaction log.
 */
import { useLiveQuery, inArray } from '@tanstack/react-db';
import { Link } from '@tanstack/react-router';
import { items, shelf, setShelf, SHELF_MAX } from './data.ts';
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

export function useShelf(): string[] {
  return useLiveQuery({ query: (q) => q.from({ row: shelf }) }).data?.[0]?.itemIds ?? [];
}

/** Add or remove one item; the label and the toast say which. */
export async function toggleShelf(ids: readonly string[], id: string) {
  const on = ids.includes(id);
  if (!on && ids.length >= SHELF_MAX) throw new Error(`The shelf holds at most ${SHELF_MAX} items. Remove one first.`);
  await setShelf(on ? ids.filter((other) => other !== id) : [...ids, id]);
  toast(on ? 'Removed from shelf' : 'Added to shelf', { tone: 'ok' });
}

export const shelfLabel = (ids: readonly string[], id: string) => (ids.includes(id) ? 'remove from shelf' : 'add to shelf');

function move(ids: readonly string[], index: number, by: -1 | 1) {
  const next = [...ids];
  [next[index], next[index + by]] = [next[index + by], next[index]];
  return next;
}

export function Shelf() {
  const ids = useShelf();
  const action = useAction();
  const rows = useLiveQuery((q) => q.from({ item: items }).where(({ item }) => inArray(item.id, ids)), [ids.join(',')]).data ?? [];
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
                  onClick={() => void action.run(() => setShelf(move(ids, index, -1)))}>↑</Button>
                <Button className="btn btn-ghost btn-mini" aria-label="move down" title="move down" disabled={action.busy || index === ids.length - 1}
                  onClick={() => void action.run(() => setShelf(move(ids, index, 1)))}>↓</Button>
                <Button className="btn btn-ghost btn-mini" aria-label="remove from shelf" title="remove from shelf" disabled={action.busy}
                  onClick={() => void action.run(() => toggleShelf(ids, id))}>✕</Button>
              </span>
            </li>
          );
        })}
      </ol>
      <Failure error={action.error} />
    </section>
  );
}
