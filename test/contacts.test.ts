// tn-6 sections 5.1-5.3, #91: `@handle` is consumed at publish on every write
// path, an h-card reaches `content_html`, and the wire carries nothing else.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { consumeHandles, createContact, updateContact } from "../src/contacts.ts";
import { createDraft, getItem, getVersion, publish } from "../src/model.ts";
import { apiJson, login } from "./helpers.ts";

const kyle = () => createContact(env.DB, { handle: "kyle", name: "Kyle Mathews", url: "https://bricolage.io/", ids: ["did:plc:typed"] });

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM contacts").run();
});

async function published(md: string) {
  const item = await createDraft(env.DB, md);
  await publish(env.DB, item, null, "https://me.example/blyg/");
  return getVersion(env.DB, item.id, 1);
}

describe("publish", () => {
  it("turns a known handle into a link in content_md and an h-card in content_html", async () => {
    await kyle();
    const v = await published("Thanks to @kyle for the cache.");
    expect(v?.content_md).toBe("Thanks to [@Kyle Mathews](https://bricolage.io/) for the cache.");
    expect(v?.content_html).toContain('<span class="h-card"><a class="u-url" href="https://bricolage.io/">@<span class="p-name">Kyle Mathews</span></a></span>');
    expect(v?.content_md).not.toContain("@kyle");
  });

  it("keeps @handle in the working copy, as it keeps TK scopes", async () => {
    await kyle();
    const item = await createDraft(env.DB, "@kyle");
    await publish(env.DB, item, null, "https://me.example/blyg/");
    expect((await getItem(env.DB, item.id))?.content_md).toBe("@kyle");
  });

  it("puts self and bound identifiers on the wire and keeps entered ones in the book", async () => {
    const row = await kyle();
    await env.DB.prepare("UPDATE contacts SET ids_json = ? WHERE id = ?")
      .bind(JSON.stringify([{ id: "did:plc:typed", provenance: "entered" }, { id: "did:plc:real", provenance: "bound" }, { id: "acct:k@social.example", provenance: "self" }]), row.id).run();
    const html = (await published("@kyle"))?.content_html ?? "";
    expect(html).toContain('<data class="u-url" value="did:plc:real"></data><data class="u-url" value="acct:k@social.example"></data>');
    expect(html).not.toContain("did:plc:typed");
  });

  it("resolves a handle in a thread without touching what it quotes", async () => {
    await kyle();
    const source = await published("Quoted text with [@Kyle Mathews](https://bricolage.io/) in it");
    const fragment = (await env.DB.prepare("SELECT item_id FROM versions WHERE content_md LIKE 'Quoted text%'").first<{ item_id: string }>())?.item_id;
    expect(source).toBeTruthy();
    const thread = await createDraft(env.DB, `@kyle wrote:\n\n![[${fragment}]]`, "thread");
    await publish(env.DB, thread, null, "https://me.example/blyg/");
    const v = await getVersion(env.DB, thread.id, 1);
    expect(v?.content_md).toContain("[@Kyle Mathews](https://bricolage.io/) wrote:");
    expect(v?.content_html).toContain('<span class="h-card">');
    expect(v?.content_html).toContain("blyg-transclusion");
  });

  it("measures the fragment cap before a handle expands", async () => {
    await createContact(env.DB, { handle: "k", name: "A Very Long Display Name", url: "https://example.com/a/very/long/path/that/expands/the/text/" });
    const item = await createDraft(env.DB, `@k ${"x".repeat(995)}`);
    await expect(publish(env.DB, item, null, "https://me.example/blyg/")).resolves.toBe(1);
  });

  it("uses a corrected contact at the next version and leaves the old one alone", async () => {
    const row = await kyle();
    const item = await createDraft(env.DB, "@kyle");
    await publish(env.DB, item, null, "https://me.example/blyg/");
    await updateContact(env.DB, row, { url: "https://kyle.example/" });
    await publish(env.DB, (await getItem(env.DB, item.id))!, null, "https://me.example/blyg/");
    expect((await getVersion(env.DB, item.id, 1))?.content_md).toContain("bricolage.io");
    expect((await getVersion(env.DB, item.id, 2))?.content_md).toContain("kyle.example");
  });
});

describe("consumeHandles", () => {
  it.each([
    ["an email address", "write to me@kyle.example or kyle@example.com"],
    ["a fediverse handle", "follow @kyle@social.example"],
    ["a domain handle", "see @kyle.example"],
    ["a URL path", "https://social.example/@kyle"],
    ["a code span", "run `@kyle` now"],
    ["a code block", "```\n@kyle\n```"],
    ["a markdown link", "[@kyle](https://x.example/)"],
    ["a link label", "[[0123456789abcdefghjkmnpqrs | @kyle]]"],
    ["a quoted line", "> @kyle said so"],
  ])("leaves %s alone", async (_, md) => {
    await kyle();
    expect((await consumeHandles(env.DB, md)).text).toBe(md);
  });

  it("matches case-insensitively and at the end of a sentence", async () => {
    await kyle();
    expect((await consumeHandles(env.DB, "(@KYLE).")).text).toBe("([@Kyle Mathews](https://bricolage.io/)).");
  });

  it("escapes markdown in a name and parentheses in a URL", async () => {
    await createContact(env.DB, { handle: "odd", name: "A_[B]", url: "https://x.example/a(b)" });
    expect((await consumeHandles(env.DB, "@odd")).text).toBe("[@A\\_\\[B\\]](https://x.example/a%28b%29)");
  });

  it("reports unknown handles once each, and nothing while the book is empty", async () => {
    expect((await consumeHandles(env.DB, "@nobody")).unresolved).toEqual([]);
    await kyle();
    const out = await consumeHandles(env.DB, "@nobody and @nobody and @kyle");
    expect(out.unresolved).toEqual(["nobody"]);
    expect(out.text).toContain("@nobody and @nobody");
  });
});

describe("/contacts", () => {
  it("only ever enters identifiers, and an edit keeps what was earned", async () => {
    const cookie = await login();
    // No path may assert provenance (tn-6 section 5.6): the member is refused outright.
    const asserted = await apiJson(cookie, "POST", "/blyg/api/contacts", { handle: "ada", name: "Ada", url: "https://ada.example/", provenance: "self" });
    expect(asserted.status).toBe(400);
    const made = await apiJson(cookie, "POST", "/blyg/api/contacts", { handle: "ada", name: "Ada", url: "https://ada.example/", ids: ["did:web:ada.example"] });
    expect(made.status).toBe(201);
    expect(made.json.ids).toEqual([{ id: "did:web:ada.example", provenance: "entered" }]);
    await env.DB.prepare("UPDATE contacts SET ids_json = ? WHERE id = ?").bind(JSON.stringify([{ id: "did:web:ada.example", provenance: "self" }]), made.json.id).run();
    const edited = await apiJson(cookie, "PATCH", `/blyg/api/contacts/${made.json.id}`, { ids: ["did:web:ada.example", "acct:ada@social.example"] });
    expect(edited.json.ids).toEqual([{ id: "did:web:ada.example", provenance: "self" }, { id: "acct:ada@social.example", provenance: "entered" }]);
  });

  it("refuses a bad handle, a non-https URL and a duplicate", async () => {
    const cookie = await login();
    const post = (body: object) => apiJson(cookie, "POST", "/blyg/api/contacts", body);
    expect((await post({ handle: "no spaces", name: "A", url: "https://a.example/" })).status).toBe(400);
    expect((await post({ handle: "a", name: "A", url: "http://a.example/" })).status).toBe(400);
    expect((await post({ handle: "a", name: "A", url: "https://a.example/" })).status).toBe(201);
    expect((await post({ handle: "A", name: "A", url: "https://a.example/" })).status).toBe(409);
  });

  it("publish and preview tell every client about unresolved handles", async () => {
    const cookie = await login();
    await kyle();
    const preview = await apiJson(cookie, "POST", "/blyg/api/preview", { contentMd: "@kyle and @nobody" });
    expect(preview.json.unresolvedHandles).toEqual(["nobody"]);
    expect(preview.json.html).toContain('class="h-card"');
    const item = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "@kyle and @nobody" });
    const done = await apiJson(cookie, "POST", `/blyg/api/items/${item.json.id}/publish`, {});
    expect(done.status).toBe(200);
    expect(done.json.unresolvedHandles).toEqual(["nobody"]);
  });
});
