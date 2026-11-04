// The word-count extension (extensions/word-count): an item's words, and the
// words of the document its outline links make. The Worker suite compiles
// every extension in; these tests enable this one.
// What these pin:
//   1. Only outline links count as structure: a list item that is just a link.
//      Inline links (navigation, citations) and links in code are not followed.
//   2. Transcluded text is in the thread's own count and is not followed.
//   3. The roll-up is a strict tree or nothing: a cycle, a repeat, or a link to
//      anything that is not our published item gives no total, and says why.
//   4. Off, the route is a 404.
import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiJson, createAndPublish, login } from "./helpers.ts";
import { putSettings } from "../src/model.ts";
import { draftHtml, outlineLinks, rollup, type CountedItem } from "../extensions/word-count/tree.ts";
import { countWords } from "../extensions/word-count/count.ts";

const A = "0000000000000000000000000a";
const B = "0000000000000000000000000b";
const C = "0000000000000000000000000c";

describe("outline links", () => {
  it("are list items holding one link and nothing else", () => {
    const md = [`- [[${A} | Chapter 1]]`, `1. [[${B}]]`, `  * [[${C}|Nested]]`, "", `[[${A} | ← Previous]] · [[${B} | Next →]]`, `- See [[${C}]] for more`, `- ![[${C}]]`].join("\n");
    expect(outlineLinks(md)).toEqual([A, B, C]);
  });
  it("are inert inside code", () => {
    expect(outlineLinks(["```", `- [[${A}]]`, "```", `- \`[[${B}]]\``].join("\n"))).toEqual([]);
  });
});

describe("rollup", () => {
  const graph = (items: Record<string, string[]>, words = 10) => async (ids: string[]) =>
    new Map(ids.filter((id) => id in items).map((id): [string, CountedItem] => [id, { count: { words, cjk: 0 }, children: items[id] }]));

  it("sums a strict tree", async () => {
    expect(await rollup("r", graph({ r: [A, B], [A]: [C], [B]: [], [C]: [] }))).toEqual({ document: { words: 40, cjk: 0, items: 4 } });
  });
  it("gives no total for a cycle, a repeat, or an item not held", async () => {
    expect(await rollup("r", graph({ r: [A], [A]: ["r"] }))).toEqual({ document: null, reason: "cycle" });
    expect(await rollup("r", graph({ r: [A, B], [A]: [C], [B]: [C], [C]: [] }))).toEqual({ document: null, reason: "repeated" });
    expect(await rollup("r", graph({ r: [A, A], [A]: [] }))).toEqual({ document: null, reason: "repeated" });
    expect(await rollup("r", graph({ r: [A] }))).toEqual({ document: null, reason: "unavailable" });
  });
  it("counts each tree level in one load", async () => {
    const calls: string[][] = [];
    const load = graph({ r: [A, B], [A]: [C], [B]: [], [C]: [] });
    await rollup("r", async (ids) => (calls.push(ids), load(ids)));
    expect(calls).toEqual([["r"], [A, B], [C]]);
  });
});

describe("draftHtml", () => {
  it("reads links as their labels and leaves directives out", () => {
    expect(countWords(draftHtml(`Two words, [[${A} | three more words]] and [[${B}]].\n\n![[${C}]]\n\n\`[[${A}]]\``))).toEqual({ words: 7, cjk: 0 });
  });
});

describe("countWords", () => {
  it("counts words, and Han, kana and Hangul by the character", () => {
    expect(countWords("<p>It’s <em>well-known</em> &amp; true.</p><script>var x = 1</script>")).toEqual({ words: 3, cjk: 0 });
    expect(countWords("<p>日本語 text</p>")).toEqual({ words: 1, cjk: 3 });
  });
});

describe("the counts route", () => {
  beforeAll(() => putSettings(env.DB, { extensions: JSON.stringify(["word-count"]) }));
  afterAll(() => putSettings(env.DB, { extensions: "[]" }));

  const counts = (cookie: string, ids: string[]) => apiJson(cookie, "GET", `/blyg/api/ext/word-count/counts?keys=${encodeURIComponent(JSON.stringify(ids.map((id) => `own:${id}`)))}`);
  async function publishThread(cookie: string, md: string): Promise<string> {
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: md, kind: "thread" })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    return id;
  }

  it("rolls a contents thread up over its outline, not its navigation or citations", async () => {
    const cookie = await login();
    const note = await createAndPublish(cookie, "One two three.");
    const quoted = await createAndPublish(cookie, "Four five.");
    const ch1 = await publishThread(cookie, `Six seven eight nine.\n\n![[${quoted}]]\n\n- [[${note} | Note]]`);
    const ch2 = await publishThread(cookie, `Ten eleven, citing [[${note}]].`);
    const toc = await publishThread(cookie, `- [[${ch1} | One]]\n- [[${ch2} | Two]]`);
    // Navigation back to the contents, as a book's chapters carry it.
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${ch2}`, { contentMd: `[[${ch1} | ← One]] · [[${toc} | Contents]]\n\nTen eleven, citing [[${note}]].` })).status).toBe(200);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${ch2}/publish`, {})).status).toBe(200);

    const got = await counts(cookie, [toc, ch1, ch2]);
    expect(got.status).toBe(200);
    const c = got.json.counts;
    const own = (id: string) => c[`own:${id}`].words as number;
    // The quoted fragment's words are in ch1's own count, the note is not.
    expect(own(ch1)).toBeGreaterThanOrEqual(6);
    expect(c[`own:${ch1}`].document).toEqual({ words: own(ch1) + 3, cjk: 0, items: 2 });
    expect(c[`own:${ch2}`].document).toEqual({ words: own(ch2), cjk: 0, items: 1 });
    expect(c[`own:${toc}`].document).toEqual({ words: own(toc) + own(ch1) + 3 + own(ch2), cjk: 0, items: 4 });
  });

  it("gives no total when an outline lists an item twice, and says why", async () => {
    const cookie = await login();
    const leaf = await createAndPublish(cookie, "Leaf.");
    const a = await publishThread(cookie, `- [[${leaf}]]`);
    const top = await publishThread(cookie, `- [[${a}]]\n- [[${leaf}]]`);
    const got = (await counts(cookie, [top])).json.counts[`own:${top}`];
    expect(got).toMatchObject({ document: null, reason: "repeated" });
    expect(got.words).toBeGreaterThan(0);
  });

  it("gives no total for an outline cycle", async () => {
    const cookie = await login();
    const a = await publishThread(cookie, "Alpha.");
    const b = await publishThread(cookie, `- [[${a}]]`);
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${a}`, { contentMd: `- [[${b}]]` })).status).toBe(200);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${a}/publish`, {})).status).toBe(200);
    expect((await counts(cookie, [a])).json.counts[`own:${a}`]).toMatchObject({ document: null, reason: "cycle" });
  });

  it("gives no total when an outline lists a withdrawn item, and omits keys it cannot count", async () => {
    const cookie = await login();
    const gone = await createAndPublish(cookie, "Soon gone.");
    const top = await publishThread(cookie, `- [[${gone}]]`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${gone}/withdraw`, {})).status).toBe(200);
    const got = (await counts(cookie, [top, gone])).json.counts;
    expect(got[`own:${top}`]).toMatchObject({ document: null, reason: "unavailable" });
    expect(got[`own:${gone}`]).toBeUndefined();
  });

  it("counts drafts from their working copy, as roots and in the tree", async () => {
    const cookie = await login();
    const draft = async (contentMd: string) => (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd, kind: "thread" })).json.id as string;
    const leaf = await createAndPublish(cookie, "One two three.");
    const part = await draft(`Four five six seven.\n\n- [[${leaf}]]`);
    const book = await draft(`Eight nine.\n\n- [[${part} | Part one]]`);
    const got = (await counts(cookie, [book, part])).json.counts;
    // The book's own words: its text and its outline entry's label.
    expect(got[`own:${book}`]).toMatchObject({ words: 4, document: { words: 4 + 4 + 3, items: 3 } });
    expect(got[`own:${part}`]).toMatchObject({ words: 4, document: { words: 7, items: 2 } });
  });

  it("refuses keys that are not a JSON array", async () => {
    const cookie = await login();
    expect((await apiJson(cookie, "GET", "/blyg/api/ext/word-count/counts?keys=nope")).status).toBe(400);
  });

  it("is a 404 while the extension is off", async () => {
    const cookie = await login();
    await putSettings(env.DB, { extensions: "[]" });
    try {
      expect((await counts(cookie, [A])).status).toBe(404);
    } finally {
      await putSettings(env.DB, { extensions: JSON.stringify(["word-count"]) });
    }
  });
});
