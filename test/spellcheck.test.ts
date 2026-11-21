// The spellcheck extension (extensions/spellcheck). The Worker suite compiles every extension in;
// these tests enable this one for its routes.
// What these pin:
//   1. Only prose is checked: markup, links, ids, code, math, URLs and TK instructions are not.
//   2. The word list knows ordinary English, a capital at a sentence start, and possessives; it
//      doesn't know a lower-case name, and it offers the likely word first.
//   3. The AI proofread keeps only fixes it can apply: found in the text, and changing something.
//   4. The word list is served to the owner; off, the routes are a 404; with no AI configured the
//      proofread says so.
import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiJson, login } from "./helpers.ts";
import { putSettings } from "../src/model.ts";
import { misspellings, prose, speller, unpack } from "../extensions/spellcheck/ui/spell.ts";
import { readIssues } from "../extensions/spellcheck/proofread.ts";
import { WORDS, WORDS_GZ } from "../extensions/spellcheck/words-en-us.ts";

const ID = "0000000000000000000000000a";
const words = (text: string, extra: string[] = []) => misspellings(text, speller(["the", "cat", "sat", "on", "a", "mat", "London", "it", "was", "here"], extra)).map((m) => m.word);

describe("prose", () => {
  it("blanks markup, links, ids, code, math, URLs and TK instructions, keeping offsets", () => {
    const md = `Teh [[${ID} | Labl]] ![[${ID}]] \`cdoe\` $x^2$ https://exmple.com [lnk](http://a.b/qq) [TK]instrction[=]outpt[/TK] <spn> @hndl\n\n[index: hardnss]: #`;
    const kept = prose(md);
    expect(kept).toHaveLength(md.length);
    expect(kept.match(/\p{L}+/gu)).toEqual(["Teh", "Labl", "lnk", "outpt"]);
  });
  it("blanks fenced code", () => {
    expect(prose("Fine.\n\n```\nnot chekced\n```\n\nAfter.").includes("chekced")).toBe(false);
  });
});

describe("misspellings", () => {
  it("finds unknown words with their offsets", () => {
    expect(misspellings("the cta sat", speller(["the", "cat", "sat"]))).toEqual([{ word: "cta", start: 4, end: 7 }]);
  });
  it("accepts a capital at a sentence start, but not a lower-case name", () => {
    expect(words("The cat sat. It was here.")).toEqual([]);
    expect(words("london")).toEqual(["london"]);
    expect(words("London")).toEqual([]);
  });
  it("leaves possessives, acronyms, camel case and one letter alone", () => {
    expect(words("the cat's mat, NASA, iPhone, a b")).toEqual([]);
  });
  it("accepts a prefix before a hyphen, a part of a known compound, and citation Latin", () => {
    const check = speller(["industrial", "single", "singlehandedly", "the", "cat"]);
    expect(misspellings("pre-industrial, single-handedly, et al. the cat", check)).toEqual([]);
    expect(misspellings("xq-industrial", check).map((m) => m.word)).toEqual(["xq"]);
  });
  it("honours the author's own words", () => {
    expect(words("the blyg sat", ["blyg"])).toEqual([]);
  });
});

describe("the word list", () => {
  it("unpacks, knows ordinary prose, and suggests the likely word first", async () => {
    const list = await unpack(WORDS_GZ);
    expect(list).toHaveLength(WORDS);
    const check = speller(list);
    const text = "The quick brown fox jumps over the lazy dog. We'll receive their letters, and it's theirs to keep.";
    expect(misspellings(text, check)).toEqual([]);
    expect(misspellings("Teh fox will recieve it.", check).map((m) => m.word)).toEqual(["Teh", "recieve"]);
    expect(check.suggest("Teh")[0]).toBe("The");
    expect(check.suggest("recieve")[0]).toBe("receive");
  });
});

describe("readIssues", () => {
  const text = "Their going to the the store.";
  it("keeps fixes found in the text and changing it", () => {
    const answer = 'Here: [{"find":"Their going","replace":"They\'re going","why":"wrong word"},{"find":"the the store","replace":"the store","why":"doubled word"},{"find":"not here","replace":"x","why":""},{"find":"store.","replace":"store.","why":"same"}]';
    expect(readIssues(answer, text)).toEqual([
      { find: "Their going", replace: "They're going", why: "wrong word" },
      { find: "the the store", replace: "the store", why: "doubled word" },
    ]);
  });
  it("is empty for an answer that isn't a JSON array", () => {
    expect(readIssues("No issues found.", text)).toEqual([]);
    expect(readIssues("[not json", text)).toEqual([]);
  });
});

describe("routes", () => {
  it("are a 404 while the extension is off", async () => {
    const cookie = await login();
    expect((await apiJson(cookie, "GET", "/blyg/api/ext/spellcheck/words")).status).toBe(404);
  });
  describe("enabled", () => {
    beforeAll(() => putSettings(env.DB, { extensions: JSON.stringify(["spellcheck"]) }));
    afterAll(() => putSettings(env.DB, { extensions: "[]" }));
    it("serve the word list with its notice", async () => {
      const cookie = await login();
      const { status, json } = await apiJson(cookie, "GET", "/blyg/api/ext/spellcheck/words");
      expect(status).toBe(200);
      expect(json.lang).toBe("en-US");
      expect(json.words).toBe(WORDS);
      expect(json.gz).toBe(WORDS_GZ);
      expect(json.notice).toContain("Kevin Atkinson");
    });
    it("proofread: a missing item is a 404; with no AI model configured it says so", async () => {
      const cookie = await login();
      expect((await apiJson(cookie, "GET", `/blyg/api/ext/spellcheck/proofread?id=${ID}`)).status).toBe(404);
      const id = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "Teh draft.", kind: "thread" })).json.id as string;
      const { status, json } = await apiJson(cookie, "GET", `/blyg/api/ext/spellcheck/proofread?id=${id}`);
      expect(status).toBe(422);
      expect(JSON.stringify(json)).toMatch(/model/i);
    });
  });
});
