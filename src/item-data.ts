import { authoredVersionKind } from './version-state.ts';
import { ItemRowSchema, MediaRowSchema, VersionRowSchema } from "./contract/schemas.ts";

// Column names come only from row contracts. Native result columns avoid both
// aggregate history limits and expansion from SQL JSON escaping.
const columns = [...new Set([ItemRowSchema, MediaRowSchema, VersionRowSchema].flatMap((schema) => Object.keys(schema.shape)))];
const projection = (schema: { shape: Record<string, unknown> }, alias: string) =>
  columns.map((name) => `${name in schema.shape ? `${alias}.${name}` : "NULL"} AS ${name}`).join(", ");
const detailSql = `WITH selected AS (SELECT * FROM items WHERE id = ?)
  SELECT 'item' AS type, ${projection(ItemRowSchema, "i")}, 0 AS section, 0 AS version_order, '' AS created_order FROM selected i
  UNION ALL SELECT 'media', ${projection(MediaRowSchema, "m")}, 1, 0, m.created FROM media m WHERE m.item_id IN (SELECT id FROM selected)
  UNION ALL SELECT 'version', ${projection(VersionRowSchema, "v")}, 2, v.version, '' FROM versions v WHERE v.item_id IN (SELECT id FROM selected)
  UNION ALL SELECT 'published_media', ${projection(MediaRowSchema, "m")}, 3, 0, m.created FROM selected i JOIN version_media vm ON vm.item_id = i.id AND vm.version = i.version JOIN media m ON m.id = vm.media_id
  ORDER BY section, version_order, created_order`;

/** One D1 query, with one result row per item, attachment, history version, or attachment the live version lists. */
export async function itemDetail(db: D1Database, id: string) {
  const { results } = await db.prepare(detailSql).bind(id).all<Record<string, unknown> & { type: string }>();
  const itemRow = results.find((row) => row.type === "item");
  if (!itemRow) return null;
  const item = ItemRowSchema.parse(itemRow);
  const media = results.filter((row) => row.type === "media").map((row) => MediaRowSchema.parse(row));
  const versions = results.filter((row) => row.type === "version").map((row) => VersionRowSchema.parse(row));
  // What the live version lists (migration 0031), detached rows included.
  const publishedMedia = results.filter((row) => row.type === "published_media").map((row) => MediaRowSchema.parse(row));
  const published = versions.find((v) => v.version === item.version) ?? null;
  const previous = versions.find((v) => v.version === item.version - 1);
  const kind = item.kind === 'withdrawn' ? authoredVersionKind(previous, Boolean(previous?.transclusions)) : item.kind;
  return { item, kind, media, versions, published, publishedMedia };
}
