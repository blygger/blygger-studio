// The label — `[[id | text]]` and `![[id | text]]` (0.4 §10.1, decision #70).
//
// An optional author's label after the id, ignored by resolution. On a link it
// is the anchor text; on a directive it is a note for the author that never
// reaches the bake, `transclusions[]` or provenance. The id is positional, so
// the first pipe after it separates and the label may itself contain a pipe;
// there is no escape, so a label ends at the first `]]`.
import { describe, expect, it } from "vitest";
import { DIRECTIVE_LINE, label, labelText, linkInline, linkSource } from "../src/grammar.ts";
import { flattenFork } from "../src/fork-flatten.ts";
import { parseScopes } from "../src/tk.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const ID = "7c9wk2n4h6q1x8v0z3m5rjy2ke";
const OURS = "https://example.com/blyg/";

const link = (text: string) => [...text.matchAll(linkInline())].map((m) => ({ id: m[1], label: label(m[2]) }));
const directive = (line: string) => {
  const m = DIRECTIVE_LINE.exec(line);
  return m ? { id: m[1], label: label(m[2]) } : null;
};

describe("the grammar", () => {
  it.each([
    [`[[${ID}]]`, undefined],
    [`[[${ID} | the opening fragment]]`, "the opening fragment"],
    [`[[${ID}|tight]]`, "tight"],
    [`[[${ID}   |   padded   ]]`, "padded"],
    [`[[${ID} | either | or]]`, "either | or"],
    [`[[${ID} | a ] single bracket]]`, "a ] single bracket"],
    [`[[${ID} | [nested] brackets]]`, "[nested] brackets"],
    [`[[${ID} |]]`, undefined],
    [`[[${ID} |   ]]`, undefined],
  ])("reads %s as a link with label %s", (text, expected) => {
    expect(link(text)).toEqual([{ id: ID, label: expected }]);
  });

  it("ends a label at the first ]], since there is no escape", () => {
    expect(link(`[[${ID} | cut]] here]]`)).toEqual([{ id: ID, label: "cut" }]);
  });

  it("finds several links on a line, each with its own label", () => {
    expect(link(`see [[${ID} | one]] and [[${ID}]] too`)).toEqual([
      { id: ID, label: "one" },
      { id: ID, label: undefined },
    ]);
  });

  it("reads nothing that is not an id first", () => {
    expect(link(`[[a label | ${ID}]]`)).toEqual([]); // label-first is literal text (#71)
    expect(link(`[[${ID.slice(1)} | short id]]`)).toEqual([]);
    expect(link(`[[${ID}x]]`)).toEqual([]);
    expect(link(`[[just words]]`)).toEqual([]);
  });

  it("never reads a directive as a link, labelled or not", () => {
    expect(link(`![[${ID} | a quote]]`)).toEqual([]);
  });

  it("reads a labelled directive line, and only a whole line", () => {
    expect(directive(`![[${ID} | the source]]`)).toEqual({ id: ID, label: "the source" });
    expect(directive(`  ![[${ID}]]  `)).toEqual({ id: ID, label: undefined });
    expect(directive(`text ![[${ID} | inline]]`)).toBeNull();
  });

  it("writes the long form, rewriting what the grammar cannot hold", () => {
    expect(linkSource(ID)).toBe(`[[${ID}]]`);
    expect(linkSource(ID, "A title")).toBe(`[[${ID} | A title]]`);
    expect(linkSource(ID, "  ")).toBe(`[[${ID}]]`);
    expect(labelText("two\nlines")).toBe("two lines");
    expect(labelText("ends ]] early")).toBe("ends ] ] early");
    expect(link(linkSource(ID, "ends ]] early"))).toEqual([{ id: ID, label: "ends ] ] early" }]);
  });

  it("takes a labelled source ref in a [TK] instruction by its id", () => {
    const { scopes } = parseScopes(`[TK]summarise ![[${ID} | their post]] briefly[/TK]`);
    expect(scopes[0].sourceIds).toEqual([ID]);
  });
});

async function publish(cookie: string, body: Record<string, unknown>): Promise<string> {
  const created = await apiJson(cookie, "POST", "/blyg/api/items", body);
  const id = created.json.id as string;
  const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return id;
}
const doc = async (id: string) => (await getPublic(`/blyg/items/${id}.json`)).json<any>();

describe("a labelled link", () => {
  it("shows the label as its text, escaped, and stays silent", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const target = await createAndPublish(cookie, "# Their heading\n\nBody.");
    const id = await publish(cookie, { content_md: `As in [[${target} | the <b>earlier</b> | note]], yes.` });
    const d = await doc(id);
    expect(d.content_html).toContain(
      `As in <a href="${OURS}f/${target}/">the &lt;b&gt;earlier&lt;/b&gt; | note</a>, yes.`,
    );
    expect(d.content_html).not.toContain("Their heading");
    expect(d.transclusions ?? []).toEqual([]);
    // content_md keeps what the author wrote: other clients parse it (§10.1).
    expect(d.content_md).toContain(`[[${target} | the <b>earlier</b> | note]]`);
  });

  it("falls back to the target's own text when the label is empty", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: OURS });
    const target = await createAndPublish(cookie, "# The real title\n\nBody.");
    const id = await publish(cookie, { content_md: `See [[${target} | ]].` });
    expect((await doc(id)).content_html).toContain(`<a href="${OURS}f/${target}/">The real title</a>`);
  });

  it("is inert inside code, label and all (#54)", async () => {
    const cookie = await login();
    const id = await publish(cookie, { content_md: `Write \`[[${ID} | a label]]\` to label a link.` });
    expect((await doc(id)).content_html).toContain(`<code>[[${ID} | a label]]</code>`);
  });
});

describe("a labelled directive", () => {
  it("quotes as if unlabelled: the label reaches neither the bake nor the record", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Words worth quoting.");
    const id = await publish(cookie, { kind: "thread", content_md: `Intro.\n\n![[${target} | note to self]]\n\nOutro.` });
    const d = await doc(id);
    expect(d.content_html).toContain(`data-blyg-id="${target}"`);
    expect(d.content_html).toContain("Words worth quoting.");
    expect(d.content_html).not.toContain("note to self");
    expect(d.transclusions).toEqual([expect.objectContaining({ id: target, version: 1 })]);
    expect(JSON.stringify(d.transclusions)).not.toContain("note to self");
  });

  it("keeps its attached blockquote as a partial quote", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "First sentence here. Second sentence there.");
    const id = await publish(cookie, {
      kind: "thread",
      content_md: `![[${target} | the second sentence]]\n> Second sentence there.\n\nMy reply.`,
    });
    const d = await doc(id);
    expect(d.content_html).toContain("blyg-partial");
    expect(d.transclusions[0].selector.exact).toBe("Second sentence there.");
  });
});

describe("the picker writes the long form", () => {
  it("search hits carry the label a link would show", async () => {
    const cookie = await login();
    await createAndPublish(cookie, "# Labeltoken heading\n\nBody text.");
    await createAndPublish(cookie, "labeltoken with no heading at all");
    const res = await apiJson(cookie, "GET", "/blyg/api/search?q=labeltoken");
    const labels = res.json.items.map((h: { label: string }) => h.label).sort();
    expect(labels).toEqual(["Labeltoken heading", "“labeltoken with no heading at all”"]);
  });
});

describe("fork flattening", () => {
  const ctx = { origin: OURS, link: async (o: string, id: string) => `${o}items/${id}.json` };
  const ID1 = "1111111111111111111111111a", ID2 = "2222222222222222222222222b";

  it("flattens a labelled link to its baked anchor, and a labelled directive like any other (#63)", async () => {
    const md = `See [[${ID1} | my name for it]].\n\n![[${ID2} | a note]]\n\nAfter.`;
    const html =
      `<p>See <a href="${OURS}f/${ID1}/">my name for it</a>.</p>\n` +
      `<blockquote class="blyg-transclusion" data-blyg-id="${ID2}" data-blyg-version="1">\n<p>Quoted.</p>\n</blockquote>\n<p>After.</p>`;
    const out = await flattenFork({ contentMd: md, contentHtml: html, generated: [] }, ctx);
    expect(out.exact).toBe(true);
    expect(out.contentMd).toContain(`See [my name for it](${OURS}f/${ID1}/).`);
    expect(out.contentMd).not.toContain("a note");
    expect(out.contentMd).toContain("> Quoted.");
  });
});
