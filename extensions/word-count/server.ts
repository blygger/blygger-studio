// The word-count extension's server half: one owner read that counts a page
// of our own reading entries and rolls each up over its outline tree
// (tree.ts). Mounted under /api/ext/word-count/ behind the owner API's
// middleware, and only answering when enabled.
import { failure, success } from "../../src/operation-types.ts";
import type { ServerExtension } from "../../src/extensions/server.ts";
import { MAX_COUNT_KEYS, routes } from "./contract.ts";
import { loadItems, rollup, type CountedItem } from "./tree.ts";

export const server: ServerExtension = {
  name: "word-count",
  routes(router) {
    router.get(routes.extWordCountListCounts, async (context, input) => {
      let keys: unknown;
      try {
        keys = JSON.parse(input.query.keys ?? "");
      } catch {
        keys = null;
      }
      if (!Array.isArray(keys) || keys.length > MAX_COUNT_KEYS) return failure("invalid-input", { error: `keys must be a JSON array of at most ${MAX_COUNT_KEYS} own reading entry keys` });
      const own = keys.filter((key): key is string => typeof key === "string" && key.startsWith("own:") && key.length > 4);
      // One cache for the page: a contents thread and its chapters share their items.
      const cache = new Map<string, CountedItem | null>();
      const load = (ids: string[]) => loadItems(context.env.DB, ids);
      const counts: Record<string, unknown> = {};
      for (const key of own) {
        const id = key.slice(4);
        const tree = await rollup(id, load, cache);
        const item = cache.get(id);
        if (item) counts[key] = { ...item.count, ...tree };
      }
      return success({ counts });
    });
  },
};
