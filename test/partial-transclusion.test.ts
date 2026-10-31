// Partial transclusion — spec §16.4, decision #49, plan §7.3 (P1, P3, P4, P5).
//
// The third register of borrowing: quote a passage, rather than transclude the
// whole item (§10.6) or fork from a pin (§5.6). Same construct as a whole
// transclusion with a `selector` added, which is why the relation stays
// `transclusion` and a reader that ignores `selector` stays conformant.
//
// Two properties carry the design and are what these tests are really about:
//
//   1. **Adjacency is the grammar.** A directive followed with no blank line by
//      a blockquote is partial; a blank line detaches, so "transclude the whole
//      thing, then quote a bit of it myself" — legal since 0.1 — keeps working
//      unchanged. Getting this wrong silently changes what old drafts mean.
//   2. **The selection must really be in the target.** Not "looks similar":
//      a substring of the target snapshot's normalized text at the version
//      being baked, else a publish error like an unresolvable directive.
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { apiJson, BASE, createAndPublish, getPublic, login } from "./helpers.ts";

async function createThread(cookie: string, contentMd: string): Promise<string> {
  const created = await apiJson(cookie, "POST", "/blyg/api/items", { content_md: contentMd, kind: "thread" });
  expect(created.status).toBe(201);
  return created.json.id as string;
}

const TARGET = [
  "Stigmergy is what a protocol looks like from inside, and the reason it",
  "looks like nothing at all is the point.",
  "",
  "A second paragraph that is not quoted.",
].join("\n");

/** The first paragraph of TARGET, as one line of normalized text. */
const PARA_ONE =
  "Stigmergy is what a protocol looks like from inside, and the reason it looks like nothing at all is the point.";

describe("the grammar: adjacency makes it partial", () => {
  it("a directive with an attached blockquote bakes the passage, not the item", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const thread = await createThread(
      cookie,
      `![[${target}]]\n> Stigmergy is what a protocol looks like from inside,\n> and the reason it looks like nothing at all is the point.\n\nCommentary after.`,
    );
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(doc.content_html).toContain('class="blyg-transclusion blyg-partial"');
    expect(doc.content_html).toContain("Stigmergy is what a protocol looks like from inside");
    // The half of the target that was NOT quoted must not be in our document.
    // A partial quote that silently bakes the whole item would be the exact
    // misrepresentation the construct exists to avoid.
    expect(doc.content_html).not.toContain("A second paragraph that is not quoted");
    expect(doc.content_html).toContain("Commentary after.");
  });

  it("a blank line detaches — the whole transclusion plus the author's own quote", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const thread = await createThread(
      cookie,
      `![[${target}]]\n\n> My own pull-quote, which is not a selection.\n\nAnd commentary.`,
    );
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    // Whole form: no partial class, no selector, and the target's second
    // paragraph is present because the entire item was baked.
    expect(doc.content_html).toContain('class="blyg-transclusion"');
    expect(doc.content_html).not.toContain("blyg-partial");
    expect(doc.transclusions).toEqual([{ id: target, version: 1 }]);
    expect(doc.content_html).toContain("A second paragraph that is not quoted");
    // The author's own blockquote survives as their own blockquote.
    expect(doc.content_html).toContain("My own pull-quote");
  });

  it("an empty line inside the run is a paragraph break, not the end of it", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "First paragraph here.\n\nSecond paragraph here.\n\nThird.");
    const thread = await createThread(
      cookie,
      `![[${target}]]\n> First paragraph here.\n>\n> Second paragraph here.\n\nAfter.`,
    );
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(doc.transclusions[0].selector.exact).toBe("First paragraph here.\nSecond paragraph here.");
    // Two paragraphs in the bake, and the third is not there.
    expect(doc.content_html).toContain("<p>First paragraph here.</p>\n<p>Second paragraph here.</p>");
    expect(doc.content_html).not.toContain("Third.");
  });

  it("the run ends at the first line that is not a quote line", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const thread = await createThread(
      cookie,
      `![[${target}]]\n> Stigmergy is what a protocol looks like from inside,\nCommentary on the same line-run.`,
    );
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(doc.content_html).toContain("blyg-partial");
    expect(doc.content_html).toContain("Commentary on the same line-run.");
    expect(doc.transclusions[0].selector.exact).toBe("Stigmergy is what a protocol looks like from inside,");
  });
});

describe("the check: the passage must be in the target", () => {
  it("refuses a quote the target does not contain, naming the version", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const thread = await createThread(cookie, `![[${target}]]\n> Words the target never said.`);
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain("quoted passage not found in the target's version 1");
  });

  it("is checked against the version being baked, not the text that used to be there", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    // The target moves on, dropping the sentence.
    await apiJson(cookie, "PATCH", `/blyg/api/items/${target}`, { content_md: "Rewritten entirely." });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${target}/publish`, {})).status).toBe(200);

    const thread = await createThread(cookie, `![[${target}]]\n> ${PARA_ONE}`);
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {});
    expect(res.status).toBe(400);
    // v2 is what would be baked, so v2 is what the error names.
    expect(JSON.stringify(res.json)).toContain("quoted passage not found in the target's version 2");
  });

  it("accepts a quote that only matches after whitespace collapsing", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    // Wrapped at completely different points from the target's own source.
    const thread = await createThread(
      cookie,
      `![[${target}]]\n> Stigmergy is what a\n> protocol looks like from inside, and the reason\n> it looks like nothing at all is the point.`,
    );
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(doc.transclusions[0].selector.exact).toBe(PARA_ONE);
  });

  it("accepts a quote straddling two blocks, because both sides break there", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Alpha line.\n\nBeta line.\n\nGamma line.");
    const thread = await createThread(cookie, `![[${target}]]\n> Alpha line.\n>\n> Beta line.`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);
  });

  it("refuses a quote that welds two of the target's blocks into one line", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Alpha line.\n\nBeta line.");
    // The target has a block boundary between these; this quote does not.
    const thread = await createThread(cookie, `![[${target}]]\n> Alpha line. Beta line.`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(400);
  });

  it("refuses an empty blockquote rather than baking a zero-length selection", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const thread = await createThread(cookie, `![[${target}]]\n>\n>`);
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain("empty");
  });
});

describe("the wire entry", () => {
  it("carries selector.exact with short prefix and suffix context", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Before it. The middle bit. After it.");
    const thread = await createThread(cookie, `![[${target}]]\n> The middle bit.`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    const entry = doc.transclusions[0];
    expect(entry.id).toBe(target);
    expect(entry.version).toBe(1);
    expect(entry.selector.exact).toBe("The middle bit.");
    expect(entry.selector.prefix).toBe("Before it. ");
    expect(entry.selector.suffix).toBe(" After it.");
    // §16.4 says short. 32 characters either side.
    expect(entry.selector.prefix.length).toBeLessThanOrEqual(32);
    expect(entry.selector.suffix.length).toBeLessThanOrEqual(32);
  });

  it("omits prefix and suffix when there is no context either side", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Exactly this.");
    const thread = await createThread(cookie, `![[${target}]]\n> Exactly this.`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(doc.transclusions[0].selector).toEqual({ exact: "Exactly this." });
  });

  it("a whole transclusion still has no selector at all", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const thread = await createThread(cookie, `![[${target}]]`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(doc.transclusions).toEqual([{ id: target, version: 1 }]);
  });
});

describe("the bake", () => {
  it("is the selection's plain text in paragraphs — the P4 call", async () => {
    const cookie = await login();
    // Emphasis in the source: the bake deliberately does not carry it, because
    // the selection is defined on text and carving an HTML sub-range faithfully
    // is a separate project. Recorded in v0.4-plan §7.3 P4 in advance.
    const target = await createAndPublish(cookie, "the *thin* layer where coordination happens");
    const thread = await createThread(cookie, `![[${target}]]\n> the thin layer where coordination happens`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(doc.content_html).toContain("<p>the thin layer where coordination happens</p>");
    expect(doc.content_html).not.toContain("<em>thin</em>");
  });

  it("escapes the selection rather than letting the target's text become markup", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "a < b and c > d");
    const thread = await createThread(cookie, `![[${target}]]\n> a < b and c > d`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(doc.content_html).toContain("&lt; b and c &gt;");
  });

  it("carries the same data attributes a whole transclusion does", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const thread = await createThread(cookie, `![[${target}]]\n> ${PARA_ONE}`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(doc.content_html).toContain(`data-blyg-id="${target}"`);
    expect(doc.content_html).toContain('data-blyg-version="1"');
    // Own-origin, so no data-blyg-origin (decision #26) — same rule as the
    // whole form, which is what keeps a 0.2 reader's parse unchanged.
    expect(doc.content_html).not.toContain("data-blyg-origin");
  });
});

describe("staleness and the rest are unchanged", () => {
  it("a partial quote goes stale on version, exactly as a whole one does", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const thread = await createThread(cookie, `![[${target}]]\n> ${PARA_ONE}`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    // Target moves; our snapshot and our selector both still name version 1.
    await apiJson(cookie, "PATCH", `/blyg/api/items/${target}`, { content_md: `${TARGET}\n\nAnd more.` });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${target}/publish`, {})).status).toBe(200);

    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(doc.transclusions[0].version).toBe(1);
    expect(doc.content_html).toContain('data-blyg-version="1"');
  });

  it("republishing re-checks against the new version and re-bakes", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const thread = await createThread(cookie, `![[${target}]]\n> ${PARA_ONE}`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    // The target keeps the quoted sentence, so a republish must succeed and
    // move the snapshot to v2 — the passage is still faithfully there.
    await apiJson(cookie, "PATCH", `/blyg/api/items/${target}`, { content_md: `${TARGET}\n\nA third paragraph.` });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${target}/publish`, {})).status).toBe(200);
    await apiJson(cookie, "PATCH", `/blyg/api/items/${thread}`, {
      content_md: `![[${target}]]\n> ${PARA_ONE}\n\nRevisited.`,
    });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(doc.transclusions[0].version).toBe(2);
    expect(doc.transclusions[0].selector.exact).toBe(PARA_ONE);
  });
});

// P7's last clause: "The preview shows the partial bake and the not-found error
// before publish." The preview shares `walk()` with the resolver, so this is
// really a test that the sharing holds — a preview that silently diverged from
// publish would show the author a passage that publish then refuses.
describe("the editor preview matches what publish will do", () => {
  const preview = async (cookie: string, contentMd: string) => {
    const res = await SELF.fetch(`${BASE}/blyg/api/preview`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ kind: "thread", content_md: contentMd }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  };

  it("renders the partial bake before publish", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const out = await preview(cookie, `![[${target}]]\n> ${PARA_ONE}`);
    expect(JSON.stringify(out)).toContain("blyg-partial");
    // The unquoted half of the target is not shown either — the preview is a
    // preview of the bake, not of the item.
    expect(JSON.stringify(out)).not.toContain("A second paragraph that is not quoted");
  });

  it("shows the not-found reason, naming the version, without publishing", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const out = await preview(cookie, `![[${target}]]\n> nothing like this is in there`);
    expect(JSON.stringify(out)).toContain("quoted passage not found in the target's version 1");
  });
});

// Found by opening the page, not by the suite: a partial quote rendered with
// no provenance line at all, because `injectProvenance` tested the class
// attribute as a literal string (`class="blyg-transclusion"`) and a partial's
// is `class="blyg-transclusion blyg-partial"`. The dropped line was the
// visible half; the mis-paired index in a mixed thread was the dangerous half.
describe("a partial quote discloses itself on the page", () => {
  it("carries a provenance line, and names itself an excerpt", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const thread = await createThread(cookie, `![[${target}]]\n> ${PARA_ONE}\n\nAnd my answer.`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    const html = await (await getPublic(`/blyg/t/${thread}/`)).text();
    expect(html).toContain('class="provenance"');
    // "excerpt of v1", not "snapshot of v1": a reader must be able to tell a
    // part from the whole, and length alone cannot say it — a short quote and
    // a short item look identical.
    expect(html).toContain("excerpt of v1");
    expect(html).not.toContain("snapshot of v1");
  });

  it("a whole transclusion still says snapshot", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, TARGET);
    const thread = await createThread(cookie, `![[${target}]]\n\nAnd my answer.`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);
    const html = await (await getPublic(`/blyg/t/${thread}/`)).text();
    expect(html).toContain("snapshot of v1");
    expect(html).not.toContain("excerpt of");
  });

  it("pairs each line with its own quote when a thread mixes both forms", async () => {
    const cookie = await login();
    const whole = await createAndPublish(cookie, "The whole of the first item.");
    const partial = await createAndPublish(cookie, TARGET);
    const third = await createAndPublish(cookie, "The whole of the third item.");
    // partial in the middle: if the partial is not recognised, the index stops
    // advancing and the third quote gets the second's line.
    const thread = await createThread(
      cookie,
      `![[${whole}]]\n\nOne.\n\n![[${partial}]]\n> ${PARA_ONE}\n\nTwo.\n\n![[${third}]]\n\nThree.`,
    );
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    const html = await (await getPublic(`/blyg/t/${thread}/`)).text();
    const lines = [...html.matchAll(/<p class="provenance">.*?<\/p>/g)].map((m) => m[0]);
    expect(lines).toHaveLength(3);
    // In document order: whole, excerpt, whole — and each naming its own target.
    expect(lines[0]).toContain(`/blyg/f/${whole}/`);
    expect(lines[0]).toContain("snapshot of v1");
    expect(lines[1]).toContain(`/blyg/f/${partial}/`);
    expect(lines[1]).toContain("excerpt of v1");
    expect(lines[2]).toContain(`/blyg/f/${third}/`);
    expect(lines[2]).toContain("snapshot of v1");
  });
});
