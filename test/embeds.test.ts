// Public-page embeds (studio#9). The behaviour (poster, click-to-play, the
// failed-image link) is exercised in a real browser by e2e/embeds.spec.ts;
// this file pins where the script ships, that nothing reaches content_html,
// and the URL rule the page runs, compiled from the same string.
import { describe, expect, it } from "vitest";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";
import { EMBED_SCRIPT, YT_PARSE_JS } from "../src/embeds.ts";
import { layout } from "../src/pages.ts";

const ytParse = new Function(`${YT_PARSE_JS}; return ytParse;`)() as (href: string) => { id: string; start: number } | null;
const ID = "dQw4w9WgXcQ";

describe("ytParse, the rule the page runs", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`, 0],
    [`https://youtube.com/watch?feature=share&v=${ID}`, 0],
    [`http://m.youtube.com/watch?v=${ID}&t=90`, 90],
    [`https://music.youtube.com/watch?v=${ID}`, 0],
    [`https://youtu.be/${ID}`, 0],
    [`https://youtu.be/${ID}?t=1m30s`, 90],
    [`https://www.youtube.com/shorts/${ID}`, 0],
    [`https://www.youtube.com/live/${ID}/`, 0],
    [`https://www.youtube.com/embed/${ID}?start=12`, 12],
  ])("%s", (href, start) => {
    expect(ytParse(href)).toEqual({ id: ID, start });
  });

  it.each([
    `https://www.youtube.com/watch?v=short`,
    `https://www.youtube.com/watch?v=${ID}x`,
    `https://www.youtube.com/watch?v=${ID.slice(0, 10)}"`,
    `https://www.youtube.com/watch`,
    `https://www.youtube.com/channel/${ID}`,
    `https://www.youtube.com/shorts/${ID}/extra`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://evil.example/youtu.be/${ID}`,
    `https://user:pw@www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com:8443/watch?v=${ID}`,
    `javascript:alert(1)//youtu.be/${ID}`,
    `ftp://youtu.be/${ID}`,
    `/watch?v=${ID}`,
    `not a url`,
  ])("refuses %s", (href) => {
    expect(ytParse(href)).toBeNull();
  });
});

describe("the embed script ships where item HTML renders publicly", () => {
  it("on the feed, both permalinks and a pinned version, with content_html untouched", async () => {
    const cookie = await login();
    const href = `https://www.youtube.com/watch?v=${ID}`;
    const fragment = await createAndPublish(cookie, `A talk:\n\n${href}`);
    await apiJson(cookie, "PUT", `/api/items/${fragment}/versions/1/pin`);
    const thread = (await apiJson(cookie, "POST", "/api/items", { content_md: `A thread.\n\n${href}`, kind: "thread" })).json.id as string;
    await apiJson(cookie, "POST", `/api/items/${thread}/publish`, {});

    for (const path of ["/blyg/", `/blyg/f/${fragment}/`, `/blyg/t/${thread}/`, `/blyg/f/${fragment}/v1/`]) {
      const html = await (await getPublic(path)).text();
      expect(html, path).toContain(EMBED_SCRIPT);
      // The served item bytes are the published ones: a plain link, no facade.
      expect(html, path).toContain(`<a href="${href.replace("&", "&amp;")}">`);
      expect(html.replace(EMBED_SCRIPT, ""), path).not.toMatch(/yt-facade|youtube-nocookie|ytimg/);
    }

    const doc = await (await getPublic(`/blyg/items/${fragment}.json`)).json() as { content_html: string };
    expect(doc.content_html).not.toMatch(/yt-facade|ytimg|<figure|<iframe/);
  });

  it("on any public page with an article (hopper pages too), and not on one without", () => {
    expect(layout("t", '<div class="blyg"><article class="fragment"><p>x</p></article></div>', "/blyg")).toContain(EMBED_SCRIPT);
    expect(layout("t", '<div class="blyg"><p>Nothing here yet.</p></div>', "/blyg")).not.toContain(EMBED_SCRIPT);
  });

  it("styles live in the public stylesheet", async () => {
    const css = await (await getPublic("/blyg/style.css")).text();
    expect(css).toContain(".yt-facade .yt-play");
    expect(css).toContain("aspect-ratio: 16 / 9");
    expect(css).toContain(".img-fallback");
  });
});
