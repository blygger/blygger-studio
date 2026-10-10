// Where the bracket grammar applies, and where it must not (session 33).
//
//   studio#4  — `![[id]]` and `[[id]]` are inert inside code spans and code
//               blocks (spec §10.1, decision #54).
//   (studio#5 was reverted the same session: provisionally, an own-line
//    `![[id]]` in TK output is a quote at publish — see the describe below.)
//   studio#13 — a link never nests inside another anchor, and no placeholder
//               character reaches an href.
//   studio#14 — the preview resolves links inside generated blocks as publish does.
import { describe, expect, it } from "vitest";
import { codeRanges, inRanges } from "../src/code-ranges.ts";
import { extractDirectives } from "../src/directives.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const UNKNOWN = "00000000000000000000000000";
const PUA = /[-]|%EE%80%8[0-5]/;

async function publish(cookie: string, md: string, kind: "fragment" | "thread" = "thread") {
  const id = (await apiJson(cookie, "POST", "/api/items", { content_md: md, kind })).json.id as string;
  const res = await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
  const doc = res.status === 200 ? await (await getPublic(`/blyg/items/${id}.json`)).json<any>() : null;
  return { id, res, doc };
}

describe("code ranges", () => {
  it("finds fences, tilde fences, indented code, fences in list items, and code spans", () => {
    const text = "a `x` b\n\n```\nfenced\n```\n\n~~~\ntilde\n~~~\n\n    indented\n\n- item\n\n  ```\n  listed\n  ```\n";
    const ranges = codeRanges(text);
    for (const word of ["x", "fenced", "tilde", "indented", "listed"]) expect(inRanges(ranges, text.indexOf(word)), word).toBe(true);
    expect(inRanges(ranges, text.indexOf("item"))).toBe(false);
  });

  it("a code span never crosses a blank line", () => {
    const text = "one ` two\n\nthree ` four";
    expect(codeRanges(text)).toEqual([]);
  });
});

describe("studio#4: inert inside code", () => {
  it("a directive inside a fence is not transcluded, and is shown as written", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Target text.");
    const { doc } = await publish(cookie, `Example:\n\n\`\`\`\n![[${target}]]\n\`\`\`\n\nDone.`);
    expect(doc.transclusions).toEqual([]);
    expect(doc.content_html).not.toContain("blyg-transclusion");
    expect(doc.content_html).toContain(`![[${target}]]`);
  });

  it("an unknown id in code is fine to publish, in a block or a span", async () => {
    const cookie = await login();
    const fence = await publish(cookie, `\`\`\`\n![[${UNKNOWN}]]\n[[${UNKNOWN}]]\n\`\`\``);
    expect(fence.res.status).toBe(200);
    const span = await publish(cookie, `Write \`[[${UNKNOWN}]]\` to link.`, "fragment");
    expect(span.res.status).toBe(200);
    expect(span.doc.content_html).toContain(`<code>[[${UNKNOWN}]]</code>`);
  });

  it("the draft-preview extractor agrees", () => {
    expect(extractDirectives(`\`\`\`\n![[${UNKNOWN}]]\n\`\`\``).count).toBe(0);
    expect(extractDirectives(`![[${UNKNOWN}]]`).count).toBe(1);
  });
});

describe("a directive left on its own line in TK output (provisional, session 33)", () => {
  // Venkat took the session-33 Fable reading (v0.4-plan §9.2) over studio#5's:
  // such a line is a real transclusion at publish, pending Fable reconciling it
  // with decision #20. Code stays inert either way (#54).
  it("is transcluded at publish", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Target text.");
    const { doc } = await publish(cookie, `Intro.\n\n[TK]write it[=]Mine.\n\n![[${target}]][/TK]\n\nOutro.`);
    expect(doc.transclusions).toEqual([{ id: target, version: 1 }]);
    expect(doc.content_html).toContain("blyg-transclusion");
    expect(doc.content_html).not.toMatch(PUA);
  });

  it("a directive outside the scope still is", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Target text.");
    const { doc } = await publish(cookie, `![[${target}]]\n\nThen [TK]impyrt=generated[/TK].`);
    expect(doc.transclusions).toEqual([{ id: target, version: 1 }]);
  });
});

describe("TK sources through the generate route", () => {
  it("a thread is a source since G8 (#44): resolution passes and the request goes on to the provider", async () => {
    const cookie = await login();
    const thread = (await apiJson(cookie, "POST", "/api/items", { content_md: "a thread", kind: "thread" })).json.id as string;
    await apiJson(cookie, "POST", `/api/items/${thread}/publish`, {});
    const id = (await apiJson(cookie, "POST", "/api/items", { content_md: `[TK]summarize ![[${thread}]][/TK]` })).json.id as string;
    const res = await apiJson(cookie, "POST", `/api/items/${id}/generate`, { scope: 0 });
    // This suite configures no provider, so the request fails there, past the
    // source check rather than at it.
    expect(res.json.error).not.toMatch(/unresolvable source|not yet implemented/);
  });

  it("a genuinely unknown id still says why", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/api/items", { content_md: `[TK]summarize ![[${UNKNOWN}]][/TK]` })).json.id as string;
    const res = await apiJson(cookie, "POST", `/api/items/${id}/generate`, { scope: 0 });
    expect(res.json.error).toBe("unresolvable source: unknown item");
  });
});

describe("studio#13: no anchor inside an anchor", () => {
  it("inside link text, the label goes in as text", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Target text.");
    const { doc } = await publish(cookie, `[see [[${target}]]](https://x.test/)`, "fragment");
    expect(doc.content_html).toMatch(/<a href="https:\/\/x\.test\/">see “Target text\.”<\/a>/);
    expect(doc.content_html.match(/<a /g)).toHaveLength(1);
  });

  it("inside an autolink or a bare URL, the author's [[id]] stays in the URL and its text", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Target text.");
    for (const md of [`<https://x.test/[[${target}]]>`, `https://x.test/[[${target}]]`]) {
      const { doc } = await publish(cookie, md, "fragment");
      expect(doc.content_html, md).not.toMatch(PUA);
      expect(doc.content_html.match(/<a /g), md).toHaveLength(1);
      expect(doc.content_html, md).toContain(`[[${target}]]</a>`);
    }
  });

  it("inside an image's alt text, the literal", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Target text.");
    const { doc } = await publish(cookie, `![about [[${target}]]](https://x.test/i.png)`, "fragment");
    expect(doc.content_html).toContain(`alt="about [[${target}]]"`);
    expect(doc.content_html).not.toMatch(PUA);
  });

  it("an ordinary link still renders as an anchor", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Target text.");
    const { doc } = await publish(cookie, `See [[${target}]] here.`, "fragment");
    expect(doc.content_html).toMatch(new RegExp(`<a href="[^"]*/f/${target}/">“Target text\\.”</a>`));
  });
});

describe("studio#14: the preview resolves links in generated blocks", () => {
  it("shows the anchor publish will make, and reports an unknown id", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Target text.");
    const ok = await apiJson(cookie, "POST", "/api/preview", { content_md: `[TK]write[=]One [[${target}]].\n\nTwo.[/TK]`, kind: "fragment" });
    expect(ok.json.html).toMatch(new RegExp(`<a href="[^"]*/f/${target}/">`));
    expect(ok.json.link_errors).toEqual([]);
    const bad = await apiJson(cookie, "POST", "/api/preview", { content_md: `[TK]write[=]One [[${UNKNOWN}]].\n\nTwo.[/TK]`, kind: "fragment" });
    expect(bad.json.link_errors).toHaveLength(1);
    const thread = await apiJson(cookie, "POST", "/api/preview", { content_md: `[TK]write[=]One [[${UNKNOWN}]].\n\nTwo.[/TK]`, kind: "thread" });
    expect(thread.json.errors).toHaveLength(1);
  });
});

describe("studio#3: no internal marker reaches the HTML", () => {
  it("generated text glued to a URL stays in the URL, unmarked", async () => {
    const cookie = await login();
    const { doc } = await publish(cookie, "Read https://example.com/[TK]impyrt=page[/TK] today.", "fragment");
    expect(doc.content_html).not.toMatch(PUA);
    expect(doc.content_html).toContain('href="https://example.com/page"');
  });

  it("generated text in image alt text becomes plain text", async () => {
    const cookie = await login();
    const { doc } = await publish(cookie, "![a [TK]impyrt=generated caption[/TK]](https://x.test/i.png)", "fragment");
    expect(doc.content_html).toContain('alt="a generated caption"');
    expect(doc.content_html).not.toMatch(PUA);
  });

  it("a [TK] scope written inside code is an example, not a scope", async () => {
    const cookie = await login();
    const md = "Write it like this:\n\n```\n[TK]an instruction[/TK]\n```\n\nor inline `[TK]x[/TK]`.";
    const { res, doc } = await publish(cookie, md, "fragment");
    // An ungenerated scope would fail publish; as an example it publishes.
    expect(res.status).toBe(200);
    expect(doc.content_md).toBe(md);
    expect(doc.content_html).toContain("[TK]an instruction[/TK]");
    expect(doc.content_html).not.toMatch(PUA);
  });
});
