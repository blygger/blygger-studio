// Decision #57 (spec §16.6f, gate G11): a fork of a thread descends from the
// pinned document. Quotes are flattened into ordinary blockquotes with an
// attribution line, recursively; no blyg-transclusion survives; nothing is
// inherited into transclusions[]; generated text stays disclosed.
import { describe, expect, it } from "vitest";
import { flattenFork, htmlToMarkdown } from "../src/fork-flatten.ts";
import { renderMarkdown } from "../src/markdown.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const OURS = "https://example.com/blyg/";
const ctx = { origin: OURS, link: async (o: string, id: string) => `${o}items/${id}.json` };
const ID1 = "1111111111111111111111111a", ID2 = "2222222222222222222222222b";

describe("flattening", () => {
  it("keeps own prose byte-exact and replaces each directive by its baked quote", async () => {
    const md = "Intro with *my* words.\n\n![[" + ID1 + "]]\n\nAfter.";
    const html = `<p>Intro with <em>my</em> words.</p>\n<blockquote class="blyg-transclusion" data-blyg-id="${ID1}" data-blyg-version="2">\n<p>Their <strong>point</strong>.</p>\n</blockquote>\n<p>After.</p>`;
    const out = await flattenFork({ contentMd: md, contentHtml: html, generated: [] }, ctx);
    expect(out.exact).toBe(true);
    expect(out.contentMd).toBe(`Intro with *my* words.\n\n> Their **point**.\n>\n> — quoted from [example.com · v2](${OURS}items/${ID1}.json)\n\nAfter.`);
    expect(renderMarkdown(out.contentMd)).not.toContain("blyg-transclusion");
  });

  it("nests quotes, and a nested layer without data-blyg-origin belongs to the layer that baked it", async () => {
    const md = `![[${ID1}]]`;
    const html = `<blockquote class="blyg-transclusion" data-blyg-id="${ID1}" data-blyg-version="1" data-blyg-origin="https://them.example/">\n<p>Outer.</p>\n<blockquote class="blyg-transclusion" data-blyg-id="${ID2}" data-blyg-version="3">\n<p>Inner.</p>\n</blockquote>\n</blockquote>`;
    const out = await flattenFork({ contentMd: md, contentHtml: html, generated: [] }, ctx);
    expect(out.contentMd).toContain(`> > Inner.`);
    expect(out.contentMd).toContain(`> > — quoted from [them.example · v3](https://them.example/items/${ID2}.json)`);
    expect(out.contentMd).toContain(`> — quoted from [them.example · v1](https://them.example/items/${ID1}.json)`);
  });

  it("consumes a partial directive's attached quote and flattens its baked passage", async () => {
    const md = `![[${ID1}]]\n> the passage\n\nMine.`;
    const html = `<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="${ID1}" data-blyg-version="1">\n<p>the passage</p>\n</blockquote>\n<p>Mine.</p>`;
    const out = await flattenFork({ contentMd: md, contentHtml: html, generated: [] }, ctx);
    expect(out.contentMd).toBe(`> the passage\n>\n> — quoted from [example.com · v1](${OURS}items/${ID1}.json)\n\nMine.`);
  });

  it("keeps the author's own > lines after a whole quote baked by a client without partial grammar (studio#29)", async () => {
    const md = `![[${ID1}]]\n> my own quoted aside\n\nMine.`;
    const html = `<blockquote class="blyg-transclusion" data-blyg-id="${ID1}" data-blyg-version="1">\n<p>their whole item</p>\n</blockquote>\n<blockquote>\n<p>my own quoted aside</p>\n</blockquote>\n<p>Mine.</p>`;
    const out = await flattenFork({ contentMd: md, contentHtml: html, generated: [] }, ctx);
    expect(out.exact).toBe(true);
    expect(out.contentMd).toBe(`> their whole item\n>\n> — quoted from [example.com · v1](${OURS}items/${ID1}.json)\n\n> my own quoted aside\n\nMine.`);
    expect((renderMarkdown(out.contentMd).match(/<blockquote>/g) ?? []).length).toBe(2);
  });

  it("re-wraps the thread's own generated text as impyrt with its model, and quotes' generated text without one", async () => {
    const md = `I say. A model said this. Done.\n\n![[${ID1}]]`;
    const html = `<p>I say. <span class="blyg-tk-gen">A model said this.</span> Done.</p>\n<blockquote class="blyg-transclusion" data-blyg-id="${ID1}" data-blyg-version="1">\n<div class="blyg-tk-gen"><p>Quoted machine text.</p>\n</div>\n</blockquote>`;
    const out = await flattenFork({ contentMd: md, contentHtml: html, generated: [{ sources: [], model: "m-1" }] }, ctx);
    expect(out.exact).toBe(true);
    expect(out.contentMd).toContain("I say. [TK]impyrt m-1=A model said this.[/TK] Done.");
    expect(out.contentMd).toContain("> [TK]impyrt=Quoted machine text.[/TK]");
  });

  it("falls back to the whole pinned HTML when the markdown and the bake disagree, keeping every disclosure", async () => {
    const md = "Text that was edited away from its html.";
    const html = `<p>Different <span class="blyg-tk-gen">generated</span> text.</p>`;
    const out = await flattenFork({ contentMd: md, contentHtml: html, generated: [{ sources: [] }] }, ctx);
    expect(out.exact).toBe(false);
    expect(out.contentMd).toContain("[TK]impyrt=generated[/TK]");
  });

  it("flattens inline [[id]] links to the anchors the bake rendered, leaving code inert (#63)", async () => {
    const md = `See [[${ID1}]] and \`[[${ID2}]]\` and [mine](https://x.example/).\n\n![[${ID2}]]\n\nAlso [[${ID2}]].`;
    const html = `<p>See <a href="${OURS}f/${ID1}/">“first item”</a> and <code>[[${ID2}]]</code> and <a href="https://x.example/">mine</a>.</p>\n<blockquote class="blyg-transclusion" data-blyg-id="${ID2}" data-blyg-version="1">\n<p>Has <a href="https://them.example/f/${ID2}/">a link of its own</a>.</p>\n</blockquote>\n<p>Also <a href="${OURS}f/${ID2}/">“second item”</a>.</p>`;
    const out = await flattenFork({ contentMd: md, contentHtml: html, generated: [] }, ctx);
    expect(out.exact).toBe(true);
    expect(out.contentMd).toContain(`See [“first item”](${OURS}f/${ID1}/) and \`[[${ID2}]]\` and [mine](https://x.example/).`);
    expect(out.contentMd).toContain(`Also [“second item”](${OURS}f/${ID2}/).`);
    expect(out.contentMd.replace(/`[^`]*`/g, "")).not.toMatch(/(?<!!)\[\[/);
  });

  it("rebuilds from the HTML when a link's anchor cannot be found (a target with its own page)", async () => {
    const md = `See [[${ID1}]].`;
    const html = `<p>See <a href="https://them.example/posts/hello/">“their post”</a>.</p>`;
    const out = await flattenFork({ contentMd: md, contentHtml: html, generated: [] }, ctx);
    expect(out.exact).toBe(false);
    expect(out.contentMd).toBe(`See [“their post”](https://them.example/posts/hello/).\n`);
  });

  it("converts the dialect's blocks", async () => {
    const html = "<h2>Head</h2>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<pre><code>x = `y`\n</code></pre>\n<p>a &amp; b * c</p>";
    expect(await htmlToMarkdown(html, ctx)).toBe("## Head\n\n- one\n- two\n\n```\nx = `y`\n```\n\na & b \\* c\n");
  });
});

describe("a fork through the API (#57)", () => {
  it("inherits no transclusions, sends no quote-mentions, and keeps a fragment's generated disclosure", async () => {
    const cookie = await login();
    const quoted = await createAndPublish(cookie, "quoted words");
    const thread = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: `Mine. [TK]impyrt gen-1=Machine words.[/TK]\n\n![[${quoted}]]`, kind: "thread" })).json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {});
    await apiJson(cookie, "PUT", `/blyg/api/items/${thread}/versions/1/pin`);
    const fork = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: thread, version: 1 } });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${fork.json.id}/publish`, {})).status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${fork.json.id}.json`)).json<any>();
    expect(doc.transclusions).toEqual([]);
    expect(doc.content_html).not.toContain("blyg-transclusion");
    expect(doc.content_html).toContain("quoted words");
    expect(doc.generated).toEqual([{ sources: [], model: "gen-1" }]);

    const frag = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "Plain. [TK]impyrt gen-2=Generated.[/TK]" })).json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${frag}/publish`, {});
    await apiJson(cookie, "PUT", `/blyg/api/items/${frag}/versions/1/pin`);
    const ffork = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: frag, version: 1 } });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${ffork.json.id}/publish`, {})).status).toBe(200);
    expect((await (await getPublic(`/blyg/items/${ffork.json.id}.json`)).json<any>()).generated).toEqual([{ sources: [], model: "gen-2" }]);
    const linker = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: `Pointing at [[${quoted}]].` })).json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${linker}/publish`, {});
    await apiJson(cookie, "PUT", `/blyg/api/items/${linker}/versions/1/pin`);
    const lfork = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: linker, version: 1 } });
    expect(lfork.json.content_md).not.toContain("[[");
    expect(lfork.json.content_md).toMatch(new RegExp(`^Pointing at \\[“quoted words”\\]\\(https://[^)]*${quoted}/?\\)\\.$`));
  });
});
