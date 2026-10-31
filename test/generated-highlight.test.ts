// Highlight generated portions on public pages (0.27.0): a blyg-wide default
// in settings, overridable per item, shaped like the responses default (0012).
//
// Presentation only. The default lives in style.css, so it changes every page
// at once and a page renders without reading settings; an item's own decision
// is a gen-on / gen-off class on its <article>. content_html, the item
// document and the feed are untouched.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";
import { THEMES } from "../src/themes.ts";

const setDefault = (cookie: string, on: boolean) =>
  apiJson(cookie, "PATCH", "/blyg/api/settings", { highlightGeneratedDefault: on });
const setItem = (cookie: string, id: string, mode: string) =>
  apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { highlight: mode });
const article = async (id: string) => /<article class="([^"]*)"/.exec(await (await getPublic(`/blyg/f/${id}/`)).text())![1];
const css = async () => (await getPublic("/blyg/style.css")).text();
const GENERATED = "Some words [TK]impyrt=pasted from elsewhere[/TK] and mine.";

describe("highlighting generated portions", () => {
  it("is off by default, and style.css carries only the per-item rule", async () => {
    const cookie = await login();
    await setDefault(cookie, false);
    const sheet = await css();
    expect(sheet).toContain(".gen-on .blyg-tk-gen {");
    expect(sheet).not.toContain("article:not(.gen-off) .blyg-tk-gen");
  });

  it("turned on, style.css highlights every article that has not opted out", async () => {
    const cookie = await login();
    await setDefault(cookie, true);
    expect(await css()).toContain("article:not(.gen-off) .blyg-tk-gen {");
    await setDefault(cookie, false);
  });

  it("an item's override is a class on its article; default removes it", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, GENERATED);
    expect(await article(id)).toBe("fragment");
    expect((await setItem(cookie, id, "show")).json.highlight).toBe("show");
    expect(await article(id)).toBe("fragment gen-on");
    await setItem(cookie, id, "hide");
    expect(await article(id)).toBe("fragment gen-off");
    expect((await setItem(cookie, id, "default")).json.highlight).toBe("default");
    expect(await article(id)).toBe("fragment");
  });

  it("leaves the item document alone", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, GENERATED);
    const before = await (await getPublic(`/blyg/items/${id}.json`)).text();
    await setItem(cookie, id, "show");
    expect(await (await getPublic(`/blyg/items/${id}.json`)).text()).toBe(before);
    expect(before).toContain('class=\\"blyg-tk-gen\\"');
    expect(before).not.toContain("gen-on");
  });

  it("every theme names its own highlight colours", () => {
    for (const theme of Object.values(THEMES)) {
      expect(theme.genBg).toMatch(/^#[0-9a-f]{6}$/);
      expect(theme.genRule).toMatch(/^#[0-9a-f]{6}$/);
      expect(theme.genBg).not.toBe(theme.paper);
    }
    void env;
  });
});
