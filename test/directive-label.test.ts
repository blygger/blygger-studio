// The directive label travels (0.4 §10.1, §10.2, decision #81; ROADMAP row 79).
//
// `![[id | text]]`'s label is baked as `data-blyg-label` on the transclusion's
// blockquote, verbatim and HTML-escaped, and nowhere else: not
// `transclusions[]`, not the target. Every renderer this client has — the
// public pages' provenance lines (direct and nested), the reader, a fork
// flattener — uses it as the attribution anchor when present, and never as the
// target's title (#46). With no label there is no attribute and nothing changes.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { bakedLabel, injectNestedProvenance, injectProvenance } from "../src/pages.ts";
import { flattenFork, htmlToMarkdown } from "../src/fork-flatten.ts";
import { sanitizeHtml } from "../src/importer/sanitize.ts";
import { createSubscription } from "../src/importer/store.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const OURS = "https://example.com/blyg/";
const THEIRS = "https://far.example/";

async function publishThread(cookie: string, contentMd: string): Promise<string> {
  const created = await apiJson(cookie, "POST", "/blyg/api/items", { kind: "thread", contentMd });
  const id = created.json.id as string;
  const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return id;
}
const doc = async (id: string) => (await getPublic(`/blyg/items/${id}.json`)).json<any>();
const opening = (html: string) => /<blockquote class="blyg-transclusion[^>]*>/.exec(html)?.[0] ?? "";
const provenanceLines = (html: string) => [...html.matchAll(/<p class="provenance[^"]*">.*?<\/p>/g)].map((m) => m[0]);

describe("the bake", () => {
  it("adds data-blyg-label after the other attributes, and nothing else carries it", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "# Their heading\n\nWords worth quoting.");
    const id = await publishThread(cookie, `Intro.\n\n![[${target} | note to self]]\n\nOutro.`);
    const d = await doc(id);
    expect(opening(d.content_html)).toBe(
      `<blockquote class="blyg-transclusion" data-blyg-id="${target}" data-blyg-version="1" data-blyg-label="note to self">`,
    );
    expect(JSON.stringify(d.transclusions)).not.toContain("note to self");
    // The label appears exactly once in the bake: as the attribute, not as text.
    expect(d.content_html.split("note to self")).toHaveLength(2);
  });

  it("escapes the label verbatim, quotes, angle brackets, ampersands and pipes", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Words.");
    const id = await publishThread(cookie, `![[${target} | Tom & "Jerry" <b>x</b> | it's]]`);
    expect(opening((await doc(id)).content_html)).toContain(
      `data-blyg-label="Tom &amp; &quot;Jerry&quot; &lt;b&gt;x&lt;/b&gt; | it&#39;s"`,
    );
  });

  it("bakes no attribute for no label or an empty one: byte-identical to before", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Words.");
    for (const md of [`![[${target}]]`, `![[${target} |  ]]`]) {
      const html = (await doc(await publishThread(cookie, md))).content_html;
      expect(opening(html)).toBe(`<blockquote class="blyg-transclusion" data-blyg-id="${target}" data-blyg-version="1">`);
    }
  });

  it("labels a partial transclusion the same way", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "First sentence here. Second sentence there.");
    const id = await publishThread(cookie, `![[${target} | the second sentence]]\n> Second sentence there.\n\nMy reply.`);
    const d = await doc(id);
    expect(opening(d.content_html)).toBe(
      `<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="${target}" data-blyg-version="1" data-blyg-label="the second sentence">`,
    );
    expect(d.transclusions[0]).not.toHaveProperty("label");
  });

  it("labels a remote quote after its origin", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const sub = await createSubscription(env.DB, { kind: "blyg", origin: THEIRS, feedUrl: `${THEIRS}feed.xml`, title: "Far Blyg" });
    const remote = "0000000000000000000000000r";
    await env.DB.prepare("INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html, l0) VALUES (?, ?, 'fragment', 'current', 2, '2026-10-01T00:00:00Z', 'x', '<p>Their words.</p>', 0)")
      .bind(sub.id, remote).run();
    const id = await publishThread(cookie, `![[${remote} | a friend's line]]`);
    const d = await doc(id);
    expect(opening(d.content_html)).toBe(
      `<blockquote class="blyg-transclusion" data-blyg-id="${remote}" data-blyg-version="2" data-blyg-origin="${THEIRS}" data-blyg-label="a friend&#39;s line">`,
    );
    // The public page anchors its attribution on the label; the source still follows.
    const page = await (await getPublic(`/blyg/t/${id}/`)).text();
    const [line] = provenanceLines(page);
    expect(line).toContain(`>a friend&#39;s line ↗</a> · from <em>Far Blyg</em> · snapshot of v2</p>`);
  });

  it("keeps a quoted thread's own labels inside the outer bake, verbatim", async () => {
    const cookie = await login();
    const leaf = await createAndPublish(cookie, "Deepest words.");
    const mid = await publishThread(cookie, `![[${leaf} | the leaf]]\n\nMiddle.`);
    const top = await publishThread(cookie, `![[${mid}]]\n\nTop.`);
    const html = (await doc(top)).content_html;
    expect(opening(html)).not.toContain("data-blyg-label");
    expect(html).toContain(`data-blyg-id="${leaf}" data-blyg-version="1" data-blyg-label="the leaf"`);
  });
});

describe("the public page's attribution line", () => {
  it("anchors on the label and keeps the kind; an unlabelled quote is unchanged", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "# The real title\n\nBody.");
    const id = await publishThread(cookie, `![[${target} | my name for it]]\n\n![[${target}]]`);
    const page = await (await getPublic(`/blyg/t/${id}/`)).text();
    const lines = provenanceLines(page);
    expect(lines).toEqual([
      `<p class="provenance"><a href="/blyg/f/${target}/">my name for it ↗</a> · fragment · snapshot of v1</p>`,
      `<p class="provenance"><a href="/blyg/f/${target}/">fragment ↗</a> · snapshot of v1</p>`,
    ]);
    // Never the target's title (#46): the heading is in the quoted body only.
    expect(lines.join("")).not.toContain("The real title");
  });

  it("says excerpt for a labelled partial", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "One. Two.");
    const id = await publishThread(cookie, `![[${target} | the second]]\n> Two.`);
    const [line] = provenanceLines(await (await getPublic(`/blyg/t/${id}/`)).text());
    expect(line).toContain(">the second ↗</a> · fragment · excerpt of v1");
  });

  it("names nested layers by their label too", async () => {
    const cookie = await login();
    const leaf = await createAndPublish(cookie, "Deepest words.");
    const mid = await publishThread(cookie, `![[${leaf} | the leaf]]\n\nMiddle.`);
    const top = await publishThread(cookie, `![[${mid} | the middle]]\n\nTop.`);
    const lines = provenanceLines(await (await getPublic(`/blyg/t/${top}/`)).text());
    expect(lines).toEqual([
      `<p class="provenance nested"><a href="/blyg/f/${leaf}/">the leaf ↗</a> · fragment · snapshot of v1</p>`,
      `<p class="provenance"><a href="/blyg/t/${mid}/">the middle ↗</a> · thread · snapshot of v1</p>`,
    ]);
  });

  it("injectProvenance and injectNestedProvenance read the attribute, escaped", async () => {
    const q = (attrs: string, inner: string) => `<blockquote class="blyg-transclusion" ${attrs}>${inner}</blockquote>`;
    const html = q(
      `data-blyg-id="A" data-blyg-version="3" data-blyg-origin="https://else.example/" data-blyg-label="Tom &amp; &lt;b&gt;"`,
      `<p>a</p>${q('data-blyg-id="B" data-blyg-version="2" data-blyg-label="inner &quot;one&quot;"', "<p>b</p>")}`,
    );
    const direct = injectProvenance(html, ['<p class="provenance"><a href="https://else.example/f/A/">from else.example ↗</a> · snapshot of v3</p>']);
    expect(direct).toContain('<a href="https://else.example/f/A/">Tom &amp; &lt;b&gt; ↗</a> · from else.example · snapshot of v3');
    const nested = await injectNestedProvenance(env.DB, direct, "/blyg");
    expect(nested).toContain('<a href="https://else.example/f/B/">inner &quot;one&quot; ↗</a> · from else.example · snapshot of v2');
  });

  it("reads a label only from a data-blyg-label attribute", () => {
    expect(bakedLabel('<blockquote class="blyg-transclusion" data-blyg-id="A">')).toBeNull();
    expect(bakedLabel('<blockquote data-blyg-label="">')).toBeNull();
    expect(bakedLabel('<blockquote data-blyg-label="a &amp; b">')).toBe("a & b");
  });
});

describe("import", () => {
  it("the sanitizer keeps data-blyg-label, so a subscriber can attribute with it", async () => {
    const html = `<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="A" data-blyg-version="1" data-blyg-label="Tom &amp; &quot;Jerry&quot;" onclick="x()"><p>a</p></blockquote>`;
    const out = await sanitizeHtml(html);
    expect(out).toContain('data-blyg-label="Tom &amp; &quot;Jerry&quot;"');
    expect(out).not.toContain("onclick");
  });
});

describe("fork flattening", () => {
  const ctx = { origin: OURS, link: async (o: string, id: string) => `${o}items/${id}.json` };
  const ID2 = "2222222222222222222222222b";

  it("anchors the attribution line on the label, escaped for markdown, host and version after", async () => {
    const md = `![[${ID2} | a [note] *here*]]\n\nAfter.`;
    const html =
      `<blockquote class="blyg-transclusion" data-blyg-id="${ID2}" data-blyg-version="3" data-blyg-label="a [note] *here*">\n<p>Quoted.</p>\n</blockquote>\n<p>After.</p>`;
    const out = await flattenFork({ contentMd: md, contentHtml: html, generated: [] }, ctx);
    expect(out.exact).toBe(true);
    expect(out.contentMd).toContain(`> — quoted from [a \\[note\\] \\*here\\*](${OURS}items/${ID2}.json) · example.com · v3`);
  });

  it("keeps host · vN as the anchor without a label, and labels nested layers by their own", async () => {
    const html =
      `<blockquote class="blyg-transclusion" data-blyg-id="A" data-blyg-version="1" data-blyg-origin="https://far.example/">` +
      `<p>outer</p><blockquote class="blyg-transclusion" data-blyg-id="B" data-blyg-version="2" data-blyg-label="the inner one"><p>inner</p></blockquote></blockquote>`;
    const out = await htmlToMarkdown(html, ctx);
    expect(out).toContain("— quoted from [far.example · v1](https://far.example/items/A.json)");
    expect(out).toContain("— quoted from [the inner one](https://far.example/items/B.json) · far.example · v2");
  });
});
