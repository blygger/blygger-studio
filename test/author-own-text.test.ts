// Every surface that *names* a thread names it in the author's own words.
//
// Reported by Venkat: "the main public display page still doesn't display
// thread cards properly." The cause was general, and the feed card was only
// where it was visible. A thread's `content_html` carries other people's
// writing baked in as `blockquote.blyg-transclusion` (§10). That is right on
// the thread's own page, where a quote is displayed as a quote with provenance
// under it. It is wrong in every derived one-liner, because flattening the HTML
// to text drops exactly the structure that made the attribution legible.
//
// Measured on the live node before the fix: of 19 published threads, 5 *opened*
// with a transclusion — the shape the stub action prefills — so their browser
// tab, search heading, social card, RSS headline and feed-page excerpt were all
// someone else's sentence presented as the author's.
//
// The studio's index rows had always been correct. These tests exist so the
// public ones cannot drift back.
//
// Session 30 changed the *feed card* half (Venkat): the card now renders the
// top of the thread's own page — real HTML, quotes as blockquotes with their
// provenance line — instead of a plain-text teaser. Quoted words therefore DO
// appear on the card again, but only where the page shows them: inside the
// transclusion blockquote, never in the author's prose around it. The one-line
// surfaces (title, og:title, RSS headline, archive row) are unchanged.
import { describe, expect, it } from "vitest";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const THEIRS = "Their sentence, which the author merely quoted.";
const MINE = "My own commentary, which is what this thread actually says.";

async function publishThread(cookie: string, contentMd: string): Promise<string> {
  const created = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: contentMd, kind: "thread" });
  expect(created.status).toBe(201);
  const id = created.json.id as string;
  expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
  return id;
}

/** The feed page's card for one thread. */
async function cardFor(id: string): Promise<string> {
  const html = await (await getPublic("/blyg/")).text();
  const at = html.indexOf(`/blyg/t/${id}/`);
  expect(at, "no card for that thread").toBeGreaterThan(-1);
  const start = html.lastIndexOf('<article class="fragment thread-card">', at);
  return html.slice(start, html.indexOf("</article>", at) + 10);
}

const tag = (html: string, re: RegExp) => re.exec(html)?.[1] ?? "";

/** The card with every transclusion blockquote cut out — the author's own prose and apparatus. */
function outsideQuotes(card: string): string {
  let out = "", depth = 0, last = 0;
  for (const m of card.matchAll(/<blockquote\b[^>]*>|<\/blockquote>/g)) {
    if (m[0].startsWith("</")) { depth--; if (depth === 0) last = m.index! + m[0].length; }
    else { if (depth === 0) out += card.slice(last, m.index); depth++; }
  }
  return out + card.slice(last);
}

describe("a thread that opens with a quote", () => {
  // The shape `POST /api/stubs` prefills, so it is the common case, not an
  // edge one.
  async function setup() {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteTitle: "Field Notes" });
    const target = await createAndPublish(cookie, THEIRS);
    const thread = await publishThread(cookie, `![[${target}]]\n\n${MINE}`);
    return { cookie, target, thread };
  }

  it("the feed card shows the quote as a quote, with provenance, and the author's prose outside it", async () => {
    const { thread } = await setup();
    const card = await cardFor(thread);
    expect(card).toContain("blyg-transclusion");
    expect(card).toContain('class="provenance"');
    expect(card).toContain("Their sentence");
    expect(outsideQuotes(card)).toContain("My own commentary");
    expect(outsideQuotes(card)).not.toContain("Their sentence");
  });

  it("the page title and og:title are the author's words", async () => {
    const { thread } = await setup();
    const html = await (await getPublic(`/blyg/t/${thread}/`)).text();
    expect(tag(html, /<title>([^<]*)<\/title>/)).toContain("My own commentary");
    expect(tag(html, /<meta property="og:title" content="([^"]*)">/)).not.toContain("Their sentence");
    expect(tag(html, /<meta name="description" content="([^"]*)">/)).not.toContain("Their sentence");
  });

  it("the RSS headline is the author's words", async () => {
    const { thread } = await setup();
    const xml = await (await getPublic("/blyg/feed.xml")).text();
    // The <item> block that carries this id, rather than a fixed-size window
    // before it — element order inside <item> is not something to depend on.
    const item = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)]
      .map((m) => m[0])
      .find((block) => block.includes(`<blyg:id>${thread}</blyg:id>`));
    expect(item, "no feed item for that thread").toBeDefined();
    const title = tag(item!, /<title>([\s\S]*?)<\/title>/);
    expect(title).toContain("My own commentary");
    expect(title).not.toContain("Their sentence");
  });

  it("the archive row is the author's words", async () => {
    const { thread } = await setup();
    const html = await (await getPublic("/blyg/archive/")).text();
    const at = html.indexOf(`/blyg/t/${thread}/`);
    const row = html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at));
    expect(row).toContain("My own commentary");
    expect(row).not.toContain("Their sentence");
  });

  it("the thread's OWN page still shows the quote in full — it is a quote there", async () => {
    const { thread } = await setup();
    const html = await (await getPublic(`/blyg/t/${thread}/`)).text();
    // Nothing about this fix removes anything from the item. The quote is
    // displayed, with its provenance line, where a reader can see whose it is.
    expect(html).toContain("Their sentence");
    expect(html).toContain("blyg-transclusion");
    expect(html).toContain('class="provenance"');
  });

  it("the item document is untouched — this is presentation only", async () => {
    const { thread, target } = await setup();
    const doc = await (await getPublic(`/blyg/items/${thread}.json`)).json<any>();
    expect(doc.content_html).toContain("Their sentence");
    expect(doc.transclusions).toEqual([{ id: target, version: 1 }]);
  });
});

describe("a thread that quotes mid-way", () => {
  it("does not run the author's words into the quoted ones", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, THEIRS);
    const thread = await publishThread(cookie, `${MINE}\n\n![[${target}]]\n\nAnd a closing line.`);
    const card = await cardFor(thread);
    // The defect: a flat excerpt welded "…this thread actually says. Their
    // sentence, which the author…" into one paragraph with no boundary. The
    // card now keeps the boundary the page has: the quote is in its blockquote.
    expect(outsideQuotes(card)).toContain("My own commentary");
    expect(outsideQuotes(card)).toContain("And a closing line.");
    expect(outsideQuotes(card)).not.toContain("Their sentence");
    expect(card).toContain("Their sentence");
  });
});

describe("the card says how much it is not showing", () => {
  it("carries a quote count", async () => {
    const cookie = await login();
    const a = await createAndPublish(cookie, "first quoted thing");
    const b = await createAndPublish(cookie, "second quoted thing");
    const thread = await publishThread(cookie, `${MINE}\n\n![[${a}]]\n\n![[${b}]]`);
    const card = await cardFor(thread);
    expect(card).toContain('<p class="card-kind">thread <span class="quote-count">· 2 quoted</span></p>');
  });

  it("omits the count when a thread quotes nothing", async () => {
    const cookie = await login();
    const thread = await publishThread(cookie, `${MINE}`);
    expect(await cardFor(thread)).not.toContain("quote-count");
  });
});

describe("a thread with nothing of its own to say", () => {
  // Rare but legal, and 1 of the 19 live threads was exactly this. The honest
  // answer is not the quoted sentence — that is the misattribution the whole
  // change exists to prevent — and not a blank card either.
  async function quoteOnlyStub() {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteTitle: "Field Notes", siteUrl: "https://ours.example/blyg/" });
    const target = await createAndPublish(cookie, THEIRS);
    const created = await apiJson(cookie, "POST", "/blyg/api/items", {
      contentMd: `![[${target}]]`,
      kind: "thread",
      stubOf: { origin: "https://ours.example/blyg/", id: target, version: 1 },
    });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    return id;
  }

  it("names what it answers, and shows the quote only as a quote", async () => {
    const card = await cardFor(await quoteOnlyStub());
    expect(card).toContain("In response to");
    expect(outsideQuotes(card)).not.toContain("Their sentence");
  });

  it("does the same in the page title", async () => {
    const id = await quoteOnlyStub();
    const html = await (await getPublic(`/blyg/t/${id}/`)).text();
    const title = tag(html, /<title>([^<]*)<\/title>/);
    expect(title).toContain("In response to");
    expect(title).not.toContain("Their sentence");
  });
});

describe("fragments are unaffected", () => {
  it("a fragment's card and title are what they always were", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteTitle: "Field Notes" });
    const id = await createAndPublish(cookie, "an ordinary fragment with no quotes in it");
    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(tag(html, /<title>([^<]*)<\/title>/)).toBe("an ordinary fragment with no quotes in it — Field Notes");
    expect(await (await getPublic("/blyg/")).text()).toContain("an ordinary fragment with no quotes in it");
  });

  it("an ordinary blockquote the author wrote is their own text, and stays", async () => {
    const cookie = await login();
    const thread = await publishThread(cookie, `${MINE}\n\n> A pull-quote I typed myself.`);
    const card = await cardFor(thread);
    // Only baked transclusions are someone else's. A markdown blockquote is
    // the author's own writing and must not be stripped from their teaser.
    expect(card).toContain("A pull-quote I typed myself.");
  });
});
