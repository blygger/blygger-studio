// Inspect the explicit private DTO, including structured remote metadata.
const BODY = new Set(['contentMd', 'contentHtml']);

export function shapeRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeRecord);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => {
      if (BODY.has(key) && typeof field === 'string') return [key, `‹${field.length} characters, not shown›`];
      return [key, shapeRecord(field)];
    }),
  );
}

/** The few fields worth reading first, as label/value pairs; absent ones are left out. */
export function summary(record: Record<string, unknown>): [string, string][] {
  const published = record.published as Record<string, unknown> | null | undefined;
  const transclusions = Array.isArray(published?.transclusions)
    ? published.transclusions.length
    : Array.isArray(record.transclusions)
      ? record.transclusions.length
      : undefined;
  const rows: [string, unknown][] = [
    ['id', record.id ?? record.remoteId],
    ['kind', record.kind],
    ['version', record.version],
    ['state', record.status ?? record.state],
    ['content hash', published?.contentHash ?? record.contentHash],
    ['stub of', describe(record.stubOf)],
    ['forked from', describe(record.forkedFrom)],
    ['transclusions', transclusions],
  ];
  return rows.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]);
}

/** A reference in one line: origin + id + version, or a {url} target. */
function describe(ref: unknown) {
  if (!ref || typeof ref !== 'object') return undefined;
  const r = ref as Record<string, unknown>;
  if (typeof r.url === 'string') return r.url;
  return [r.origin, r.id, r.version !== undefined ? `v${r.version}` : undefined].filter(Boolean).join(' ');
}
