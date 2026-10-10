// The bracket palette (session 28). Two things are under test here and they
// are deliberately different kinds of test:
//
//  1. `paletteTrigger` / `paletteInsert` — the pure half, compiled out of the
//     emitted script with `new Function` and called directly. This is the
//     behaviour half the house rule asks for: a markup assertion would pass
//     whether or not the palette ever fires on the right bracket form.
//  2. The panel's presence on all three composers, which is what the
//     carry-over was actually about — the picker existed and only one page
//     could reach it.
//
// The `![[` / `[[` pairing these functions implement is the client-side twin
// of DIRECTIVE_LINE and LINK_INLINE in transclusion.ts, so the cases below
// mirror that file's: own-line vs inline, and the `!` that separates them.
import { describe, expect, it } from "vitest";
import { apiJson, createAndPublish, login } from "./helpers.ts";
import { paletteTrigger as trigger, paletteInsert as insert, type Trigger } from "../src/palette.ts";

/** `|` marks the caret, which is how these cases are easiest to read. */
function at(withCaret: string, allowTransclude = true): Trigger {
  const caret = withCaret.indexOf("|");
  expect(caret, "the case must mark a caret").toBeGreaterThanOrEqual(0);
  return trigger(withCaret.replace("|", ""), caret, allowTransclude);
}

describe("paletteTrigger — which bracket form the caret is in", () => {
  it("offers the directive for `![[` alone on its line", () => {
    expect(at("![[|")).toMatchObject({ form: "transclude", query: "", start: 0 });
    expect(at("  ![[frag|")).toMatchObject({ form: "transclude", query: "frag" });
    // The insertion replaces from the line start, not from the `!`, so the
    // leading whitespace goes with it — a directive owns its whole line.
    expect(at("  ![[|")).toMatchObject({ start: 0 });
    expect(at("first line\n![[x|")).toMatchObject({ form: "transclude", start: 11 });
  });

  it("offers the link for `[[` anywhere, mid-sentence included", () => {
    expect(at("as I said in [[|")).toMatchObject({ form: "link", query: "", start: 13 });
    expect(at("[[abc|")).toMatchObject({ form: "link", query: "abc", start: 0 });
    expect(at("line one\nand [[q|")).toMatchObject({ form: "link", start: 13 });
  });

  it("never offers a link for the directive's own brackets", () => {
    // The client-side spelling of LINK_INLINE's `(?<!!)`. Without it, an
    // own-line `![[` on a page that does not allow transclusion would fall
    // through to the link form and insert `[[id]]` inside the `!`.
    expect(at("![[|", false)).toBeNull();
    expect(at("  ![[frag|", false)).toBeNull();
  });

  it("offers nothing for an inline `![[` outside a [TK] scope", () => {
    expect(at("see ![[|")).toBeNull();
    expect(at("[TK]done[=]out[/TK] then ![[|")).toBeNull();
  });

  it("offers a source for `![[` in a [TK] scope's instruction, inline or own-line (#44, #60)", () => {
    // Any item a directive may name is a source since G8, so the picker that
    // lists them is the right one; the insertion is the `![[id]]` in place.
    expect(at("[TK]summarise ![[x|")).toMatchObject({ form: "source", query: "x", start: 14 });
    expect(at("intro\n[TK]compare ![[|")).toMatchObject({ form: "source", start: 18 });
    // Own-line inside the instruction is a source too, not a quote of the thread.
    expect(at("[TK]draw on\n![[|")).toMatchObject({ form: "source", start: 12 });
    expect(at("[TK]draw on\n![[|", false)).toMatchObject({ form: "source" });
    // In the output a directive is not a source (#60), and impyrt declares none.
    expect(at("[TK]x[=]out ![[|")).toBeNull();
    expect(at("[TK]impyrt=pasted ![[|")).toBeNull();
  });

  it("inserts a source in place", () => {
    const id = "7c9wk2n4h6q1x8v0z3m5rjy2ke";
    const text = "[TK]summarise ![[fr and more[/TK]";
    const caret = "[TK]summarise ![[fr".length;
    const t = trigger(text, caret, false)!;
    expect(insert(text, caret, t, id)).toEqual({ text: `[TK]summarise ![[${id}]] and more[/TK]`, caret: `[TK]summarise ![[${id}]]`.length });
  });

  it("closes once the brackets are closed", () => {
    expect(at("[[abcdef]]|")).toBeNull();
    expect(at("![[abcdef]]|")).toBeNull();
    // A stray `]` means the author is typing something else.
    expect(at("[[ab]|")).toBeNull();
  });

  it("takes the innermost open `[[` when there are two on a line", () => {
    expect(at("[[aaa]] and [[bb|")).toMatchObject({ form: "link", query: "bb", start: 12 });
  });

  it("finds nothing when there are no brackets", () => {
    expect(at("ordinary prose|")).toBeNull();
    expect(at("one bracket [|")).toBeNull();
  });
});

describe("paletteInsert — the insertion matches the trigger", () => {
  const id = "7c9wk2n4h6q1x8v0z3m5rjy2ke";

  it("writes a directive over the whole line", () => {
    const text = "  ![[fr";
    const t = trigger(text, text.length, true)!;
    expect(insert(text, text.length, t, id)).toEqual({
      text: `![[${id}]]`,
      caret: `![[${id}]]`.length,
    });
  });

  it("writes a link in place, leaving the rest of the line alone", () => {
    const text = "as I said in [[fr and then some";
    const caret = "as I said in [[fr".length;
    const t = trigger(text, caret, false)!;
    expect(insert(text, caret, t, id)).toEqual({
      text: `as I said in [[${id}]] and then some`,
      caret: `as I said in [[${id}]]`.length,
    });
  });

  it("keeps everything before and after a multi-line insertion", () => {
    const text = "para one\n\nsee [[q\n\npara three";
    const caret = "para one\n\nsee [[q".length;
    const t = trigger(text, caret, true)!;
    expect(insert(text, caret, t, id).text).toBe(`para one\n\nsee [[${id}]]\n\npara three`);
  });
});

describe("the candidate list pages, and says so", () => {
  // Storage is shared across this file, so every case searches for its own
  // token rather than the whole blyg — otherwise the totals drift with
  // whatever the describes above happened to publish.
  const search = (cookie: string, q: string, offset?: number) =>
    apiJson(cookie, "GET", `/api/search?q=${q}${offset === undefined ? "" : `&offset=${offset}`}`);

  it("caps a page at 20 but reports the true total", async () => {
    const cookie = await login();
    // 23 > one page, so the old silent slice would have looked identical to
    // "that is everything".
    for (let i = 0; i < 23; i++) await createAndPublish(cookie, `pagingtoken fragment number ${i}`);

    const first = await search(cookie, "pagingtoken");
    expect(first.json.items).toHaveLength(20);
    expect(first.json.total).toBe(23);
    expect(first.json.offset).toBe(0);
    expect(first.json.limit).toBe(20);

    const second = await search(cookie, "pagingtoken", 20);
    expect(second.json.items).toHaveLength(3);
    expect(second.json.total).toBe(23);
    expect(second.json.offset).toBe(20);

    // The two pages partition the list — no overlap, nothing dropped.
    const ids = [...first.json.items, ...second.json.items].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(23);
  });

  it("an offset past the end is empty, not an error", async () => {
    const cookie = await login();
    await createAndPublish(cookie, "pastendtoken the only one");
    const res = await search(cookie, "pastendtoken", 500);
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual([]);
    expect(res.json.total).toBe(1);
  });

  it("rejects invalid offsets while treating an empty offset as zero", async () => {
    const cookie = await login();
    await createAndPublish(cookie, "junkoffsettoken the only one");
    for (const bad of ["abc", "-5"]) {
      expect((await apiJson(cookie, "GET", `/api/search?q=junkoffsettoken&offset=${bad}`)).status).toBe(400);
    }
    const empty = await apiJson(cookie, "GET", "/api/search?q=junkoffsettoken&offset=");
    expect(empty.json.offset).toBe(0); expect(empty.json.items).toHaveLength(1);
  });

  it("matches a word longer than D1's 50-byte LIKE cap, case-folded, with % and _ literal", async () => {
    const cookie = await login();
    const url = "https://longsearchtoken.example/some/deeply/nested/path/to_a/100%25/page";
    await createAndPublish(cookie, `See ${url} for more.`);
    await createAndPublish(cookie, "https://longsearchtoken.example/some/deeply/nested/path/toXa/100X/page");
    const res = await search(cookie, encodeURIComponent(url.toUpperCase().replace("HTTPS", "https")));
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(1);
  });

  it("the total counts matches, not the whole blyg", async () => {
    const cookie = await login();
    await createAndPublish(cookie, "alphatoken one");
    await createAndPublish(cookie, "alphatoken two");
    await createAndPublish(cookie, "betatoken three");
    const res = await search(cookie, "alphatoken");
    expect(res.json.total).toBe(2);
    expect(res.json.items).toHaveLength(2);
  });


});
