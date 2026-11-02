// Speculative authoring — placeholders (studio-only; no wire change).
//
// Typing `[[some text]]` in the editor creates an empty fragment draft marked
// as a placeholder (migration 0039) and rewrites the text to
// `[[id | some text]]`. These tests pin the Worker half: creation, the item
// resource and list/search surfaces, and publish — a link to an open
// placeholder publishes as its label in plain text, with no anchor, no wire
// entry and no mention, while every other unresolvable link is still an error.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { listOutbound } from "../src/mentions/store.ts";
import { markdownLiteral } from "../src/placeholder.ts";
import { renderMarkdown } from "../src/markdown.ts";
import { newId } from "../src/util.ts";
import { apiJson, BASE, getPublic, login } from "./helpers.ts";

const OURS = "https://example.com/blyg/";

/** Storage is shared across a file's tests: start a counting test from no placeholders. */
async function noPlaceholders() {
  await env.DB.prepare("DELETE FROM items WHERE placeholder_label IS NOT NULL").run();
}

async function placeholder(cookie: string, label: string) {
  const res = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "placeholder", label });
  expect(res.status).toBe(201);
  return res.json as { id: string; placeholder: string | null; contentMd: string; status: string; kind: string; version: number };
}

async function itemDoc(id: string): Promise<any> {
  return (await getPublic(`/blyg/items/${id}.json`)).json<any>();
}

async function draft(cookie: string, contentMd: string, kind: "fragment" | "thread" = "fragment") {
  return (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd, kind })).json.id as string;
}

describe("creating a placeholder", () => {
  it("makes an empty fragment draft that carries its label", async () => {
    const cookie = await login();
    const item = await placeholder(cookie, "  the maintenance\n argument  ");
    expect(item).toMatchObject({ status: "draft", kind: "fragment", version: 0, contentMd: "", placeholder: "the maintenance argument" });
    const row = await env.DB.prepare("SELECT placeholder_label, content_md FROM items WHERE id = ?").bind(item.id).first<any>();
    expect(row).toEqual({ placeholder_label: "the maintenance argument", content_md: "" });
    // Every item read says so, not only the create response.
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${item.id}`)).json.placeholder).toBe("the maintenance argument");
    expect((await apiJson(cookie, "GET", `/blyg/api/items?id=${item.id}`)).json.items[0].placeholder).toBe("the maintenance argument");
    // Any other item reads as no placeholder.
    const plain = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "ordinary" })).json;
    expect(plain.placeholder).toBeNull();
  });

  it("makes the label safe to write inside [[id | …]]", async () => {
    const cookie = await login();
    expect((await placeholder(cookie, "a]]b")).placeholder).toBe("a] ]b");
    expect((await placeholder(cookie, "x".repeat(400))).placeholder).toHaveLength(200);
  });

  it("refuses a label with nothing in it", async () => {
    await noPlaceholders();
    const cookie = await login();
    const res = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "placeholder", label: "   " });
    expect(res.status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE placeholder_label IS NOT NULL").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("is listed, counted and searchable while open, and stops being one when published", async () => {
    await noPlaceholders();
    const cookie = await login();
    const open = await placeholder(cookie, "an essay on hedges");
    await draft(cookie, "an ordinary draft about hedges");

    const listed = (await apiJson(cookie, "GET", "/blyg/api/items?placeholder=true")).json.items.map((i: any) => i.id);
    expect(listed).toEqual([open.id]);
    const others = (await apiJson(cookie, "GET", "/blyg/api/items?placeholder=false")).json.items.map((i: any) => i.id);
    expect(others).not.toContain(open.id);
    expect((await apiJson(cookie, "GET", "/blyg/api/items/summary")).json.placeholders).toBe(1);

    // The link picker asks for placeholders; a quote picker does not, since a quote cannot name one.
    const linkHits = (await apiJson(cookie, "GET", "/blyg/api/search?q=hedges&placeholders=include")).json.items;
    expect(linkHits).toEqual([expect.objectContaining({ id: open.id, placeholder: true, label: "an essay on hedges", version: 0, source: "mine" })]);
    expect((await apiJson(cookie, "GET", "/blyg/api/search?q=hedges")).json.items).toEqual([]);

    // Written and published: an ordinary item.
    await apiJson(cookie, "PATCH", `/blyg/api/items/${open.id}`, { contentMd: "Hedges are slow infrastructure." });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${open.id}/publish`, {})).status).toBe(200);
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${open.id}`)).json.placeholder).toBeNull();
    expect((await apiJson(cookie, "GET", "/blyg/api/items?placeholder=true")).json.items).toEqual([]);
    expect((await apiJson(cookie, "GET", "/blyg/api/items/summary")).json.placeholders).toBe(0);
    const hits = (await apiJson(cookie, "GET", "/blyg/api/search?q=hedges&placeholders=include")).json.items;
    expect(hits).toEqual([expect.objectContaining({ id: open.id, placeholder: false, version: 1 })]);
  });
});

describe("publishing a link to a placeholder", () => {
  it("publishes the link's label as plain text, with no anchor, no wire entry and no mention", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const target = await placeholder(cookie, "the maintenance argument");
    const source = `As I will argue in [[${target.id} | the *maintenance* argument]], order matters.`;
    const id = await draft(cookie, source);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);

    const doc = await itemDoc(id);
    // The label as text, its markdown characters literal: the label is text, not markdown.
    expect(doc.content_html).toContain("As I will argue in the *maintenance* argument, order matters.");
    expect(doc.content_html).not.toContain("<a ");
    expect(doc.content_html).not.toContain("<em>");
    expect(doc.content_md).not.toContain(target.id);
    expect(doc.content_md).not.toContain("[[");
    expect(JSON.stringify(doc)).not.toContain(target.id);
    expect(doc.transclusions ?? []).toEqual([]);
    expect((await listOutbound(env.DB)).filter((r) => r.item_id === id)).toHaveLength(0);
    // The public page agrees.
    const page = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(page).not.toContain(target.id);

    // The working copy keeps the link, so it comes alive on a later republish.
    const working = (await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json;
    expect(working.contentMd).toBe(source);
  });

  it("uses the placeholder's own label when the link has none", async () => {
    const cookie = await login();
    const target = await placeholder(cookie, "notes on <tools> & rituals");
    const id = await draft(cookie, `see [[${target.id}]]`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    expect((await itemDoc(id)).content_html).toContain("see notes on &lt;tools&gt; &amp; rituals");
  });

  it("links for real on the first republish after the placeholder is published", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const target = await placeholder(cookie, "later");
    const id = await draft(cookie, `see [[${target.id} | later]]`, "thread");
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    expect((await itemDoc(id)).content_html).not.toContain("<a ");

    await apiJson(cookie, "PATCH", `/blyg/api/items/${target.id}`, { contentMd: "Now written." });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${target.id}/publish`, {})).status).toBe(200);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    const doc = await itemDoc(id);
    expect(doc.version).toBe(2);
    expect(doc.content_html).toContain(`<a href="${OURS}f/${target.id}/">later</a>`);
  });

  it("still fails for a link to an unknown id or to an ordinary draft", async () => {
    const cookie = await login();
    const target = await placeholder(cookie, "fine");
    const ordinary = await draft(cookie, "an ordinary draft");
    const missing = newId();
    const id = await draft(cookie, `[[${target.id}]] and [[${ordinary}]] and [[${missing}]]`);
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
    expect(res.status).toBe(400);
    expect(res.json.details.errors.map((e: any) => e.reason)).toEqual(["item is a draft, not published", "unknown item"]);
  });

  it("does not treat a quote of a placeholder as text: a directive still needs a published target", async () => {
    const cookie = await login();
    const target = await placeholder(cookie, "quoted");
    const id = await draft(cookie, `![[${target.id}]]\n\nmine`, "thread");
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
    expect(res.status).toBe(400);
    expect(res.json.details.errors[0].reason).toBe("item is a draft, not published");
  });

  it("leaves a link inside code alone: it is text there", async () => {
    const cookie = await login();
    const target = await placeholder(cookie, "the label");
    const id = await draft(cookie, `inline \`[[${target.id} | x]]\` and\n\n\`\`\`\n[[${target.id}]]\n\`\`\`\n\nthen [[${target.id}]]`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    const doc = await itemDoc(id);
    expect(doc.content_md).toContain(`\`[[${target.id} | x]]\``);
    expect(doc.content_md).toContain(`\`\`\`\n[[${target.id}]]\n\`\`\``);
    expect(doc.content_md).toMatch(/then the label$/);
  });

  it("resolves inside a generated block as in the body", async () => {
    const cookie = await login();
    const target = await placeholder(cookie, "gen label");
    const id = await draft(cookie, `[TK]impyrt=See [[${target.id}]] here.[/TK]`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    const doc = await itemDoc(id);
    expect(doc.content_html).toContain("See gen label here.");
    expect(doc.content_html).not.toContain(target.id);
  });
});

describe("previewing a link to a placeholder", () => {
  it("shows it as not yet written rather than as an error", async () => {
    const cookie = await login();
    const target = await placeholder(cookie, "soon");
    for (const kind of ["fragment", "thread"]) {
      const res = await SELF.fetch(`${BASE}/blyg/api/preview`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ contentMd: `see [[${target.id}]] and [[${target.id} | my words]]`, kind }),
      });
      const body = await res.json<{ html: string; linkErrors?: unknown[]; errors?: unknown[] }>();
      expect(body.linkErrors ?? []).toEqual([]);
      expect(body.errors ?? []).toEqual([]);
      expect(body.html).toContain(`data-blyg-placeholder="${target.id}"`);
      expect(body.html).toContain("not yet written");
      expect(body.html).toMatch(/blyg-link-placeholder[^>]*>soon</);
      expect(body.html).toMatch(/blyg-link-placeholder[^>]*>my words</);
      expect(body.html).not.toContain("⚠");
    }
  });
});

describe("markdownLiteral", () => {
  it.each(["the *maintenance* argument", "a_b_c", "[x](y)", "<b>", "1. first", "- item", "# heading", "a | b", "&amp;", "back\\slash", "`tick`"])(
    "renders %s as exactly its text",
    (text) => {
      const html = renderMarkdown(markdownLiteral(text));
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      expect(html.trim()).toBe(`<p>${escaped}</p>`);
    },
  );
});
