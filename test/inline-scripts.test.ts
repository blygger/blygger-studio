// Every studio and public page ships hand-written JS inside a template
// literal. That is a parser hazard the rest of the suite cannot see: an
// assertion about the HTML passes whether or not the <script> it contains is
// valid JavaScript.
//
// Session 19 shipped a broken studio this way. A confirm() string was written
// with "\n" inside the TS template literal, so the emitted JS contained a real
// newline in the middle of a string literal — SyntaxError on load, every
// studio click handler dead, and 400 green tests.
import { describe, expect, it } from "vitest";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

function scriptBodies(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/**
 * Parses without executing. `new Function` compiles its body, so a syntax
 * error throws here; nothing in the body runs.
 */
function assertParses(src: string, where: string) {
  expect(src.length, `${where}: empty script`).toBeGreaterThan(0);
  expect(() => new Function(src), where).not.toThrow();
}

describe("every inline script parses", () => {
  it("the generated-text badge script, on a page with generated text", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "mine [TK]impyrt=generated words[/TK]");
    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    const bodies = scriptBodies(html);
    expect(bodies.some((b) => b.includes("gen-badge"))).toBe(true);
    bodies.forEach((b, i) => assertParses(b, `generated page script ${i}`));
  });

  it("public pages that render an item", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item with versions");
    await apiJson(cookie, "PUT", `/api/items/${id}/versions/${1}/pin`);
    const thread = (await apiJson(cookie, "POST", "/api/items", { content_md: "a thread", kind: "thread" })).json
      .id as string;
    await apiJson(cookie, "POST", `/api/items/${thread}/publish`, {});

    // Session 21 put the version-nav script on the permalink and thread pages
    // too, so all three need the parse check, not just the feed.
    // The embed script (studio#9) rides on every page with an article,
    // pinned versions included.
    for (const path of ["/blyg/", `/blyg/f/${id}/`, `/blyg/t/${thread}/`, `/blyg/f/${id}/v1/`]) {
      const bodies = scriptBodies(await (await getPublic(path)).text());
      expect(bodies.length, path).toBeGreaterThan(0);
      expect(bodies.some((b) => b.includes("yt-facade")), `${path} embed script`).toBe(true);
      bodies.forEach((b, i) => assertParses(b, `${path} script ${i}`));
    }
  });

  // Not inline, but the same hazard: the studio's service worker is a TS
  // template literal emitted as JavaScript (src/spa.ts).
  it("the studio service worker", async () => {
    const res = await getPublic("/blyg/studio/sw.js");
    expect(res.status).toBe(200);
    assertParses(await res.text(), "studio sw.js");
  });

});
