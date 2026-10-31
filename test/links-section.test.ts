// The links section on every public page (session 47, src/pages.ts linksSection).

import { beforeEach, describe, expect, it } from "vitest";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

async function publishThread(cookie: string, contentMd: string): Promise<string> {
  const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: contentMd, kind: "thread" })).json.id as string;
  expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
  return id;
}

const page = async (path: string) => (await getPublic(path)).text();
const aside = (html: string) => /<nav class="blyg-links"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";

const DEFAULTS = {
  links_position: "left", links_threads: [], links_external: [], front_page: "",
  links_collections: true, links_opml: true, links_blygger_org: true, links_blygger_com: true,
};

// Settings outlive a test in this pool, so each starts from the defaults.
beforeEach(async () => {
  expect((await apiJson(await login(), "PATCH", "/blyg/api/settings", DEFAULTS)).status).toBe(200);
});

describe("the settings", () => {
  it("default to a left sidebar with the standard links on", async () => {
    const settings = (await apiJson(await login(), "GET", "/blyg/api/settings")).json;
    expect(settings).toMatchObject(DEFAULTS);
  });

  it("refuse a fragment, a draft or an unknown id as a listed thread, and a link without a label or a followable url", async () => {
    const cookie = await login();
    const fragment = await createAndPublish(cookie, "a fragment");
    for (const id of [fragment, "nosuchitem"]) {
      expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { links_threads: [id] })).status).toBe(400);
    }
    for (const link of [{ label: "", url: "https://example.org/" }, { label: "x", url: "javascript:alert(1)" }, { label: "x", url: "/relative" }]) {
      expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { links_external: [link] })).status).toBe(400);
    }
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { links_position: "top" })).status).toBe(400);
  });
});

describe("the public pages", () => {
  it("list the chosen threads in order, the owner's links and the standard links, on every page", async () => {
    const cookie = await login();
    const first = await publishThread(cookie, "# About\n\nWho writes here.");
    const second = await publishThread(cookie, "# Now\n\nWhat I am doing now.");
    const post = await createAndPublish(cookie, "an ordinary post");
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", {
      links_threads: [second, first],
      links_external: [{ label: "Résumé", url: "https://example.org/resume.pdf" }],
    })).status).toBe(200);

    for (const path of ["/blyg/", "/blyg/archive/", `/blyg/f/${post}/`, `/blyg/t/${first}/`]) {
      const links = aside(await page(path));
      expect(links, path).toContain(`<a href="/blyg/t/${second}/">Now</a>`);
      expect(links.indexOf(`/t/${second}/`), path).toBeLessThan(links.indexOf(`/t/${first}/`));
      expect(links, path).toContain(`<a href="https://example.org/resume.pdf">Résumé</a>`);
      expect(links, path).toContain(`href="https://blygger.org/"`);
      expect(links, path).toContain(`href="https://blygger.com/"`);
    }
  });

  it("drops a withdrawn thread, points the front page at the root, and leaves out what is turned off", async () => {
    const cookie = await login();
    const gone = await publishThread(cookie, "# Gone\n\nSoon withdrawn.");
    const front = await publishThread(cookie, "# Home\n\nThe front page.");
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { links_threads: [gone, front], front_page: front });
    expect(aside(await page("/blyg/posts/"))).toContain(`<a href="/blyg/">Home</a>`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${gone}/withdraw`, {})).status).toBe(200);
    let links = aside(await page("/blyg/posts/"));
    expect(links).not.toContain(`/t/${gone}/`);
    // The settings form sends every field back: a stale list and front page still save.
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { links_threads: [gone, front], front_page: front, site_title: "still saves" })).status).toBe(200);
    expect((await apiJson(cookie, "GET", "/blyg/api/settings")).json.links_threads).toEqual([front]);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${front}/withdraw`, {})).status).toBe(200);
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { front_page: front, site_title: "saves again" })).status).toBe(200);

    await apiJson(cookie, "PATCH", "/blyg/api/settings", { links_threads: [], links_blygger_org: false, links_blygger_com: false, links_opml: false, links_collections: false });
    links = aside(await page("/blyg/posts/"));
    expect(links).toBe("");
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_title: "" });
  });

  it("is a sidebar only when a side is chosen and there is something to show", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { links_position: "bottom" });
    expect(await page("/blyg/")).toContain('<div class="blyg">');
    expect(await page("/blyg/")).not.toContain('class="links-toggle"');
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { links_position: "left" });
    const side = await page("/blyg/");
    expect(side).toContain('<div class="blyg has-side side-left">');
    // A side menu comes before the content and folds behind a Menu button on a phone.
    expect(side.indexOf('<nav class="blyg-links"')).toBeLessThan(side.indexOf('<div class="blyg-main">'));
    expect(side).toContain('<button type="button" class="links-toggle" aria-controls="blyg-links" aria-expanded="false" hidden>Menu</button>');
    const script = [...side.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((b) => b.includes("links-toggle"));
    expect(() => new Function(script!)).not.toThrow();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { links_blygger_org: false, links_blygger_com: false, links_opml: false, links_collections: false });
    expect(await page("/blyg/")).toContain('<div class="blyg">');
  });
});
