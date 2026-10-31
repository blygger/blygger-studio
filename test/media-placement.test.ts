// studio#24 and Venkat's report (session 32): a Studio upload is placed in the
// text, so it is shown only where its line is — once, and gone when the line
// is deleted. Uploads from other tools that never touch the text are appended.
// Removing an attachment keeps any bytes a published version still shows.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { unplacedMedia, visibleMedia } from "../src/util.ts";
import { stripStaleUploads } from "../src/ui/upload-tokens.ts";
import { apiJson, BASE, getPublic, login } from "./helpers.ts";

async function upload(cookie: string, itemId: string, name: string, inline: boolean) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2])], name, { type: "image/png" }));
  form.set("item_id", itemId);
  if (inline) form.set("inline", "true");
  const res = await SELF.fetch(`${BASE}/blyg/api/media`, { method: "POST", headers: { cookie }, body: form });
  return (await res.json()) as { id: string; url: string };
}
// Rendered images only — og:image in the head names the first image too, correctly.
const count = (html: string, key: string) => [...html.matchAll(/<img[^>]*>/g)].filter((m) => m[0].includes(key)).length;
async function publishText(cookie: string, id: string, md: string) {
  await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { content_md: md });
  expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
}

describe("placed and appended media", () => {
  it("a placed image renders once; deleting its line removes it everywhere; a tool's attachment is appended", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "draft" })).json.id as string;
    const placed = await upload(cookie, id, "placed.png", true);
    const tool = await upload(cookie, id, "tool.png", false);
    await publishText(cookie, id, `Look:\n\n![a picture](${placed.url})\n\nThat is all.`);

    let page = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(count(page, placed.url)).toBe(1);
    expect(count(page, tool.url)).toBe(1);
    let feed = await (await getPublic("/blyg/feed.xml")).text();
    expect(count(feed, placed.url)).toBe(1);
    expect(count(feed, tool.url)).toBe(1);
    expect((await (await getPublic(`/blyg/items/${id}.json`)).json<any>()).media).toHaveLength(2);

    await publishText(cookie, id, "Look: nothing now.");
    page = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(count(page, placed.url)).toBe(0);
    feed = await (await getPublic("/blyg/feed.xml")).text();
    expect(count(feed, placed.url)).toBe(0);
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(doc.media.map((m: { url: string }) => m.url)).toEqual([tool.url]);
  });

  it("matches keys as paths and respects the inline flag", () => {
    const rows = [{ r2_key: "media/a1.png", inline: 1 }, { r2_key: "media/b2.png", inline: 0 }, { r2_key: "media/c3.png", inline: 1 }];
    const html = '<img src="https://x.example/blyg/media/a1.png">';
    expect(unplacedMedia(rows, html)).toEqual([rows[1]]);
    expect(visibleMedia(rows, html)).toEqual([rows[0], rows[1]]);
  });
});

describe("removing an attachment", () => {
  it("deletes bytes nothing published shows", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "draft" })).json.id as string;
    const m = await upload(cookie, id, "unused.png", false);
    const res = await apiJson(cookie, "DELETE", `/blyg/api/media/${m.id}`);
    expect(res.json).toMatchObject({ ok: true, outcome: "deleted" });
    expect((await getPublic(`/blyg/${m.url}`)).status).toBe(404);
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json.media).toEqual([]);
  });

  it("keeps bytes a published version shows, and only detaches the row (§5.4)", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "draft" })).json.id as string;
    const m = await upload(cookie, id, "kept.png", true);
    await publishText(cookie, id, `![](${m.url})`);
    await publishText(cookie, id, "Image line deleted in v2.");
    const res = await apiJson(cookie, "DELETE", `/blyg/api/media/${m.id}`);
    expect(res.json).toMatchObject({ outcome: "detached" });
    expect((await getPublic(`/blyg/${m.url}`)).status).toBe(200);
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json.media).toEqual([]);
  });

  it("refuses the avatar", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "draft" })).json.id as string;
    const m = await upload(cookie, id, "face.png", false);
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('avatar_media_id', ?)").bind(m.id).run();
    expect((await apiJson(cookie, "DELETE", `/blyg/api/media/${m.id}`)).status).toBe(409);
  });
});

describe("abandoned upload placeholders", () => {
  it("are stripped, and nothing else is", () => {
    const text = "Before.\n\n![uploading shot.png…](#upload-lz9k2-3)\n\nAfter. ![real](media/x.png)";
    expect(stripStaleUploads(text)).toBe("Before.\n\nAfter. ![real](media/x.png)");
  });
});
