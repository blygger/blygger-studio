// `[TK]impyrt=…[/TK]` — decision #37, spec §5.7 rule 7.
//
// Text generated outside this studio and pasted in is disclosed exactly like
// text generated here: a `generated[]` entry and a `blyg-tk-gen` wrapper. The
// claim is "this prose is machine-generated"; where the model ran is not part of
// it, so there is no "external" flag, `sources` is empty ("no sources declared",
// rule 1), and `model` appears only when the author wrote one. Nothing invents
// an `at`.
import { describe, expect, it } from "vitest";
import { markImported, parseScopes } from "../src/tk.ts";
import { apiJson, getPublic, login } from "./helpers.ts";

async function publishDraft(cookie: string, md: string, kind: "fragment" | "thread" = "fragment") {
  const id = (await apiJson(cookie, "POST", "/api/items", { content_md: md, kind })).json.id as string;
  const pub = await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
  return { id, pub };
}

describe("the grammar", () => {
  it("reads the pasted text as output, with or without a model, and with = inside it", () => {
    const { scopes, errors } = parseScopes("A [TK]impyrt=x = y, said the model[/TK] and [TK]impyrt claude-z=more[/TK].");
    expect(errors).toEqual([]);
    expect(scopes[0]).toMatchObject({ instruction: "impyrt", output: "x = y, said the model", imported: {} });
    expect(scopes[1]).toMatchObject({ output: "more", imported: { model: "claude-z" } });
  });

  it("accepts the [=] spelling as the same thing", () => {
    const { scopes } = parseScopes("[TK]impyrt gpt-x[=]pasted[/TK]");
    expect(scopes[0]).toMatchObject({ output: "pasted", imported: { model: "gpt-x" } });
  });

  it("leaves an ordinary instruction alone, even one that mentions impyrt later", () => {
    const { scopes } = parseScopes("[TK]summarize the impyrt=idea[/TK]");
    expect(scopes[0].imported).toBeUndefined();
    expect(scopes[0].output).toBeNull();
  });

  it("declares no sources, even if the pasted text contains a directive", () => {
    const { scopes } = parseScopes("[TK]impyrt=see ![[0123456789abcdefghjkmnpqrs]][/TK]");
    expect(scopes[0].sourceIds).toEqual([]);
  });

  it("grammar quoted in code inside a scope is text: no nesting error, no early close", () => {
    // A release changelog quoting `[TK]` inside an impyrt scope failed to
    // publish as "nested TK scopes" (session 45).
    const md = "[TK]impyrt claude-x=\nThe `[TK]` tool, `[/TK]` and `[=]` too.\n\n```\n[TK]write[=]x[/TK]\n```\nEnd.\n[/TK]";
    const { scopes, errors } = parseScopes(md);
    expect(errors).toEqual([]);
    expect(scopes).toHaveLength(1);
    expect(scopes[0].end).toBe(md.length);
    expect(scopes[0].output).toContain("`[/TK]` and `[=]` too.");
    expect(scopes[0].imported).toEqual({ model: "claude-x" });
  });

  it("a real nested scope is still refused", () => {
    expect(parseScopes("[TK]a [TK]b[/TK] c[/TK]").errors[0].reason).toBe("nested TK scopes are not supported");
  });

  it("the editor's wrap puts exactly the selection inside, and invents no model", () => {
    expect(markImported("before PASTED after", 7, 13)).toBe("before [TK]impyrt=PASTED[/TK] after");
  });
});

describe("publishing", () => {
  it("discloses an inline span: wrapper, generated[] with no sources, no model, no at", async () => {
    const cookie = await login();
    const { id, pub } = await publishDraft(cookie, "My sentence. [TK]impyrt=A sentence a model wrote.[/TK] Mine again.");
    expect(pub.status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(doc.content_md).toBe("My sentence. A sentence a model wrote. Mine again.");
    expect(doc.content_html).toContain('<span class="blyg-tk-gen">A sentence a model wrote.</span>');
    expect(doc.generated).toEqual([{ sources: [] }]);
  });

  it("carries the model when the author wrote one, and wraps a block span as a div", async () => {
    const cookie = await login();
    const { id } = await publishDraft(cookie, "Intro.\n\n[TK]impyrt claude-opus-5=A whole paragraph\nfrom elsewhere.[/TK]\n\nOutro.", "thread");
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(doc.content_html).toMatch(/<div class="blyg-tk-gen"><p>A whole paragraph\s+from elsewhere\.<\/p>\s*<\/div>/);
    expect(doc.generated).toEqual([{ sources: [], model: "claude-opus-5" }]);
  });

  it("keeps disclosure attached to the right span when a scope is added before it", async () => {
    // Positional provenance is the hazard impyrt avoids: its record is in the
    // grammar, so inserting another scope ahead of it cannot move it.
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/api/items", { content_md: "Start. [TK]impyrt=pasted[/TK]" })).json.id as string;
    await apiJson(cookie, "PATCH", `/api/items/${id}`, { content_md: "[TK]hand-written[=]typed by me[/TK] Start. [TK]impyrt=pasted[/TK]" });
    expect((await apiJson(cookie, "POST", `/api/items/${id}/publish`, {})).status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(doc.content_html).toContain('<span class="blyg-tk-gen">pasted</span>');
    // The hand-written output has no recorded provenance, so it is not disclosed.
    expect(doc.content_html).not.toContain('<span class="blyg-tk-gen">typed by me</span>');
    expect(doc.generated).toEqual([{ sources: [] }]);
  });

  it("refuses to regenerate an impyrt scope", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/api/items", { content_md: "[TK]impyrt=pasted[/TK]" })).json.id as string;
    const res = await apiJson(cookie, "POST", `/api/items/${id}/generate`, { scope: 0 });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/not regenerated/);
  });

  it("the preview marks the scope as imported", async () => {
    const cookie = await login();
    const res = await apiJson(cookie, "POST", "/api/preview", { content_md: "[TK]impyrt=pasted[/TK] and [TK]write more[/TK]", kind: "fragment" });
    expect(res.json.scopes.map((s: { imported: boolean }) => s.imported)).toEqual([true, false]);
  });
});
