// The dictionary (src/dictionary.ts, migration 0049): words this blyg's spellchecking accepts.
// What these pin:
//   1. Words live in sources: "owner" for the author's, any other name for an installed set.
//      A PUT replaces one source and leaves the rest; an empty list removes it.
//   2. Words are kept as written (names keep capitals), in NFC, repeats once; a word with
//      whitespace, no letter, or over 64 characters is refused, naming it.
//   3. PUT is conditional on the dictionary's revision: a stale one is a 409 carrying the
//      current dictionary.
//   4. Source names are checked, and the limits hold.
import { describe, expect, it } from "vitest";
import { apiJson, login } from "./helpers.ts";

const put = (cookie: string, source: string, words: string[], expectedRevision: number) => apiJson(cookie, "PUT", `/blyg/api/dictionary/${source}`, { words, expectedRevision });
const get = async (cookie: string) => (await apiJson(cookie, "GET", "/blyg/api/dictionary")).json as { sources: { source: string; words: string[] }[]; revision: number };

describe("dictionary", () => {
  it("keeps sources apart, owner first, and removes one with an empty list", async () => {
    const cookie = await login();
    const start = await get(cookie);
    let r = await put(cookie, "medical-terms", ["tachycardia", "anamnesis"], start.revision);
    expect(r.status).toBe(200);
    r = await put(cookie, "owner", ["blyg", "Venkatesh", "blyg", "café"], r.json.revision);
    expect(r.status).toBe(200);
    expect(r.json.revision).toBe(start.revision + 2);
    const owner = r.json.sources[0];
    expect(owner).toEqual({ source: "owner", words: ["blyg", "café", "Venkatesh"] });
    expect(r.json.sources.find((s: { source: string }) => s.source === "medical-terms").words).toEqual(["anamnesis", "tachycardia"]);
    // Replacing one source leaves the other alone.
    r = await put(cookie, "owner", ["blyg"], r.json.revision);
    expect(r.json.sources.find((s: { source: string }) => s.source === "medical-terms").words).toHaveLength(2);
    r = await put(cookie, "medical-terms", [], r.json.revision);
    expect(r.json.sources.map((s: { source: string }) => s.source)).not.toContain("medical-terms");
    expect(await get(cookie)).toEqual(r.json);
  });

  it("refuses a word that isn't one, naming it", async () => {
    const cookie = await login();
    const { revision } = await get(cookie);
    for (const bad of ["two words", "1234", "x".repeat(65), ""]) {
      const r = await put(cookie, "owner", ["fine", bad], revision);
      expect(r.status).toBe(400);
      expect(r.json.details?.word ?? r.json.word).toBe(bad);
    }
    expect((await get(cookie)).revision).toBe(revision);
  });

  it("is a 409 with the current dictionary on a stale revision", async () => {
    const cookie = await login();
    const { revision } = await get(cookie);
    expect((await put(cookie, "owner", ["first"], revision)).status).toBe(200);
    const stale = await put(cookie, "owner", ["second"], revision);
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.json)).toContain("revision-conflict");
    expect(JSON.stringify(stale.json)).toContain("first");
  });

  it("checks source names", async () => {
    const cookie = await login();
    const { revision } = await get(cookie);
    for (const bad of ["Owner", "-x", "x-", "a_b", "a".repeat(49)]) expect((await put(cookie, bad, ["word"], revision)).status).toBe(400);
  });
});
