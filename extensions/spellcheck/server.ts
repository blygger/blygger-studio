// The spellcheck extension's server half: the word list, and the AI proofread of an item's working
// copy through the blyg's TK model. Mounted under /api/ext/spellcheck/ behind the owner API's
// middleware, and only answering when enabled.
import { failure, success } from "../../src/operation-types.ts";
import type { ServerExtension } from "../../src/extensions/server.ts";
import { complete } from "../../src/ai/provider.ts";
import { getItem } from "../../src/model.ts";
import { routes } from "./contract.ts";
import { MAX_PROOFREAD_CHARS, PROOFREAD_SYSTEM, readIssues } from "./proofread.ts";
import { NOTICE, WORDS, WORDS_GZ } from "./words-en-us.ts";

export const server: ServerExtension = {
  name: "spellcheck",
  routes(router) {
    router.get(routes.extSpellcheckGetWords, async () => success({ lang: "en-US" as const, words: WORDS, gz: WORDS_GZ, notice: NOTICE }));
    router.get(routes.extSpellcheckProofread, async (context, input) => {
      const item = await getItem(context.env.DB, String(input.query.id));
      if (!item || item.status === "withdrawn") return failure("not-found", { error: "no such item" });
      const text = item.content_md.slice(0, MAX_PROOFREAD_CHARS);
      try {
        const result = await complete(context.env, PROOFREAD_SYSTEM, text, undefined, "tk");
        return success({ issues: readIssues(result.text, text), model: result.model, truncated: item.content_md.length > MAX_PROOFREAD_CHARS });
      } catch (error) {
        return failure("unprocessable", { error: error instanceof Error ? error.message : String(error) });
      }
    });
  },
};
