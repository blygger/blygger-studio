/*
 * Read state in the studio (migration 0026). Pure rules here, so the
 * test-ui suite can pin them without a browser; reading.tsx owns the UI.
 *
 *   unread   — never read, or cleared ("mark unread")
 *   updated  — read, but a newer version has arrived since
 *   read     — read at the version held here
 *
 * Own items have no read state (null).
 */
import { READ_BATCH_MAX } from '../importer/read-limits.ts';

export type ReadStatus = 'unread' | 'updated' | 'read';

export function readStatus(imported: { readVersion: number | null; version: number } | undefined): ReadStatus | null {
  if (!imported) return null;
  if (imported.readVersion === null) return 'unread';
  return imported.readVersion < imported.version ? 'updated' : 'read';
}
/** Whether opening or "mark read" would change anything. */
export const needsRead = (status: ReadStatus | null) => status === 'unread' || status === 'updated';

/**
 * A read the studio sends. No `read_at`: the studio acts online, so its reads
 * always apply. The API's `read_at` is for offline queues (Blygger Desktop),
 * and a browser clock behind the server's would let a "mark unread" followed
 * by opening the post drop the read silently.
 */
export interface ReadWrite {
  sub: string;
  remoteId: string;
  version: number;
}
export interface UnreadWrite {
  sub: string;
  remoteId: string;
}
type Markable = { imported?: { subscriptionId: string; remoteId: string; version: number } | undefined };

/** The writes that mark `entries` read (at the version held here) or unread; own entries are skipped. */
export function readWrites(entries: Markable[], read: boolean): { read: ReadWrite[]; unread: UnreadWrite[] } {
  const refs = entries.flatMap((entry) => (entry.imported ? [entry.imported] : []));
  const ref = (imported: NonNullable<Markable['imported']>) => ({ sub: imported.subscriptionId, remoteId: imported.remoteId });
  return read
    ? { read: refs.map((imported) => ({ ...ref(imported), version: imported.version })), unread: [] }
    : { read: [], unread: refs.map(ref) };
}
export type ReadOp =
  | { op: 'put'; mark: ReadWrite }
  | { op: 'delete'; mark: UnreadWrite }
  | { op: 'read'; items: ReadWrite[] }
  | { op: 'unread'; items: UnreadWrite[] };

/**
 * The requests that store a set of marks: one PUT or DELETE for a single row
 * (what opening an entry sends), otherwise batches of at most READ_BATCH_MAX.
 */
export function planReadWrites(read: ReadWrite[], unread: UnreadWrite[], max = READ_BATCH_MAX): ReadOp[] {
  if (read.length === 1 && !unread.length) return [{ op: 'put', mark: read[0] }];
  if (unread.length === 1 && !read.length) return [{ op: 'delete', mark: unread[0] }];
  const ops: ReadOp[] = [];
  for (let i = 0; i < read.length; i += max) ops.push({ op: 'read', items: read.slice(i, i + max) });
  for (let i = 0; i < unread.length; i += max) ops.push({ op: 'unread', items: unread.slice(i, i + max) });
  return ops;
}
