// The lineage-glyph extension's server half: two owner reads over the
// references this node holds (lineage.ts). Mounted under /api/ext/lineage-glyph/
// behind the owner API's middleware, and only answering when enabled.
import type { ServerExtension } from "../../src/extensions/server.ts";
import { getSettings } from "../../src/model.ts";
import { getSubscription } from "../../src/importer/store.ts";
import { siteOrigin } from "../../src/protocol.ts";
import { normalizeOrigin } from "../../src/stub.ts";
import { normalizeMount } from "../../src/util.ts";
import { MAX_SUMMARY_KEYS, routes } from "./contract.ts";
import { lineageOf, lineageSummaries } from "./lineage.ts";

/** A reading entry key (src/reading-data.ts) as the node it names: `own:<id>` or `imported:["sub","id"]`. */
function parseKey(key: unknown): { sub: string | null; id: string } | null {
  if (typeof key !== "string") return null;
  if (key.startsWith("own:")) return key.length > 4 ? { sub: null, id: key.slice(4) } : null;
  if (!key.startsWith("imported:")) return null;
  try {
    const pair: unknown = JSON.parse(key.slice("imported:".length));
    return Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string" ? { sub: pair[0], id: pair[1] } : null;
  } catch {
    return null;
  }
}

export const server: ServerExtension = {
  name: "lineage-glyph",
  routes(router) {
    router.get(routes.extLineageGlyphListSummaries, async (c) => {
      let keys: unknown;
      try {
        keys = JSON.parse(c.req.query("keys") ?? "");
      } catch {
        keys = null;
      }
      if (!Array.isArray(keys) || keys.length > MAX_SUMMARY_KEYS) return c.json({ error: `keys must be a JSON array of at most ${MAX_SUMMARY_KEYS} reading entry keys` }, 400);
      const nodes = keys.map((key) => [key, parseKey(key)] as const).filter((pair): pair is readonly [string, { sub: string | null; id: string }] => pair[1] !== null);
      const ourOrigin = siteOrigin(await getSettings(c.env.DB), c.req.url, normalizeMount(c.env.MOUNT));
      const summaries = await lineageSummaries(c.env.DB, ourOrigin, nodes.map(([, node]) => node));
      return c.json({ summaries: Object.fromEntries(nodes.map(([key], i) => [key, summaries[i]])) }, 200);
    });
    router.get(routes.extLineageGlyphGetLineage, async (c) => {
      const ourOrigin = siteOrigin(await getSettings(c.env.DB), c.req.url, normalizeMount(c.env.MOUNT));
      const sub = c.req.query("sub");
      let origin = normalizeOrigin(c.req.query("origin")) ?? ourOrigin;
      if (sub && sub !== "own") {
        const row = await getSubscription(c.env.DB, sub);
        if (!row) return c.json({ error: "no such subscription" }, 404);
        origin = normalizeOrigin(row.origin) ?? row.origin;
      }
      return c.json(await lineageOf(c.env.DB, ourOrigin, origin, c.req.query("id") ?? ""), 200);
    });
  },
};
