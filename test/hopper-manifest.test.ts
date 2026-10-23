// The manifest's proposed `hoppers` key (§6.1; pending Fable, fable-round-queue
// item 14): public, slugged hoppers only, origin-relative paths, present only
// while hopper_feeds is on and there is at least one.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { apiJson, getPublic, login } from "./helpers.ts";

const manifest = async () => (await (await getPublic("/blyg/blyg.json")).json()) as Record<string, unknown>;

async function hopper(cookie: string, name: string, isPublic: boolean) {
  const h = (await apiJson(cookie, "POST", "/api/hoppers", { name })).json as { id: string };
  if (isPublic) expect((await apiJson(cookie, "PATCH", `/api/hoppers/${h.id}`, { public: true })).status).toBe(200);
  return (await apiJson(cookie, "GET", `/api/hoppers/${h.id}`)).json.hopper as { id: string; slug: string; name: string };
}

afterEach(async () => {
  await apiJson(await login(), "PATCH", "/api/settings", { hopper_feeds: false });
});

describe("manifest hoppers", () => {
  it("is absent while hopper feeds are off, even with public hoppers", async () => {
    const cookie = await login();
    await hopper(cookie, "Listed When On", true);
    expect("hoppers" in (await manifest())).toBe(false);
  });

  it("lists public hoppers only, as origin-relative page and feed paths", async () => {
    const cookie = await login();
    const pub = await hopper(cookie, "Public Picks", true);
    const priv = await hopper(cookie, "Private Picks", false);
    await apiJson(cookie, "PATCH", "/api/settings", { hopper_feeds: true });
    const hoppers = (await manifest()).hoppers as { title: string; page: string; feed: string }[];
    expect(hoppers).toContainEqual({ title: "Public Picks", page: `h/${pub.slug}/`, feed: `h/${pub.slug}/feed.xml` });
    expect(hoppers.some((h) => h.title === priv.name)).toBe(false);
    for (const h of hoppers) expect(h.page.startsWith("http")).toBe(false);
  });

  it("is absent with hopper feeds on when no hopper is public", async () => {
    await apiJson(await login(), "PATCH", "/api/settings", { hopper_feeds: true });
    const saved = await env.DB.prepare("SELECT id FROM hoppers WHERE public = 1").all<{ id: string }>();
    await env.DB.prepare("UPDATE hoppers SET public = 0").run();
    try {
      expect("hoppers" in (await manifest())).toBe(false);
    } finally {
      for (const { id } of saved.results) await env.DB.prepare("UPDATE hoppers SET public = 1 WHERE id = ?").bind(id).run();
    }
  });
});
