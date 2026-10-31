// Edge cases of the label grammar (0.4 §10.1, decision #70), kept as regression
// coverage for six bugs in 0.47.0 found by Burrow, a port of this renderer.
// Each describe names the bug it pins; each test asserts the correct
// behaviour, so a regression reads as the bug it brings back.
import { describe, expect, it } from "vitest";
import { DIRECTIVE_LINE, label, linkInline, linkSource } from "../src/grammar.ts";
import { unrequestedOutputDirectives } from "../src/tk.ts";
import { withStubQuote } from "../src/ui/stub-quote.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const ID = "7c9wk2n4h6q1x8v0z3m5rjy2ke";
const OURS = "https://example.com/blyg/";

async function publish(cookie: string, md: string, kind: "fragment" | "thread" = "thread") {
  const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: md, kind })).json.id as string;
  const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
  const doc = res.status === 200 ? await (await getPublic(`/blyg/items/${id}.json`)).json<any>() : null;
  return { id, res, doc };
}

const anchorText = (html: string, target: string) =>
  new RegExp(`<a href="${OURS}f/${target}/">([\\s\\S]*?)</a>`).exec(html)?.[1];

describe("a label inside block TK output is escaped once, as in the body", () => {
  it("block-scope anchor text equals body anchor text for the same label", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const target = await createAndPublish(cookie, "# Target\n\nBody.");
    const lbl = "a <b> & x *em*";
    const body = await publish(cookie, `Body [[${target} | ${lbl}]] here.`);
    // impyrt carries provenance, so the scope is lifted out and rendered as a
    // generated block (a hand-written `[=]` output with no provenance is not
    // lifted at publish and renders in the body, which hides the bug there).
    const blockMd = `Intro.\n\n[TK]impyrt=One [[${target} | ${lbl}]].\n\nTwo.[/TK]\n\nOutro.`;
    const block = await publish(cookie, blockMd);
    const inline = await publish(cookie, `Intro [TK]impyrt=one [[${target} | ${lbl}]] two[/TK] outro.`);
    // The preview lifts every block scope, `[=]` included.
    const preview = await apiJson(cookie, "POST", "/blyg/api/preview", {
      content_md: `[TK]write[=]One [[${target} | ${lbl}]].\n\nTwo.[/TK]`,
      kind: "thread",
    });
    expect(body.res.status, JSON.stringify(body.res.json)).toBe(200);
    expect(block.res.status, JSON.stringify(block.res.json)).toBe(200);
    expect(inline.res.status, JSON.stringify(inline.res.json)).toBe(200);
    const want = anchorText(body.doc.content_html, target);
    expect(want).toBe("a &lt;b&gt; &amp; x *em*");
    expect(anchorText(inline.doc.content_html, target), "inline scope").toBe(want);
    expect(anchorText(preview.json.html as string, target), "block scope, preview").toBe(want);
    expect(anchorText(block.doc.content_html, target), "block scope, publish").toBe(want);
  });
});

describe("a backtick inside a label does not make a later link inert", () => {
  it("the second link on the line still renders as a link", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const a = await createAndPublish(cookie, "# Alpha\n\nBody.");
    const b = await createAndPublish(cookie, "# Beta\n\nBody.");
    const { res, doc } = await publish(cookie, `See [[${a} | it\`s]] and [[${b}]] then \`code\`.`, "fragment");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(doc.content_html).toContain(`<a href="${OURS}f/${a}/">it\`s</a>`);
    expect(doc.content_html).toContain(`<a href="${OURS}f/${b}/">Beta</a>`);
    expect(doc.content_html).not.toContain(`[[${b}]]`);
  });

  it("a code span opened before a link still wins where it closes inside the label", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const a = await createAndPublish(cookie, "# Alpha\n\nBody.");
    const { res, doc } = await publish(cookie, `See \`x [[${a} | y\`]] after.`, "fragment");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(doc.content_html).toContain(`<code>x [[${a} | y</code>`);
    expect(doc.content_html).not.toContain("<a ");
  });
});

describe("linkSource -> parse round-trips a label holding runs of ]", () => {
  it.each(["a]]]b", "a]]]]b", "x]]]"])("label %s survives as a label with no ]] cut", (text) => {
    const src = linkSource(ID, text);
    const parsed = [...src.matchAll(linkInline())].map((m) => ({ id: m[1], label: label(m[2]), whole: m[0] }));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].whole, "the match covers the whole written link").toBe(src);
    expect(parsed[0].label).not.toContain("]]");
  });
});

describe("an autolinked URL holding a labelled link escapes & in its href", () => {
  it("the href attribute carries &amp;, never a raw &", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const target = await createAndPublish(cookie, "# Target\n\nBody.");
    for (const md of [`<https://x.test/[[${target}|a&copy]]>`, `https://x.test/[[${target}|a&copy]]`]) {
      const { res, doc } = await publish(cookie, md, "fragment");
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const href = /<a href="([^"]*)"/.exec(doc.content_html)?.[1] ?? "";
      expect(href, `${md} -> ${doc.content_html}`).toContain("x.test");
      // A raw `&copy` in an attribute is decoded by the browser to "©".
      expect(href, md).not.toMatch(/&(?!amp;|#|lt;|gt;|quot;)/);
    }
  });
});

describe("choosing a passage in a stub keeps the directive's label", () => {
  it("withStubQuote preserves `![[id | label]]`", () => {
    const md = `![[${ID} | their post]]\n\nMy reply.`;
    const out = withStubQuote(md, ID, "a passage");
    expect(out.split("\n")[0]).toBe(`![[${ID} | their post]]`);
    expect(out).toContain("> a passage");
    // and back to whole
    expect(withStubQuote(out, ID, null).split("\n")[0]).toBe(`![[${ID} | their post]]`);
  });
});

describe("an own-line directive in TK output takes the same whitespace as DIRECTIVE_LINE", () => {
  it.each([
    ["NBSP before", " "],
    ["form feed before", "\f"],
    ["vertical tab before", "\v"],
  ])("%s: a line the publish walk transcludes is also flagged as an echo", (_name, ws) => {
    const line = `${ws}![[${ID}]]`;
    expect(DIRECTIVE_LINE.test(line), "publish treats it as a directive").toBe(true);
    const md = `[TK]write[=]Intro.\n\n${line}\n\nMore.[/TK]`;
    expect(unrequestedOutputDirectives(md)).toEqual([ID]);
  });

  it("CR (CRLF line ends) does not diverge", () => {
    const md = `[TK]write[=]Intro.\r\n\r\n![[${ID}]]\r\n\r\nMore.[/TK]`;
    expect(DIRECTIVE_LINE.test(`![[${ID}]]\r`)).toBe(true);
    expect(unrequestedOutputDirectives(md)).toEqual([ID]);
  });

  it("end to end: NBSP-led own-line directive in output is quoted AND warned about", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Quoted words.");
    const { res, doc } = await publish(cookie, `Intro.\n\n[TK]write[=]Mine.\n\n ![[${target}]]\n\nMore.[/TK]\n\nOutro.`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const quoted = doc.content_html.includes(`data-blyg-id="${target}"`);
    const warned = typeof res.json.warning === "string" && res.json.warning.includes(target);
    expect({ quoted, warned }).toEqual({ quoted, warned: quoted });
  });
});
