import { testMediaKey } from './helpers.ts';
import { testItemRevision } from './helpers.ts';
// Attachments per version (blygger-studio#7, migration 0031). §5.4 makes media
// part of a version: each version's document lists its own `media`, a later
// version may leave one out, and the earlier versions keep serving its bytes.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import migration0031 from "../migrations/0031_version_media.sql?raw";
import { apiJson, BASE, createAndPublish, getPublic, login } from "./helpers.ts";
import { getItem, restoreVersion } from "../src/model.ts";

async function upload(cookie: string, item: string, bytes: number[], extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...bytes])], "p.png", { type: "image/png" }));
  (form.set("itemId", item), form.set('expectedRevision', String(await testItemRevision(item))));
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  const res = await SELF.fetch(`${BASE}/blyg/api/media`, { method: "POST", headers: { cookie }, body: form });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; url: string };
}
const publish = async (cookie: string, id: string) => expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
const remove = async (cookie: string, media: string) => (await apiJson(cookie, "DELETE", `/blyg/api/media/${media}`)).json.outcome;
const document = async (id: string) => (await (await getPublic(`/blyg/items/${id}.json`)).json()) as { version: number; media: { url: string }[] };
const urls = async (id: string) => (await document(id)).media.map((m) => m.url);
const dirty = async (id: string) => (await env.DB.prepare("SELECT dirty FROM items WHERE id = ?").bind(id).first<{ dirty: number }>())!.dirty;

describe("attachments per version (studio#7)", () => {
  it("drops an attachment from the next version only, and keeps its bytes", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "two pictures below");
    const a = await upload(cookie, id, [1], { alt: "a" });
    const b = await upload(cookie, id, [2], { alt: "b" });
    await publish(cookie, id);
    expect(await urls(id)).toEqual([testMediaKey(a.url), testMediaKey(b.url)]);

    // An appended attachment is in no version's text, only in its list, and
    // removing it used to delete the bytes the live version still showed.
    expect(await remove(cookie, a.id)).toBe("detached");
    expect(await urls(id), "the live version keeps what it published").toEqual([testMediaKey(a.url), testMediaKey(b.url)]);
    expect(await dirty(id), "the working copy now differs").toBe(1);
    expect((await getPublic(new URL(a.url).pathname)).status).toBe(200);

    await publish(cookie, id);
    const next = await document(id);
    expect(next.media.map((m) => m.url)).toEqual([testMediaKey(b.url)]);
    expect((await getPublic(new URL(a.url).pathname)).status, "an earlier version still lists it (§5.4)").toBe(200);
    const page = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(page).toContain(testMediaKey(b.url));
    expect(page).not.toContain(testMediaKey(a.url));
    const feed = await (await getPublic("/blyg/feed.xml")).text();
    const entry = feed.slice(feed.indexOf(`<guid isPermaLink="false">`), feed.indexOf("</item>"));
    expect(feed).toContain(testMediaKey(b.url));
    expect(entry).not.toContain(testMediaKey(a.url));
  });

  it("lists an attachment added to a published item from its next version on", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "a picture is coming");
    const a = await upload(cookie, id, [3]);
    expect(await urls(id)).toEqual([]);
    expect(await dirty(id)).toBe(1);
    await publish(cookie, id);
    expect(await urls(id)).toEqual([testMediaKey(a.url)]);
  });

  it("deletes outright what no version listed", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "nothing attached yet");
    const a = await upload(cookie, id, [4]);
    expect(await remove(cookie, a.id)).toBe("deleted");
    expect(await env.MEDIA.get(testMediaKey(a.url))).toBeNull();
  });

  it("an inline attachment follows its version's text", async () => {
    const cookie = await login();
    const created = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "draft" });
    const id = created.json.id as string;
    const a = await upload(cookie, id, [5], { inline: "true" });
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: `![a](/blyg/${testMediaKey(a.url)})` })).status).toBe(200);
    await publish(cookie, id);
    expect(await urls(id)).toEqual([testMediaKey(a.url)]);
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "no picture now" })).status).toBe(200);
    await publish(cookie, id);
    expect(await urls(id)).toEqual([]);
  });

  it("discard restores removed attachments and excludes unpublished additions", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "published words");
    const original = await upload(cookie, id, [8]);
    await publish(cookie, id); // v2 owns the original attachment
    expect(await remove(cookie, original.id)).toBe("detached");
    const added = await upload(cookie, id, [9]);

    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, { version: 2 })).status).toBe(200);
    const detail = (await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json;
    expect(detail).toMatchObject({ dirty: false, version: 2 });
    expect(detail.media.map((m: { id: string }) => m.id)).toEqual([original.id]);
    expect(detail.publishedMedia.map((m: { id: string }) => m.id)).toEqual([original.id]);
    expect(await env.MEDIA.get(testMediaKey(added.url)), "discard does not destroy uploaded bytes").not.toBeNull();
    expect(await env.DB.prepare("SELECT item_id FROM media WHERE id = ?").bind(added.id).first()).toEqual({ item_id: null });

    await publish(cookie, id);
    expect(await urls(id)).toEqual([testMediaKey(original.url)]);
    expect((await getPublic(new URL(original.url).pathname)).status).toBe(200);
  });

  it("restoring an older version restores its attachments without changing the live version", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "published words");
    const old = await upload(cookie, id, [10]);
    await publish(cookie, id); // v2
    await remove(cookie, old.id);
    const current = await upload(cookie, id, [11]);
    await publish(cookie, id); // v3

    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, { version: 2 })).status).toBe(200);
    const detail = (await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json;
    expect(detail).toMatchObject({ dirty: true, version: 3 });
    expect(detail.media.map((m: { id: string }) => m.id)).toEqual([old.id]);
    expect(detail.publishedMedia.map((m: { id: string }) => m.id)).toEqual([current.id]);
    expect(await urls(id)).toEqual([testMediaKey(current.url)]);

    await publish(cookie, id);
    expect(await urls(id)).toEqual([testMediaKey(old.url)]);
    expect((await getPublic(new URL(current.url).pathname)).status, "v3 retains its bytes").toBe(200);
  });

  it("rejects a stale restore without changing text or attachment membership", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "published words");
    const original = await upload(cookie, id, [12]);
    await publish(cookie, id);
    await remove(cookie, original.id);
    const added = await upload(cookie, id, [13]);
    const stale = (await getItem(env.DB, id))!;
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "concurrent edit" });
    const before = (await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json;

    await expect(restoreVersion(env.DB, stale, 2)).rejects.toThrow("item revision conflict");
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json).toEqual(before);
    expect(before.media.map((m: { id: string }) => m.id)).toEqual([added.id]);
    expect(await env.DB.prepare("SELECT item_id FROM media WHERE id = ?").bind(original.id).first()).toEqual({ item_id: null });
  });
});

describe("migration 0031 backfill", () => {
  it("keeps every live document as it was, and gives an earlier version only what existed then", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "backfilled");
    const early = await upload(cookie, id, [6]);
    await publish(cookie, id); // v2, shows early
    const late = await upload(cookie, id, [7]); // attached after v2, never published
    const v = await env.DB.prepare("SELECT version, published_at FROM versions WHERE item_id = ? ORDER BY version").bind(id).all<{ version: number; published_at: string }>();
    const [v1, v2] = v.results;
    // Deterministic order: early after v1, late after v2.
    await env.DB.prepare("UPDATE media SET created = ? WHERE id = ?").bind(new Date(Date.parse(v1.published_at) + 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), early.id).run();
    await env.DB.prepare("UPDATE media SET created = ? WHERE id = ?").bind(new Date(Date.parse(v2.published_at) + 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), late.id).run();

    await env.DB.prepare("DELETE FROM version_media WHERE item_id = ?").bind(id).run();
    const backfill = migration0031.slice(migration0031.indexOf("INSERT OR IGNORE INTO version_media"));
    const statement = backfill.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").replace(/;\s*$/, "");
    await env.DB.prepare(statement).run();

    const rows = await env.DB.prepare("SELECT version, media_id FROM version_media WHERE item_id = ? ORDER BY version, media_id").bind(id).all();
    // v1 predates both; v2 is live, so it keeps everything attached today, as before.
    expect(rows.results).toEqual([{ version: v2.version, media_id: early.id }, { version: v2.version, media_id: late.id }].sort((x, y) => x.media_id.localeCompare(y.media_id)));
  });
});
