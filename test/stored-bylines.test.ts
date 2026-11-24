// Stored bylines (blygger-spec docs/multi-author-plan.md §4, M1; migration 0062). A version
// keeps the `author` it was published with; a version from before keeps being served from
// settings, so nothing anyone fetched changes the day this ships.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { putSettings } from "../src/model.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const ORIGIN = "https://example.com/blyg/";
const named = (name: string, url = "") => putSettings(env.DB, { author_name: name, author_url: url });
const doc = async (id: string) => (await getPublic(`/blyg/items/${id}.json`)).json<{ author: { name: string; url: string } }>();

afterEach(() => named("Test Author"));

describe("stored bylines", () => {
  it("serves a new publish exactly as before: the blyg's author, with the origin as the default url", async () => {
    await named("Alice");
    const cookie = await login();
    const id = await createAndPublish(cookie, "a fragment by alice");
    expect((await doc(id)).author).toEqual({ name: "Alice", url: ORIGIN });
    const row = await env.DB.prepare("SELECT author_json FROM versions WHERE item_id = ? AND version = 1").bind(id).first<{ author_json: string }>();
    expect(JSON.parse(row!.author_json)).toEqual({ name: "Alice", url: ORIGIN });
    expect((await env.DB.prepare("SELECT author_id FROM items WHERE id = ?").bind(id).first<{ author_id: string }>())!.author_id).toBe("owner");
  });

  it("keeps a version's byline when settings change, in the document, the pin, the feed and the page", async () => {
    await named("Alice", "https://alice.example/");
    const cookie = await login();
    const id = await createAndPublish(cookie, "kept byline text");
    expect((await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/1/pin`, {})).status).toBe(200);
    await named("Bob");

    expect((await doc(id)).author).toEqual({ name: "Alice", url: "https://alice.example/" });
    const pin = await (await getPublic(`/blyg/items/${id}/v1.json`)).json<{ author: { name: string } }>();
    expect(pin.author.name).toBe("Alice");
    const feed = await (await getPublic("/blyg/feed.xml")).text();
    const entry = feed.slice(feed.indexOf(`<blyg:id>${id}</blyg:id>`) - 400, feed.indexOf(`<blyg:id>${id}</blyg:id>`));
    expect(entry).toContain("<dc:creator>Alice</dc:creator>");
    const page = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(page).toContain('<a class="p-author h-card" href="https://alice.example/" hidden>Alice</a>');

    // The next publish takes the byline of its day.
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "kept byline text, edited" })).status).toBe(200);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    expect((await doc(id)).author).toEqual({ name: "Bob", url: ORIGIN });
    expect((await (await getPublic(`/blyg/items/${id}/v1.json`)).json<{ author: { name: string } }>()).author.name).toBe("Alice");
  });

  it("serves a version from before stored bylines from settings, as it always was", async () => {
    await named("Alice");
    const cookie = await login();
    const id = await createAndPublish(cookie, "an older version");
    await env.DB.prepare("UPDATE versions SET author_json = NULL WHERE item_id = ?").bind(id).run();
    await named("Carol", "https://carol.example/");
    expect((await doc(id)).author).toEqual({ name: "Carol", url: "https://carol.example/" });
  });

  it("keeps the byline on a withdrawal's endcap, and stores one on a private version", async () => {
    await named("Alice");
    const cookie = await login();
    const id = await createAndPublish(cookie, "to be withdrawn");
    await named("Bob");
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/withdraw`, {})).status).toBe(200);
    expect((await doc(id)).author.name).toBe("Alice");

    const created = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "a private one", kind: "fragment" });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${created.json.id}/publish`, { visibility: "private" })).status).toBe(200);
    const kept = await env.DB.prepare("SELECT author_json FROM private_versions WHERE item_id = ?").bind(created.json.id).first<{ author_json: string }>();
    expect(JSON.parse(kept!.author_json)).toEqual({ name: "Bob", url: ORIGIN });
  });
});
