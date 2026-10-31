import type { Mention } from '../../sdk/dist/browser.js';
import type { Collection, InitialQueryBuilder, StandardSchemaAlias, UtilsRecord, RefsForContext, ExtractContext } from '@tanstack/react-db';
import { and, caseWhen, coalesce, count, eq, max, min, or, sum, toArray } from '@tanstack/react-db';

type Receipt = Pick<Mention, 'id' | 'target_item_id' | 'verified_at' | 'last_seen' | 'status' | 'hidden'>;
type Target = { id: string; responses: 'default' | 'show' | 'hide' };

/** Group receipts, join their target items and include ordered responses. */
export function mentionQuery<
  T extends Receipt, K extends string | number, U extends UtilsRecord, S extends StandardSchemaAlias, I extends object,
  O extends Target, OK extends string | number, OU extends UtilsRecord, OS extends StandardSchemaAlias, OI extends object,
>(q: InitialQueryBuilder, source: Collection<T, K, U, S, I>, owned: Collection<O, OK, OU, OS, OI>, defaultShowing: boolean) {
  const totals = q.from({ mention: source })
    .groupBy(({ mention }) => mention.target_item_id)
    .select(({ mention }) => ({
      target: mention.target_item_id,
      total: count(mention.id),
      visible: sum(caseWhen(and(eq(mention.status, 'verified'), eq(mention.hidden, false)), 1, 0)),
      verified: max(coalesce(mention.verified_at, '')),
    }));
  // Later last-seen values on older receipts must not outrank the newest
  // verified receipt. Resolve each tie only among the preceding key's winners.
  const recent = q.from({ verifiedGroup: totals })
    .innerJoin({ verifiedReceipt: source }, ({ verifiedGroup, verifiedReceipt }) => and(
      eq(verifiedGroup.target, verifiedReceipt.target_item_id), eq(verifiedGroup.verified, coalesce(verifiedReceipt.verified_at, '')),
    ))
    .groupBy(({ verifiedGroup }) => [verifiedGroup.target, verifiedGroup.total, verifiedGroup.visible, verifiedGroup.verified])
    .select(({ verifiedGroup, verifiedReceipt }) => ({
      target: verifiedGroup.target, total: verifiedGroup.total, visible: verifiedGroup.visible, verified: verifiedGroup.verified,
      seen: max(verifiedReceipt.last_seen),
    }));
  const latest = q.from({ seenGroup: recent })
    .innerJoin({ seenReceipt: source }, ({ seenGroup, seenReceipt }) => and(
      eq(seenGroup.target, seenReceipt.target_item_id), eq(seenGroup.verified, coalesce(seenReceipt.verified_at, '')), eq(seenGroup.seen, seenReceipt.last_seen),
    ))
    .groupBy(({ seenGroup }) => [seenGroup.target, seenGroup.total, seenGroup.visible, seenGroup.verified, seenGroup.seen])
    .select(({ seenGroup, seenReceipt }) => ({
      target: seenGroup.target, total: seenGroup.total, visible: seenGroup.visible, verified: seenGroup.verified, seen: seenGroup.seen,
      firstId: min(seenReceipt.id),
    }));
  const grouped = q.from({ latestGroup: latest })
    .leftJoin({ item: owned }, ({ latestGroup, item }) => eq(latestGroup.target, item.id))
    .orderBy(({ latestGroup }) => latestGroup.verified, 'desc')
    .orderBy(({ latestGroup }) => latestGroup.seen, 'desc')
    .orderBy(({ latestGroup }) => latestGroup.firstId, 'asc');
  const select = ({ latestGroup, item }: RefsForContext<ExtractContext<typeof grouped>>) => {
    const mode = coalesce(item.responses, 'default');
    const showing = or(eq(mode, 'show'), and(eq(mode, 'default'), defaultShowing));
    return {
      target: latestGroup.target, total: latestGroup.total, item, mode, showing,
      visible: caseWhen(showing, coalesce(latestGroup.visible, 0), 0),
      receipts: toArray(q.from({ response: source })
        .where(({ response }) => eq(response.target_item_id, latestGroup.target))
        .orderBy(({ response }) => response.verified_at, { direction: 'desc', nulls: 'last' })
        .orderBy(({ response }) => response.last_seen, 'desc')
        .orderBy(({ response }) => response.id, 'asc')),
    };
  };
  // RC1's bare-subquery guard cannot resolve generic collection refs. The
  // child query is wrapped in toArray(); preserve the exact projection type.
  return grouped.select<ReturnType<typeof select>>(refs => select(refs) as never);
}
