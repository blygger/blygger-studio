// The spellcheck extension's owner reads (docs/extensions.md). Studio furniture: nothing here
// reaches the wire.
import { z } from "@hono/zod-openapi";
import { extensionRoute } from "../../src/extensions/contract.ts";

export const IssueSchema = z
  .object({
    find: z.string().describe("Text from the draft, exactly, holding the error and a little context."),
    replace: z.string().describe("The same text, corrected."),
    why: z.string().describe("A few words on what is wrong."),
  })
  .openapi("SpellcheckIssue");

export const routes = {
  // The word list the browser checks against, fetched once a page the first time a check runs.
  extSpellcheckGetWords: extensionRoute(
    "spellcheck",
    "getWords",
    "/words",
    z.object({
      lang: z.literal("en-US"),
      words: z.number().int().positive(),
      gz: z.string().describe("The words, one per line, gzipped and base64-encoded."),
      notice: z.string().describe("The word list's copyright notice and terms."),
    }),
  ),
  // Spelling, typos and plain grammar errors in an item's working copy, found by the blyg's AI model.
  extSpellcheckProofread: extensionRoute(
    "spellcheck",
    "proofread",
    "/proofread",
    z.object({ issues: z.array(IssueSchema), model: z.string(), truncated: z.boolean().describe("The draft was longer than one call reads; only its start was proofread.") }),
    z.object({ id: z.string().min(1) }),
  ),
};
