// include=drafts on the search route (docs/search.md, decision 1): the compose
// page finds your own drafts and unpublished changes by their working copy. The
// default scope stays exactly what a quote or link can name, so the picker,
// which never sends it, still never offers a draft.
import { beforeAll, describe, expect, it } from "vitest";
import { apiJson, createAndPublish, login } from "./helpers.ts";

type Hit = { id: string; source: string; draft?: boolean; excerpt: string };
let cookie = "";
let draft = "", changed = "", clean = "";
const search = async (query: string) => ((await apiJson(cookie, "GET", `/blyg/api/search?${query}`)).json as { items: Hit[] }).items;

beforeAll(async () => {
  cookie = await login();
  draft = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "Never published: quandoplex draft text." })).json.id as string;
  changed = await createAndPublish(cookie, "Published words only.");
  const item = (await apiJson(cookie, "GET", `/blyg/api/items/${changed}`)).json as { revision: number };
  const edit = await apiJson(cookie, "PATCH", `/blyg/api/items/${changed}`, { contentMd: "Published words, then quandoplex added unpublished.", expectedRevision: item.revision });
  if (edit.status !== 200) throw new Error(`edit failed: ${edit.status}`);
  clean = await createAndPublish(cookie, "A clean quandoplex item, published as it stands.");
});

describe("GET /api/search?include=drafts", () => {
  it("never offers a draft or unpublished words by default", async () => {
    const hits = await search("q=quandoplex&source=mine");
    expect(hits.map((h) => h.id)).toEqual([clean]);
    expect(hits[0].draft).toBeUndefined();
  });

  it("finds drafts and unpublished changes by their working copy, and marks them", async () => {
    const hits = await search("q=quandoplex&source=mine&include=drafts");
    const byId = new Map(hits.map((h) => [h.id, h]));
    expect([...byId.keys()].sort()).toEqual([draft, changed, clean].sort());
    expect(byId.get(draft)).toMatchObject({ draft: true, source: "mine" });
    expect(byId.get(draft)!.excerpt).toContain("quandoplex draft text");
    expect(byId.get(changed)).toMatchObject({ draft: true });
    expect(byId.get(changed)!.excerpt).toContain("added unpublished");
    expect(byId.get(clean)).toMatchObject({ draft: false });
  });

  it("leaves imported items as they were", async () => {
    const hits = await search("q=quandoplex&source=imported&include=drafts");
    expect(hits).toEqual([]);
  });
});
