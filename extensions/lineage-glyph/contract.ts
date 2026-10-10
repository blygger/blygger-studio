// The lineage-glyph extension's owner reads (docs/extensions.md). Studio
// furniture: nothing here reaches the wire.
import { z } from "@hono/zod-openapi";
import { extensionRoute } from "../../src/extensions/contract.ts";

const relationCounts = z.object({ stub: z.number().int().nonnegative(), transclusion: z.number().int().nonnegative(), fork: z.number().int().nonnegative() });
export const LineageSummarySchema = z.object({ up: relationCounts, down: relationCounts }).openapi("LineageGlyphSummary");
const lineageNodeBase = z.object({ origin: z.string().nullable(), id: z.string().nullable(), version: z.number().int().nullable(), held: z.enum(["own", "imported"]).nullable(), sub: z.string().nullable(), kind: z.enum(["fragment", "thread"]).nullable(), title: z.string().nullable(), excerpt: z.string().nullable(), source: z.string().nullable(), url: z.string().nullable() });
const lineageNode = lineageNodeBase.extend({ relation: z.enum(["stub", "transclusion", "fork"]), partial: z.boolean(), via: z.enum(["reference", "mention"]) }).openapi("LineageGlyphNode");
export const LineageSchema = z.object({ node: lineageNodeBase, ancestors: z.array(lineageNode), descendants: z.array(lineageNode) }).openapi("LineageGlyphLineage");

/** At most a reading page's worth of entries per summaries request. */
export const MAX_SUMMARY_KEYS = 50;

export const routes = {
  // One hop of lineage around an item, for the hex view. `sub` names an
  // imported item's subscription ("own" or absent for ours); `origin`
  // re-centres on any node a lineage named, held here or not.
  extLineageGlyphGetLineage: extensionRoute("lineage-glyph", "getLineage", "/lineage", LineageSchema, z.object({ id: z.string().min(1), sub: z.string().optional(), origin: z.string().optional() })),
  // Glyph counts for a page of reading entries, by their `key` from GET
  // /api/reading. `keys` is a JSON array of those keys; unknown keys are omitted.
  extLineageGlyphListSummaries: extensionRoute("lineage-glyph", "listSummaries", "/summaries", z.object({ summaries: z.record(z.string(), LineageSummarySchema) }), z.object({ keys: z.string().min(2).describe(`A JSON array of up to ${MAX_SUMMARY_KEYS} reading entry keys.`) })),
};
