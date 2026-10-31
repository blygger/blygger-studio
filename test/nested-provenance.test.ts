// Every nested baked quote, at any depth, names its source with a link on the
// public page (0.49.0). Before, only the direct layer did: the document's
// transclusions[] records direct transclusions only, and deeper layers had no
// line at all, so a stub stack read as one anonymous blockquote.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { injectNestedProvenance } from "../src/pages.ts";
import { createSubscription } from "../src/importer/store.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const layer = (attrs: string, inner: string) => `<blockquote class="blyg-transclusion" ${attrs}>${inner}</blockquote>`;

describe("nested provenance on public pages", () => {
  it("links a thread's quote of a thread's quote of a fragment on the permalink", async () => {
    const cookie = await login();
    const leaf = await createAndPublish(cookie, "Deepest words.");
    const mid = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: `![[${leaf}]]\n\nMiddle.`, kind: "thread" })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${mid}/publish`, {})).status).toBe(200);
    const top = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: `![[${mid}]]\n\nTop.`, kind: "thread" })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${top}/publish`, {})).status).toBe(200);

    const html = await (await getPublic(`/blyg/t/${top}/`)).text();
    const lines = [...html.matchAll(/<p class="provenance[^"]*">.*?<\/p>/g)].map((m) => m[0]);
    // Document order: the nested line (the leaf) sits inside the middle layer,
    // ahead of the direct line (the middle thread) that closes the top-level one.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('class="provenance nested"');
    expect(lines[0]).toContain(`/blyg/f/${leaf}/`);
    expect(lines[0]).toContain("snapshot of v1");
    expect(lines[1]).not.toContain("nested");
    expect(lines[1]).toContain(`/blyg/t/${mid}/`);
  });

  it("carries the baking layer's origin down, and names the blyg we hold", async () => {
    const origin = "https://far.example/";
    await createSubscription(env.DB, { kind: "blyg", origin, feedUrl: `${origin}feed.xml`, title: "Far Blyg" });
    const html = layer(`data-blyg-id="A" data-blyg-version="3" data-blyg-origin="${origin}"`, `<p>a</p>${layer('data-blyg-id="B" data-blyg-version="2"', "<p>b</p>")}${layer('data-blyg-id="C" data-blyg-version="1" data-blyg-origin="https://else.example/"', "<p>c</p>")}`);
    const out = await injectNestedProvenance(env.DB, html, "/blyg");
    // B has no origin of its own, so it is Far Blyg's; C names its own.
    expect(out).toContain(`<a href="${origin}f/B/">from <em>Far Blyg</em> ↗</a> · snapshot of v2`);
    expect(out).toContain('<a href="https://else.example/f/C/">from else.example ↗</a> · snapshot of v1');
    // The direct layer gets nothing here: that line is injectProvenance's.
    expect(out.match(/class="provenance nested"/g)).toHaveLength(2);
  });

  it("leaves html with no quotes, and a lone layer, untouched", async () => {
    expect(await injectNestedProvenance(env.DB, "<p>hi</p>", "/blyg")).toBe("<p>hi</p>");
    const lone = layer('data-blyg-id="A" data-blyg-version="1"', "<p>a</p>");
    expect(await injectNestedProvenance(env.DB, lone, "/blyg")).toBe(lone);
  });

  it("calls a nested partial an excerpt", async () => {
    const html = layer('data-blyg-id="A" data-blyg-version="1"', `<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="B" data-blyg-version="4"><p>b</p></blockquote>`);
    expect(await injectNestedProvenance(env.DB, html, "/blyg")).toContain("excerpt of v4");
  });
});
