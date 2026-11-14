// Mathematics (decision #105, spec 0.4 §2, §5.2): `$…$` and `$$…$$` in
// content_md, MathML in content_html, the TeX carried inside each formula.
// The properties that matter, each pinned here:
//   1. Nothing that is not a formula changes: money, lone dollars and code
//      render byte for byte as before.
//   2. What publishes is MathML that draws itself: no stylesheet, no KaTeX.
//   3. content_md keeps the dollars, so content_hash is over what was typed.
//   4. A formula that does not parse is refused at publish, like a link that
//      does not resolve.
//   5. §2 text content has no exception for a formula, and a partial quote that
//      takes in part of one is refused.
import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";
import { plainTextFromHtml, renderMarkdown, selectionText, selectionTouchesMath, excerptFromHtml } from "../src/markdown.ts";
import { mathAt } from "../src/math.ts";

// The renderer as it was before #105, for "nothing else changed".
const before = new MarkdownIt({ html: false, linkify: true, typographer: false });

describe("which dollars are formulas", () => {
  it.each([
    "$5 and $10",
    "It costs $5.",
    "a $ b $ c",
    "between $ and$",
    "`$x$` in code",
    "```\n$x$\n```",
    "    $x$ indented code",
    "\\$x\\$ escaped",
    "$$ $$ nothing in it",
    "[link]($x$)",
    "$1,000 to $2,000",
  ])("%j renders exactly as before", (md) => {
    expect(renderMarkdown(md)).toBe(before.render(md));
  });

  it.each([
    ["$x$", "x", false],
    ["$x^2 + y^2$", "x^2 + y^2", false],
    ["$\\$5$", "\\$5", false],
    ["$$x$$", "x", true],
    ["$$\n\\int f\n$$", "\n\\int f\n", true],
  ])("%j is a formula", (md, tex, display) => {
    expect(mathAt(md, 0)).toMatchObject({ tex, display });
  });

  it("the closing dollar may not be followed by a digit, so the next one closes", () => {
    expect(mathAt("$a$1 and b$", 0)).toMatchObject({ tex: "a$1 and b" });
  });
});

describe("what publishes", () => {
  it("is MathML with the TeX inside, and nothing that needs a stylesheet", () => {
    const html = renderMarkdown("Energy $E = mc^2$ and $$\\sum_i x_i$$");
    expect(html).toContain("<math>");
    expect(html).toContain('<math display="block"');
    expect(html).toContain('<annotation encoding="application/x-tex">E = mc^2</annotation>');
    expect(html).not.toMatch(/katex|<link|<style|<script|stylesheet/i);
  });

  it("refuses what would put a link or an attribute in the HTML", () => {
    for (const tex of ["\\href{javascript:alert(1)}{x}", "\\class{evil}{x}", "\\htmlId{a}{x}", "\\htmlStyle{color:red}{x}"]) {
      const html = renderMarkdown(`$${tex}$`);
      expect(html).not.toContain("<math");
      expect(html).toContain('class="math-error"');
      expect(html).not.toMatch(/href=|id="a"|style=/);
    }
  });

  it("a bad formula in preview reads as written, escaped", () => {
    expect(renderMarkdown("$\\frac{<b>$")).toContain(">$\\frac{&lt;b&gt;$</code>");
  });
});

describe("presentation text and text content", () => {
  const html = renderMarkdown("Energy $E=mc^2$ here.");
  it("excerpts and labels show the TeX in dollars", () => {
    expect(plainTextFromHtml(html)).toBe("Energy $E=mc^2$ here.");
    expect(excerptFromHtml(html)).toBe("Energy $E=mc^2$ here.");
  });
  it("§2 text content strips tags and nothing else", () => {
    expect(selectionText(html)).toBe(selectionText(html.replace(/<[^>]+>/g, (t) => (t.startsWith("</p") ? t : ""))));
    expect(selectionText(html)).toContain("E=mc2E=mc^2");
  });
  it("a selection that takes in a formula is detected; one beside it is not", () => {
    expect(selectionTouchesMath(html, "Energy E=mc2")).toBe(true);
    expect(selectionTouchesMath(html, "here.")).toBe(false);
    expect(selectionTouchesMath(html, "Energy")).toBe(false);
    expect(selectionTouchesMath(renderMarkdown("no formulas"), "no")).toBe(false);
  });
});

describe("publish", () => {
  it("bakes MathML and keeps the dollars in content_md", async () => {
    const cookie = await login();
    const md = "The area is $\\pi r^2$.";
    const id = await createAndPublish(cookie, md);
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(doc.content_md).toBe(md);
    expect(doc.content_html).toContain("<math>");
    expect(doc.content_html).toContain('encoding="application/x-tex">\\pi r^2</annotation>');
  });

  it("refuses a formula that does not parse, naming it", async () => {
    const cookie = await login();
    const created = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "Broken $\\frac{a$ here", kind: "fragment" });
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${created.json.id}/publish`, {});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain("\\\\frac{a");
  });

  it("refuses a partial quote across a formula, and takes one beside it", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Energy $E=mc^2$ is famous.\n\nA second paragraph.");
    const across = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: `![[${target}]]\n> Energy E=mc2E=mc^2 is famous.`, kind: "thread" });
    const refused = await apiJson(cookie, "POST", `/blyg/api/items/${across.json.id}/publish`, {});
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.json)).toContain("includes part of a formula");
    const beside = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: `![[${target}]]\n> A second paragraph.`, kind: "thread" });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${beside.json.id}/publish`, {})).status).toBe(200);
  });
});

describe("commands the allowlist cannot express (v0.4-plan §23.5)", () => {
  it("publish refuses a strike by name, and takes an overline and a box", async () => {
    const cookie = await login();
    const refused = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "Struck $\\cancel{x}$", kind: "fragment" });
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${refused.json.id}/publish`, {});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain("cancel needs a stylesheet");
    const id = await createAndPublish(cookie, "Mean $\\overline{x}$ in $\\boxed{y}$");
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(doc.content_html).toContain('<mover accent="true">');
    expect(doc.content_html).not.toContain("menclose");
  });
});
