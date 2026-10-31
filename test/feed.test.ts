// Task 7 acceptance: feed.xml validates as RSS 2.0 and follows §2.6 exactly.
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

async function fetchFeed(): Promise<string> {
  const res = await getPublic("/blyg/feed.xml");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/rss+xml");
  return res.text();
}

function parse(xml: string) {
  expect(XMLValidator.validate(xml)).toBe(true);
  return new XMLParser({ ignoreAttributes: false, isArray: (name) => name === "item" }).parse(xml);
}

describe("feed.xml (§2.6)", () => {
  it("is valid RSS 2.0 with the blyg namespace and channel metadata", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteTitle: "A Test Blyg", authorBio: "a bio" });
    await createAndPublish(cookie, "a fragment");

    const doc = parse(await fetchFeed());
    expect(doc.rss["@_version"]).toBe("2.0");
    expect(doc.rss["@_xmlns:blyg"]).toBe("https://blygger.org/ns/0.1");
    const ch = doc.rss.channel;
    expect(ch.title).toBe("A Test Blyg");
    expect(ch.link).toBe("https://example.com/blyg/");
    expect(ch.description).toBe("a bio");
    expect(new Date(ch.lastBuildDate).toString()).not.toBe("Invalid Date");
    expect(ch["blyg:level"]).toBe(2);
    expect(ch["blyg:manifest"]).toBe("https://example.com/blyg/blyg.json");
  });

  it("is subscribable in strict readers: self link, non-empty description, absolute titled discovery", async () => {
    // studio#33: a relative, untitled <link rel=alternate> was ignored by
    // several readers, and an empty <description> failed strict ones.
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteTitle: "Strict Blyg", authorBio: "" });
    const id = await createAndPublish(cookie, "a fragment");
    const doc = parse(await fetchFeed());
    expect(doc.rss["@_xmlns:atom"]).toBe("http://www.w3.org/2005/Atom");
    expect(doc.rss.channel["atom:link"]["@_href"]).toBe("https://example.com/blyg/feed.xml");
    expect(doc.rss.channel["atom:link"]["@_rel"]).toBe("self");
    expect(doc.rss.channel.description).toBe("Strict Blyg");
    for (const path of ["/blyg/", `/blyg/f/${id}/`]) {
      const html = await (await getPublic(path)).text();
      expect(html).toContain('<link rel="alternate" type="application/rss+xml" title="Strict Blyg" href="https://example.com/blyg/feed.xml">');
    }
  });

  it("bylines each item with dc:creator when author.name is present, and only then (§7, C-7-08)", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { authorName: "" });
    await createAndPublish(cookie, "no byline yet");
    let xml = await fetchFeed();
    expect(xml).not.toContain("dc:creator");
    expect(xml).not.toContain("xmlns:dc");
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { authorName: "Ada & Co" });
    xml = await fetchFeed();
    const doc = parse(xml);
    expect(doc.rss["@_xmlns:dc"]).toBe("http://purl.org/dc/elements/1.1/");
    for (const item of doc.rss.channel.item) expect(item["dc:creator"]).toBe("Ada & Co");
    expect(xml).toContain("<dc:creator>Ada &amp; Co</dc:creator>");
  });

  it("item entries carry guid, link, title, pubDate, and blyg extensions", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "some **bold** text for the feed", "first note");
    const doc = parse(await fetchFeed());
    const item = doc.rss.channel.item.find((i: any) => i["blyg:id"] === id);
    expect(item).toBeDefined();
    expect(item.guid["#text"]).toBe(`blyg:${id}:v1`);
    expect(item.guid["@_isPermaLink"]).toBe("false");
    expect(item.link).toBe(`https://example.com/blyg/f/${id}/`);
    expect(item.title).toBe("first note — some bold text for the feed");
    expect(new Date(item.pubDate).toString()).not.toBe("Invalid Date");
    expect(item.description).toContain("<strong>bold</strong>");
    expect(item["blyg:kind"]).toBe("fragment");
    expect(item["blyg:version"]).toBe(1);
    expect(String(item["blyg:created"])).toMatch(/Z$/);
    expect(item["blyg:item"]).toBe(`https://example.com/blyg/items/${id}.json`);
  });

  it("windows to the latest 50 publish events", async () => {
    const cookie = await login();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await createAndPublish(cookie, `fragment number ${i}`));
    // Republish some items to exceed 50 events total: 12 + 4*10 = 52.
    for (let round = 0; round < 10; round++) {
      for (const id of ids.slice(0, 4)) {
        await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: `round ${round}` });
        await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
      }
    }
    const doc = parse(await fetchFeed());
    expect(doc.rss.channel.item.length).toBe(50);
  });

  it("survives hostile content: ]]> and XML metacharacters", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, 'a ]]> b & <angle> "quotes"', 'note & <tag>');
    const xml = await fetchFeed();
    const doc = parse(xml);
    const item = doc.rss.channel.item.find((i: any) => i["blyg:id"] === id);
    expect(item.title).toContain("note & <tag>");
    expect(item.description).toContain("]]&gt;");
  });

  it("truncates long titles to ~60 chars of plain text", async () => {
    const cookie = await login();
    const long = "word ".repeat(50).trim();
    const id = await createAndPublish(cookie, long);
    const doc = parse(await fetchFeed());
    const item = doc.rss.channel.item.find((i: any) => i["blyg:id"] === id);
    expect(item.title.length).toBeLessThanOrEqual(62);
    expect(item.title.endsWith("…")).toBe(true);
  });
});
