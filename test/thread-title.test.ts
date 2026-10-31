// A titled thread gets a linked title on the feed page (session 28, Venkat).
//
// It worked for fragments and not for threads, and the cause was an accident
// of two renderers rather than a decision: a fragment card renders real HTML
// and runs `linkLeadingTitle` over it, while a thread card renders an escaped
// plain-text excerpt — so a leading <h1> arrived as the first words of the
// teaser, unstyled and unlinked.
//
// Presentation only, and it has to be. Decision #46: no title field at any
// version, items stay titleless (§5.3), and a *reader* MUST NOT extract a
// title from a leading heading. What a client does with its own pages is its
// own business — #46 calls the linked title "a studio task" in as many words.
import { describe, expect, it } from "vitest";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

async function publishThread(cookie: string, contentMd: string): Promise<string> {
  const id = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: contentMd, kind: "thread" })).json.id as string;
  expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
  return id;
}

describe("a titled thread on the feed page", () => {
  it("shows its leading heading as a link to the thread", async () => {
    const cookie = await login();
    const id = await publishThread(cookie, "# On stigmergy\n\nTrails are left by walking.");
    const html = await (await getPublic("/blyg/")).text();
    expect(html).toContain(`<a class="item-title" href="/blyg/t/${id}/">On stigmergy</a>`);
  });

  it("shows the heading once, as the title, with the body after it", async () => {
    const cookie = await login();
    await publishThread(cookie, "# On stigmergy\n\nTrails are left by walking.");
    const html = await (await getPublic("/blyg/")).text();
    const card = /<article class="fragment thread-card">([\s\S]*?)<\/article>/.exec(html);
    expect(card, "no thread card").not.toBeNull();
    expect(card![1].split("On stigmergy").length - 1).toBe(1);
    expect(card![1]).toContain("<p>Trails are left by walking.</p>");
    // The kind label is its own line, not glued to the first sentence (session 30).
    expect(card![1]).toContain('<p class="card-kind">thread</p>');
  });

  it("leaves an untitled thread exactly as it was", async () => {
    const cookie = await login();
    await publishThread(cookie, "No heading here, just a thread that runs on.");
    const html = await (await getPublic("/blyg/")).text();
    const card = /<article class="fragment thread-card">([\s\S]*?)<\/article>/.exec(html);
    expect(card![1]).not.toContain("thread-card-title");
    expect(card![1]).toContain("No heading here");
  });

  it("still keeps the read-the-thread link — the title is an addition, not a swap", async () => {
    const cookie = await login();
    const id = await publishThread(cookie, "# Titled\n\nBody.");
    const html = await (await getPublic("/blyg/")).text();
    expect(html).toContain(`href="/blyg/t/${id}/">read the thread →</a>`);
  });
});

describe("the wire is untouched — #46 and §5.3", () => {
  it("the item document keeps the bare heading and gains no title field", async () => {
    const cookie = await login();
    const id = await publishThread(cookie, "# On stigmergy\n\nTrails.");
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<Record<string, unknown>>();
    expect(doc.title, "items are titleless (§5.3)").toBeUndefined();
    // The heading is still a heading in the stored HTML, unlinked.
    expect(String(doc.content_html)).toContain("<h1>On stigmergy</h1>");
    expect(String(doc.content_html)).not.toContain("item-title");
  });

  it("the feed keeps the bare heading too", async () => {
    const cookie = await login();
    await publishThread(cookie, "# On stigmergy\n\nTrails.");
    const xml = await (await getPublic("/blyg/feed.xml")).text();
    expect(xml).not.toContain("item-title");
  });

  it("a fragment's title behaviour is unchanged", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "# A fragment title\n\nAnd a body.");
    const html = await (await getPublic("/blyg/")).text();
    expect(html).toContain(`<a class="item-title" href="/blyg/f/${id}/">`);
  });
});
