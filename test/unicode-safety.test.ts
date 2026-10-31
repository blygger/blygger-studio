// studio#15, parts 2 and 3: text that has to survive the trip to other
// people's readers. (Part 1, charset-aware imports, is still open.)
import { describe, expect, it } from "vitest";
import { excerptFromHtml } from "../src/markdown.ts";
import { graphemePrefix } from "../src/text.ts";
import { escapeXml, xmlSafe } from "../src/util.ts";
import { apiJson, getPublic, login } from "./helpers.ts";

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

describe("truncation never splits a character", () => {
  it("cuts on grapheme boundaries at every length", () => {
    const text = "Party 👨‍👩‍👧 at the café 🇯🇵 tonight 🎉🎉🎉";
    for (let n = 1; n < text.length; n++) {
      const cut = graphemePrefix(text, n);
      expect(cut.length, String(n)).toBeLessThanOrEqual(n);
      expect(LONE.test(cut), String(n)).toBe(false);
      expect(text.startsWith(cut)).toBe(true);
    }
  });

  it("an excerpt of emoji-heavy text has no lone surrogate", () => {
    const html = `<p>${"🎉".repeat(40)}</p>`;
    for (const n of [59, 60, 61, 79, 80]) expect(LONE.test(excerptFromHtml(html, n)), String(n)).toBe(false);
  });
});

describe("the feed stays well-formed XML", () => {
  it("escapeXml drops what XML 1.0 forbids, and keeps tab, newline and astral characters", () => {
    expect(escapeXml("a\u0001b\tc\nd🎉\uD800e")).toBe("ab\tc\nd🎉e");
    expect(xmlSafe("￾￿ok")).toBe("ok");
  });

  it("a pasted control character and a stray sentinel never reach feed.xml or the item", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "Pasted\u0001 text\u000B with junk in it" })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    const feed = await (await getPublic("/blyg/feed.xml")).text();
    expect(XML_BAD.test(feed)).toBe(false);
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(doc.content_md).toBe("Pasted text with junk in it");
    expect(/[-]/.test(doc.content_html)).toBe(false);
  });
});
