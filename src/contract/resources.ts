import { z } from "@hono/zod-openapi";
import { ItemRowSchema, VersionRowSchema, MediaRowSchema, SubscriptionRowSchema, HopperRowSchema, ImportedItemRowSchema, MentionInRowSchema } from "./schemas.ts";
import type { ItemRow, VersionRow, MediaRow, SubscriptionRow, HopperRow, ImportedItemRow, MentionInRow } from "../types.ts";

export const CitationSchema = z.object({ source: z.string(), author: z.string().optional(), excerpt: z.string().optional(), url: z.string(), retrieved: z.string() }).openapi("Citation");
export const VersionReferenceSchema = z.object({ origin: z.string().url(), id: z.string().min(1), version: z.number().int().positive(), cited: CitationSchema.optional() }).strict().openapi("VersionReference");
export const StubSchema = z.union([VersionReferenceSchema, z.object({ url: z.string().url(), cited: CitationSchema.optional() }).strict()]).openapi("CitationTarget");
export const GenerationSourceSchema = z.object({ id: z.string(), version: z.number().int().positive(), origin: z.string().optional().describe("Present for a remote source (0.4, §16.3); omitted for this blyg's own."), cited: CitationSchema.optional() }).openapi("GenerationSource");
export const ProvenanceSchema = z.object({ sources: z.array(GenerationSourceSchema), model: z.string().optional(), at: z.string().optional() }).passthrough().openapi("GenerationProvenance");
export const TransclusionSchema = z.object({ id: z.string(), version: z.number().int().positive(), origin: z.string().optional(), cited: CitationSchema.optional(), selector: z.object({ exact: z.string(), prefix: z.string().optional(), suffix: z.string().optional() }).optional() }).openapi("Transclusion");
export const ItemSchema = z.object(ItemRowSchema.omit({ show_responses: true, responses_override: true, highlight_override: true, tk_provenance_json: true, stub_of: true, forked_from: true, fork_cite: true, dirty: true }).shape).extend({
  dirty: z.boolean(), responses: z.enum(["default", "show", "hide"]), highlight: z.enum(["default", "show", "hide"]),
  provenance: z.array(z.union([ProvenanceSchema, z.null()])),
  stub_of: z.union([StubSchema, z.null()]), forked_from: z.union([VersionReferenceSchema, z.null()]), fork_cite: z.union([CitationSchema, z.null()]),
}).openapi("Item");
export const VersionSchema = z.object(VersionRowSchema.omit({ pinned: true, transclusions: true, generated_json: true, stub_of: true, stub_cite: true, note_generated: true }).shape).extend({
  kind: z.enum(["fragment", "thread", "withdrawn"]), pinned: z.boolean(), note_generated: z.boolean(), transclusions: z.array(TransclusionSchema), generated: z.array(ProvenanceSchema),
  stub_of: z.union([StubSchema, z.null()]), stub_cite: z.union([CitationSchema, z.null()]),
}).openapi("Version");
export const MediaSchema = z.object(MediaRowSchema.omit({ r2_key: true }).shape).extend({ url: z.string() }).openapi("Media");
export const SubscriptionSchema = z.object(SubscriptionRowSchema.omit({ etag: true, last_modified: true, newest_guid: true, in_blogroll: true, flags: true, title_auto: true }).shape).extend({ title_follows_source: z.boolean(), in_blogroll: z.boolean(), flags: z.array(z.object({ type: z.string(), at: z.string(), detail: z.string().optional() })) }).openapi("Subscription");
export const HopperSchema = z.object(HopperRowSchema.shape).extend({ public: z.boolean(), slug_frozen: z.boolean() }).openapi("Hopper");
export const ImportedItemSchema = z.object(ImportedItemRowSchema.shape).extend({ l0: z.boolean() }).openapi("ImportedItem");
export const MentionSchema = z.object(MentionInRowSchema.shape).extend({ hidden: z.boolean() }).openapi("Mention");

// Preserve the old readers' tolerance for damaged JSON columns. Validate each
// column independently and leave stored bytes untouched. Scalar row fields
// still go through the complete resource schema.
function stored<T>(value: string | null, schema: z.ZodType<T>, fallback: T): T {
  if (value === null) return fallback;
  try { const result = schema.safeParse(JSON.parse(value)); return result.success ? result.data : fallback; }
  catch { return fallback; }
}
const provenance = z.array(z.union([ProvenanceSchema, z.null()]));
const overrideMode = (value: number | null | undefined) => (value === null || value === undefined ? "default" : value === 1 ? "show" : "hide");
export const itemResource = (row: ItemRow) => ItemSchema.parse({ ...row, dirty: row.dirty === 1, responses: row.responses_override === null ? "default" : row.responses_override === 1 ? "show" : "hide", highlight: overrideMode(row.highlight_override), provenance: stored(row.tk_provenance_json, provenance, []), stub_of: stored(row.stub_of, StubSchema.nullable(), null), forked_from: stored(row.forked_from, VersionReferenceSchema.nullable(), null), fork_cite: stored(row.fork_cite, CitationSchema.nullable(), null) });
export const versionResource = (row: VersionRow) => VersionSchema.parse({ ...row, kind: !row.content_md ? "withdrawn" : row.transclusions === null ? "fragment" : "thread", pinned: row.pinned === 1, note_generated: row.note_generated === 1, transclusions: stored(row.transclusions, z.array(TransclusionSchema), []), generated: stored(row.generated_json, z.array(ProvenanceSchema), []), stub_of: stored(row.stub_of, StubSchema.nullable(), null), stub_cite: stored(row.stub_cite, CitationSchema.nullable(), null) });
export const mediaResource = (row: MediaRow) => MediaSchema.parse({ ...row, url: row.r2_key });
export const subscriptionResource = (row: SubscriptionRow) => SubscriptionSchema.parse({ ...row, title_follows_source: row.title_auto !== 0, in_blogroll: row.in_blogroll === 1, flags: stored(row.flags, SubscriptionSchema.shape.flags, []) });
export const hopperResource = (row: HopperRow) => HopperSchema.parse({ ...row, public: row.public === 1, slug_frozen: row.slug_frozen === 1 });
export const importedResource = (row: ImportedItemRow) => ImportedItemSchema.parse({ ...row, l0: row.l0 === 1 });
export const mentionResource = (row: MentionInRow) => MentionSchema.parse({ ...row, hidden: row.hidden === 1 });
