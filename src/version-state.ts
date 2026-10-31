import type { VersionRow } from './types.ts';

type KindRow = Pick<VersionRow, 'kind' | 'transclusions'>;

/** Owner history and eligibility retain the empty-text rule for unknown rows. */
export function versionState(row: Pick<VersionRow, 'kind' | 'content_md' | 'transclusions'>): 'fragment' | 'thread' | 'withdrawn' {
  return row.kind ?? (!row.content_md ? 'withdrawn' : authoredVersionKind(row));
}

/** Public pins historically used column presence, while some live-item paths
 * used truthiness. Preserve that caller's rule only for unresolved old rows. */
export function authoredVersionKind(row: KindRow | null | undefined, legacyThread?: boolean): 'fragment' | 'thread' {
  if (!row) return 'fragment';
  if (row.kind === 'fragment' || row.kind === 'thread') return row.kind;
  return (legacyThread ?? row.transclusions !== null) ? 'thread' : 'fragment';
}

/** Batched live-item reads share the old truthy-transclusions fallback.
 * Aliases are code-owned. Pin reads deliberately keep their nullness rule. */
export function authoredItemKindSql(previous: 'p' | 'v'): string {
  return `CASE WHEN i.kind = 'withdrawn' THEN
    CASE WHEN ${previous}.kind IN ('fragment','thread') THEN ${previous}.kind
      WHEN COALESCE(${previous}.transclusions, '') != '' THEN 'thread' ELSE 'fragment' END
    ELSE i.kind END`;
}
