// Comments to self, the grammar alone: what parseComments keeps, removes and
// refuses. test/comments-privacy.test.ts follows the words through publish.
import { describe, expect, it } from "vitest";
import { outsideOtherComments, parseComments, previewComments, sameOutsideComments, withoutComments } from "../src/comments.ts";

describe("removal leaves what the author would have typed without the comment", () => {
  it.each([
    ["inline, spaces both sides", "foo /* note */ bar", "foo bar"],
    ["inline, tight", "foo/*note*/bar", "foobar"],
    ["before punctuation", "foo /* note */.", "foo."],
    ["at a line's end, no hard break left", "foo /* note */\nbar", "foo\nbar"],
    ["at a line's start", "/* note */ foo", "foo"],
    ["own line within a paragraph", "foo\n/* note */\nbar", "foo\nbar"],
    ["own paragraph", "foo\n\n/* note */\n\nbar", "foo\n\nbar"],
    ["first in the document", "/* note */\n\nbar", "bar"],
    ["last in the document", "foo\n\n/* note */", "foo"],
    ["last, with a final newline", "foo\n\n/* note */\n", "foo\n"],
    ["over several lines and paragraphs", "foo\n\n/* one\n\ntwo\n\nthree */\n\nbar", "foo\n\nbar"],
    ["starting mid-line, ending mid-line", "foo /* one\ntwo */ bar", "foo bar"],
    ["two in a row", "/* a */ /* b */\n\nbar", "bar"],
    ["two in one line", "a /* x */ b /* y */ c", "a b c"],
    ["indented", "foo\n  /* note */\nbar", "foo\nbar"],
    ["a whole document", "/* note */", ""],
  ])("%s", (_name, source, expected) => {
    const parsed = parseComments(source);
    expect(parsed.errors).toEqual([]);
    expect(parsed.text).toBe(expected);
  });

  it("leaves text with no comment byte-identical", () => {
    const text = "  Trailing spaces  \n\n\n\nand blank lines stay.  \n";
    expect(withoutComments(text)).toBe(text);
  });

  it("records where each comment was in the source", () => {
    expect(parseComments("ab /* c */ de /* f */").ranges).toEqual([{ start: 3, end: 10 }, { start: 14, end: 21 }]);
  });
});

describe("what is literal", () => {
  it.each([
    ["a code span", "use `/* x */` here"],
    ["a fenced block", "```\n/* x */\n```\n"],
    ["a tilde fence", "~~~\n/* x\n~~~\n"],
    ["an indented block", "para\n\n    /* x */\n"],
    ["an escaped opener", "a \\/* b"],
    ["an escaped closer", "a \\*/ b"],
    ["a closer attached to a word", "**bold**/ and on"],
  ])("%s", (_name, source) => {
    const parsed = parseComments(source);
    expect(parsed.errors).toEqual([]);
    expect(parsed.ranges).toEqual([]);
    expect(parsed.text).toBe(source);
  });

  it("an even run of backslashes does not escape", () => {
    expect(withoutComments("a \\\\/* b */ c")).toBe("a \\\\ c");
  });

  it("a closer in code inside a comment does not close it", () => {
    expect(withoutComments("a /* see `*/` here */ b")).toBe("a b");
  });

  it("a closer in a whole TK scope inside a comment does not close it", () => {
    expect(withoutComments("a /* [TK]x[=]has */ in it[/TK] still note */ b")).toBe("a b");
  });

  it("a stray backtick in one comment does not hide the next", () => {
    const parsed = parseComments("/* don't `x */ a `code` b /* second */");
    expect(parsed.text).not.toContain("second");
  });

  it("an opener is found in prose after a removed comment that held indentation", () => {
    expect(withoutComments("/* a */    /* b */ c")).toBe("c");
  });
});

describe("the rules lean towards privacy", () => {
  it("an unclosed opener is an error, and the preview text stops at it", () => {
    const parsed = parseComments("visible\n\n/* private and never closed\n\nmore");
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].reason).toContain("line 3");
    expect(parsed.text).toBe("visible");
  });

  it("comments do not nest, and the tail of an attempt is refused rather than published", () => {
    const parsed = parseComments("a /* outer /* inner */ private tail */ b");
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].reason).toContain("don't nest");
  });

  it("a comment inside TK output is still a comment", () => {
    expect(withoutComments("[TK]x[=]text /* private */ more[/TK]")).toBe("[TK]x[=]text more[/TK]");
  });

  it("a comment that opens in a scope and closes past it is not left half-removed silently", () => {
    expect(parseComments("/* [TK]x */ y[/TK]").errors).toHaveLength(1);
  });

  it("a mid-word opener with no closer refuses, it does not pass as prose", () => {
    expect(parseComments("see src/*.ts for more").errors).toHaveLength(1);
  });

  it("the preview says what would stop a publish", () => {
    expect(previewComments("visible /* never closed")).toContain("never closed with");
    expect(previewComments("visible /* fine */")).toBe("visible");
  });
});

describe("sameOutsideComments", () => {
  it("is true when only comments differ", () => {
    expect(sameOutsideComments("a /* x */ b", "a /* y */ b")).toBe(true);
    expect(sameOutsideComments("a b", "a /* y */ b")).toBe(true);
    expect(sameOutsideComments("a /* y */ b", "a b")).toBe(true);
  });
  it("is false for real edits, malformed comments, and text holding none", () => {
    expect(sameOutsideComments("a /* x */ b", "a /* x */ c")).toBe(false);
    expect(sameOutsideComments("a b", "a b /* open")).toBe(false);
    expect(sameOutsideComments("a b", "a b")).toBe(false);
  });
});

describe("outsideOtherComments", () => {
  it("drops the other comments and moves the offset", () => {
    const md = "/* one */ a [TK]x[/TK] /* two */";
    const at = md.indexOf("[TK]");
    const { text, offset } = outsideOtherComments(md, at);
    expect(text).not.toContain("one");
    expect(text).not.toContain("two");
    expect(text.slice(offset(at), offset(at) + 4)).toBe("[TK]");
  });
  it("keeps the comment holding the position", () => {
    const md = "/* one */ a /* two [TK]x[/TK] */";
    const { text } = outsideOtherComments(md, md.indexOf("[TK]"));
    expect(text).not.toContain("one");
    expect(text).toContain("two");
  });
});
