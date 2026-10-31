import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BlyggerApi as api, createBlyggerClient, unwrap } from "../sdk/dist/browser.js";
import { createSubscription } from "../src/importer/store.ts";
import { BASE, login } from "./helpers.ts";

const damaged = [null, "{", "null", '"wrong type"', "42"];
const columns = [
  ["tk_provenance_json", "provenance", []], ["stub_of", "stub_of", null],
  ["forked_from", "forked_from", null], ["fork_cite", "fork_cite", null],
] as const;
const clientFor = (cookie: string) => createBlyggerClient({ baseUrl: BASE + '/blyg/api', headers: { cookie }, fetch: (request, init) => SELF.fetch(request instanceof Request ? request : new Request(request, init)) });
describe("stored JSON isolation through SDK", () => {
  for (const [column, field, fallback] of columns) it.each(damaged)(`${column} isolates damaged value %s`, async value => {
    const cookie = await login(), client = clientFor(cookie);
    const item = await unwrap(api.createItem({ client, body: { content_md: "readable", kind: "thread" } }));
    await env.DB.prepare(`UPDATE items SET ${column} = ? WHERE id = ?`).bind(value, item.id).run();
    const detail = await unwrap(api.getItem({ client, path: { id: item.id } }));
    expect(detail[field]).toEqual(fallback);
    expect(detail.content_md).toBe("readable");
    expect((await unwrap(api.listItems({ client }))).items.find(row => row.id === item.id)?.[field]).toEqual(fallback);
    expect((await env.DB.prepare(`SELECT ${column} AS value FROM items WHERE id = ?`).bind(item.id).first<{ value: string | null }>())?.value).toBe(value);
  });
  for (const [column, field, fallback] of [["generated_json", "generated", []], ["transclusions", "transclusions", []], ["stub_of", "stub_of", null], ["stub_cite", "stub_cite", null]] as const) it.each(["{", '"wrong type"'])(`published ${column} isolates %s`, async value => {
    const cookie = await login(), client = clientFor(cookie);
    const item = await unwrap(api.createItem({ client, body: { content_md: "published", kind: "thread" } }));
    await unwrap(api.publishItem({ client, path: { id: item.id } }));
    await env.DB.prepare(`UPDATE versions SET ${column} = ? WHERE item_id = ? AND version = 1`).bind(value, item.id).run();
    expect((await unwrap(api.getVersion({ client, path: { id: item.id, v: 1 } })))[field]).toEqual(fallback);
    expect((await unwrap(api.getItem({ client, path: { id: item.id } }))).versions[0][field]).toEqual(fallback);
    expect((await env.DB.prepare(`SELECT ${column} AS value FROM versions WHERE item_id = ?`).bind(item.id).first<{ value: string }>())?.value).toBe(value);
  });
  it.each(["{", "null", "{}"])("subscription flags isolate %s", async value => {
    const client = clientFor(await login());
    const sub = await createSubscription(env.DB, { kind: "rss", origin: "https://stored.example/", feedUrl: "https://stored.example/feed", title: "Readable subscription" });
    await env.DB.prepare("UPDATE subscriptions SET flags = ? WHERE id = ?").bind(value, sub.id).run();
    expect(await unwrap(api.getSubscription({ client, path: { id: sub.id } }))).toMatchObject({ title: "Readable subscription", flags: [] });
    expect((await env.DB.prepare("SELECT flags FROM subscriptions WHERE id = ?").bind(sub.id).first<{ flags: string }>())?.flags).toBe(value);
  });
  it("preserves valid citation values and root provenance extensions while another column is damaged", async () => {
    const cookie = await login(), client = clientFor(cookie);
    const item = await unwrap(api.createItem({ client, body: { content_md: "valid metadata", kind: "thread" } }));
    const citation = { source: "Source", author: "Author", excerpt: "quoted", url: "https://source.example/post", retrieved: "2026-10-01T00:00:00Z" };
    const reference = { origin: "https://source.example/", id: "remote", version: 2, cited: citation };
    const provenance = [{ sources: [], model: "model", at: "now", vendor: { request: "retained" } }, null];
    await env.DB.prepare("UPDATE items SET stub_of = ?, forked_from = ?, fork_cite = '{', tk_provenance_json = ? WHERE id = ?").bind(JSON.stringify(reference), JSON.stringify(reference), JSON.stringify(provenance), item.id).run();
    expect(await unwrap(api.getItem({ client, path: { id: item.id } }))).toMatchObject({ stub_of: reference, forked_from: reference, provenance, fork_cite: null });
    expect((await unwrap(api.getItem({ client, path: { id: item.id } }))).content_md).toBe("valid metadata");
  });
});
