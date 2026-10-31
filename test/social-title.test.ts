// What an item's head says about itself (session 29), completing the
// social-card work f4ac2c9 started.
//
// Items are titleless on the wire (§5.3), so every title on a public page is
// derived. The derivation had one rule — clamp the text to 70 characters —
// which was right when nothing declared a title and wrong once #46 made a
// leading heading the item's title on the feed page, the permalink and the
// studio reader. A titled item's card read "On Protocols Protocols are the
// thin layer…": the title, then the title again as the start of the body.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiJson, BASE, createAndPublish, getPublic, login } from "./helpers.ts";

const ogTitle = (html: string) => /<meta property="og:title" content="([^"]*)">/.exec(html)?.[1];
const description = (html: string) => /<meta name="description" content="([^"]*)">/.exec(html)?.[1];
const docTitle = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1];

describe("a declared title is the title", () => {
  it("a leading heading becomes og:title, and the summary is what follows it", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_title: "Field Notes" });
    const id = await createAndPublish(cookie, "# On Protocols\n\nProtocols are the thin layer where coordination happens.");
    const html = await (await getPublic(`/blyg/f/${id}/`)).text();

    expect(ogTitle(html)).toBe("On Protocols");
    expect(docTitle(html)).toBe("On Protocols — Field Notes");
    // The body, not the title over again.
    expect(description(html)).toBe("Protocols are the thin layer where coordination happens.");
  });

  it("og:title carries no site suffix — og:site_name is the tag that says where", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_title: "Field Notes" });
    const id = await createAndPublish(cookie, "# Short\n\nbody");
    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(ogTitle(html)).not.toContain("Field Notes");
    expect(html).toContain('<meta property="og:site_name" content="Field Notes">');
  });

  it("an untitled item still unfurls as its opening words", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_title: "Field Notes" });
    const id = await createAndPublish(cookie, "no heading on this one, just a sentence");
    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(ogTitle(html)).toBe("no heading on this one, just a sentence");
    expect(docTitle(html)).toBe("no heading on this one, just a sentence — Field Notes");
  });

  it("a thread derives its title the same way a fragment does", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_title: "Field Notes" });
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "# A Thread\n\nthe argument", kind: "thread" }))
      .json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
    const html = await (await getPublic(`/blyg/t/${id}/`)).text();
    expect(ogTitle(html)).toBe("A Thread");
    expect(description(html)).toBe("the argument");
  });

  it("a very long heading is clamped, not printed whole into a card", async () => {
    const cookie = await login();
    const long = "A heading that keeps going well past the point where any card would show it";
    const id = await createAndPublish(cookie, `# ${long}\n\nbody`);
    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(ogTitle(html)!.length).toBeLessThanOrEqual(71);
    expect(ogTitle(html)).toContain("…");
  });
});

describe("the pinned page describes what froze", () => {
  it("takes its name from the pinned bytes, qualified by the version", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_title: "Field Notes" });
    const id = await createAndPublish(cookie, "# First Thoughts\n\nas written at the time");
    await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/${1}/pin`);
    // The live item moves on; the pin must not.
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { content_md: "# Second Thoughts\n\nrevised" });
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});

    const pinned = await (await getPublic(`/blyg/f/${id}/v1/`)).text();
    expect(docTitle(pinned)).toBe("First Thoughts (v1) — Field Notes");
    expect(ogTitle(pinned)).toBe("First Thoughts (v1)");
    expect(description(pinned)).toBe("as written at the time");

    const live = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(ogTitle(live)).toBe("Second Thoughts");
  });

  it("carries the blyg's avatar, never the item's current attachments", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: "https://example.org/blyg/" });
    const av = new FormData();
    av.set("file", new File([new Uint8Array([1, 2])], "me.png", { type: "image/png" }));
    const avatar = (await (
      await SELF.fetch(`${BASE}/blyg/api/media`, { method: "POST", headers: { cookie }, body: av })
    ).json()) as any;
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { avatar_media_id: avatar.id });

    const id = await createAndPublish(cookie, "pin me");
    await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/${1}/pin`);

    // An image attached to the live item after the pin froze.
    const form = new FormData();
    form.set("file", new File([new Uint8Array([3])], "later.png", { type: "image/png" }));
    form.set("item_id", id);
    const later = (await (
      await SELF.fetch(`${BASE}/blyg/api/media`, { method: "POST", headers: { cookie }, body: form })
    ).json()) as any;

    const pinned = await (await getPublic(`/blyg/f/${id}/v1/`)).text();
    expect(pinned).toContain(`<meta property="og:image" content="https://example.org/blyg/${avatar.url}">`);
    expect(pinned).not.toContain(later.url);
  });
});

describe("the archive unfurls as itself", () => {
  it("names the blyg and carries its avatar", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_title: "Field Notes", site_url: "https://example.org/blyg/" });
    const form = new FormData();
    form.set("file", new File([new Uint8Array([9])], "me.png", { type: "image/png" }));
    const avatar = (await (
      await SELF.fetch(`${BASE}/blyg/api/media`, { method: "POST", headers: { cookie }, body: form })
    ).json()) as any;
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { avatar_media_id: avatar.id });
    await createAndPublish(cookie, "something to list");

    const html = await (await getPublic("/blyg/archive/")).text();
    expect(ogTitle(html)).toBe("Archive — Field Notes");
    expect(html).toContain(`<meta property="og:image" content="https://example.org/blyg/${avatar.url}">`);
  });
});

describe("the archive names items the way every other surface does", () => {
  it("shows a titled item's title, with the body as a separate tail", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "# On Protocols\n\nProtocols are the thin layer where coordination happens.");
    const html = await (await getPublic("/blyg/archive/")).text();
    // The link is the title alone — not "On Protocols Protocols are the thin…",
    // which is what an excerpt of the whole rendered item produces.
    expect(html).toContain(`<a href="/blyg/f/${id}/">On Protocols</a>`);
    expect(html).toContain('<span class="row-sub">Protocols are the thin layer where coordination happens.</span>');
  });

  it("leaves an untitled item as its opening words, with no empty tail", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "just a sentence, no heading");
    const html = await (await getPublic("/blyg/archive/")).text();
    expect(html).toContain(`<a href="/blyg/f/${id}/">just a sentence, no heading</a>`);
    const row = html.slice(html.indexOf(`/blyg/f/${id}/`));
    expect(row.slice(0, row.indexOf("</li>"))).not.toContain("row-sub");
  });
});
