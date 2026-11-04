// The word-count extension's owner read (docs/extensions.md). Studio
// furniture: nothing here reaches the wire.
import { z } from "@hono/zod-openapi";
import { extensionRoute } from "../../src/extensions/contract.ts";

const count = { words: z.number().int().nonnegative(), cjk: z.number().int().nonnegative().describe("Han, kana and Hangul characters, counted one by one.") };
export const WordCountSchema = z
  .object({
    ...count,
    document: z.object({ ...count, items: z.number().int().positive().describe("Items in the outline tree, this one included.") }).nullable().describe("The roll-up over the item's outline links; null when they do not form a strict tree of our own published items."),
    reason: z.enum(["cycle", "repeated", "unavailable", "too-large"]).optional().describe("Why `document` is null."),
  })
  .openapi("WordCount");

/** At most a reading page's worth of entries per request. */
export const MAX_COUNT_KEYS = 50;

export const routes = {
  // Counts for a page of own reading entries, by their `key` from GET
  // /api/reading (`own:<id>`). Keys that name nothing published here are omitted.
  extWordCountListCounts: extensionRoute("word-count", "listCounts", "/counts", z.object({ counts: z.record(z.string(), WordCountSchema) }), z.object({ keys: z.string().min(2).describe(`A JSON array of up to ${MAX_COUNT_KEYS} own reading entry keys.`) })),
};
