// The word-count extension's server half: one owner read that counts a page
// of our own reading entries, published and draft, and rolls each side up
// over its outline tree (tree.ts). Mounted under /api/ext/word-count/ behind
// the owner API's middleware, and only answering when enabled.
import { failure, success } from "../../src/operation-types.ts";
import type { ServerExtension } from "../../src/extensions/server.ts";
import { getSettings } from "../../src/model.ts";
import { siteOrigin } from "../../src/protocol.ts";
import { normalizeMount } from "../../src/util.ts";
import { MAX_COUNT_KEYS, routes } from "./contract.ts";
import { loadItems, rollup, type CountedItem, type ItemSides } from "./tree.ts";

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
      const ourOrigin = siteOrigin(await getSettings(context.env.DB), context.url, normalizeMount(context.env.MOUNT));

      // One load per id for the page, both sides at once: a contents thread
      // and its chapters share their items.
      const items = new Map<string, ItemSides | null>();
      const load = async (ids: string[]) => {
        const missing = ids.filter((id) => !items.has(id));
        if (missing.length) {
          const got = await loadItems(context.env.DB, ourOrigin, missing);
          for (const id of missing) items.set(id, got.get(id) ?? null);
        }
      };
      const sideOf = (side: "published" | "draft") => async (ids: string[]) => {
        await load(ids);
        const out = new Map<string, CountedItem>();
        for (const id of ids) {
          const item = items.get(id)?.[side];
          if (item) out.set(id, item);
        }
        return out;
      };
      const caches = { published: new Map<string, CountedItem | null>(), draft: new Map<string, CountedItem | null>() };

      const counts: Record<string, unknown> = {};
      for (const key of own) {
        const id = key.slice(4);
        await load([id]);
        const item = items.get(id);
        if (!item) continue;
        const draft = { ...item.draft.count, ...(await rollup(id, sideOf("draft"), caches.draft)) };
        const published = item.published ? { ...item.published.count, ...(await rollup(id, sideOf("published"), caches.published)) } : null;
        counts[key] = { published, draft };
      }
      return success({ counts });
    });
  },
};
