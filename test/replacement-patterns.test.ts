// studio#2: author text spliced with a *string* replacement had `$&`, `$'`,
// `` $` ``, `$$` and `$1` expanded as patterns. Text must land verbatim.
import { describe, expect, it } from "vitest";
import { linkLeadingTitle } from "../src/pages.ts";
import { apiJson, getPublic, login } from "./helpers.ts";

const NASTY = "Cost $& and $$ and $` and $' and $1 end";

describe("replacement patterns in author text", () => {
  it("a block TK span with $-patterns publishes verbatim", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: `Intro.\n\n[TK]impyrt=${NASTY}[/TK]\n\nOutro.` })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    // Markdown escapes the ampersand; every other character lands as written.
    expect(doc.content_html).toContain(`<div class="blyg-tk-gen"><p>${NASTY.replace("&", "&amp;")}</p>`);
  });

  it("a leading heading with $-patterns is linked, not duplicated", () => {
    expect(linkLeadingTitle("<h1>Price $& $$</h1><p>x</p>", "/i/1")).toBe('<h1><a class="item-title" href="/i/1">Price $& $$</a></h1><p>x</p>');
  });
});
