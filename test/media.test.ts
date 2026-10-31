// Task 5 acceptance: media round-trip through R2, type/size validation.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { testItemRevision, apiJson, BASE, createAndPublish, getPublic, login } from "./helpers.ts";

async function upload(cookie: string, file: File, extra: Record<string, string> = {}) {
  if (extra.item_id) extra = { ...extra, expectedRevision: String(await testItemRevision(extra.item_id)) };
  const form = new FormData();
  form.set("file", file);
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  const res = await SELF.fetch(`${BASE}/blyg/api/media`, { method: "POST", headers: { cookie }, body: form });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

describe("media (§3.3)", () => {
  it("round-trips a png through R2", async () => {
    const cookie = await login();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const { status, json } = await upload(cookie, new File([bytes], "pic.png", { type: "image/png" }), {
      alt: "a diagram",
    });
    expect(status).toBe(201);
    expect(json.url).toMatch(/^media\/[0-9abcdefghjkmnpqrstvwxyz]{8}\.png$/);

    expect((await getPublic(`/blyg/${json.url}`)).status).toBe(404);
    const res = await SELF.fetch(`${BASE}/blyg/${json.url}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("rejects non-image types and oversize files", async () => {
    const cookie = await login();
    const bad = await upload(cookie, new File(["hi"], "x.txt", { type: "text/plain" }));
    expect(bad.status).toBe(415);
    const big = await upload(
      cookie,
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }),
    );
    expect(big.status).toBe(413);
  });

  it("attached media appears in item JSON and feed description", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "fragment with image");
    const { json } = await upload(cookie, new File([new Uint8Array([1])], "p.png", { type: "image/png" }), {
      item_id: id,
      alt: "the alt text",
    });
    // An attachment joins the item with its next version (migration 0031).
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);

    const item = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(item.media).toEqual([{ url: json.url, mime: "image/png", alt: "the alt text" }]);

    // Feed description must be self-contained: absolute media URL (§2.6).
    const xml = await (await getPublic("/blyg/feed.xml")).text();
    expect(xml).toContain(`https://example.com/blyg/${json.url}`);
  });

  it("rejects uploads against a nonexistent item", async () => {
    const cookie = await login();
    const res = await upload(cookie, new File([new Uint8Array([1])], "p.png", { type: "image/png" }), {
      item_id: "nope00000000000000000000000",
    });
    expect(res.status).toBe(404);
  });
});

describe("avatar resolution (session 19)", () => {
  it("serves an avatar URL that actually resolves, on the page and in the manifest", async () => {
    const cookie = await login();
    const { json } = await upload(cookie, new File([new Uint8Array([1, 2])], "me.png", { type: "image/png" }));
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { avatar_media_id: json.id, author_name: "A. Author" });
    await createAndPublish(cookie, "hello");

    // The route matches on the full r2_key including the extension, so
    // `media/{id}` (what both surfaces used to emit) always 404d.
    expect(await (await getPublic(`/blyg/media/${json.id}`)).status).toBe(404);
    expect(await (await getPublic(`/blyg/${json.url}`)).status).toBe(200);

    const html = await (await getPublic("/blyg/")).text();
    expect(html).toContain(`<img class="avatar" src="/blyg/${json.url}"`);

    const manifest = (await (await getPublic("/blyg/blyg.json")).json()) as any;
    expect(manifest.author.avatar).toBe(json.url);
  });
});


describe("duplicate uploads (studio#7, migration 0028)", () => {
  const png = (...b: number[]) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...b])], "p.png", { type: "image/png" });

  it("returns the existing row for the same bytes on the same item, and stores nothing", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "fragment with a repeated image");
    const first = await upload(cookie, png(1, 2), { item_id: id, alt: "first" });
    expect(first.status).toBe(201);
    const again = await upload(cookie, png(1, 2), { item_id: id, alt: "second" });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ id: first.json.id, url: first.json.url, mime: "image/png", duplicate: true, revision: first.json.revision });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);

    const item = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(item.media).toEqual([{ url: first.json.url, mime: "image/png", alt: "first" }]);
  });

  it("stores a new row for different bytes, another type, another item, another placement, or no item", async () => {
    const cookie = await login();
    const a = await createAndPublish(cookie, "item a");
    const b = await createAndPublish(cookie, "item b");
    const base = await upload(cookie, png(3), { item_id: a });
    expect(base.status).toBe(201);
    const others = [
      await upload(cookie, png(4), { item_id: a }),
      await upload(cookie, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 3])], "p.webp", { type: "image/webp" }), { item_id: a }),
      await upload(cookie, png(3), { item_id: b }),
      await upload(cookie, png(3), { item_id: a, inline: "true" }),
      await upload(cookie, png(3)),
      await upload(cookie, png(3)),
    ];
    for (const r of others) {
      expect(r.status).toBe(201);
      expect(r.json.duplicate).toBeUndefined();
    }
    expect(new Set([base, ...others].map((r) => r.json.id)).size).toBe(7);
  });
});
