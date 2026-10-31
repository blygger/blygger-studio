// v0.3 Phase B task 17 (§3.4, Venkat's session-23 ruling): the public
// responses list — shape A (a citation trail, never a count), opt-in per
// item, with a per-response hide control, open to all origins.
//
// The load-bearing assertions here are the negative ones: a response list is
// page chrome, so it must not reach the item document, the feed, the hash, or
// a pinned page — otherwise a stranger's publish would mutate versioned state.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { markInboundVerified, upsertInbound } from "../src/mentions/store.ts";
import { newId } from "../src/util.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const OURS = "https://example.com/blyg/";

async function verifiedResponse(
  targetItemId: string,
  opts: { origin?: string; author?: string; relation?: "stub" | "transclusion" | "fork" } = {},
): Promise<string> {
  const origin = opts.origin ?? "https://friend.example/blyg/";
  const sourceId = newId();
  const source = `${origin}t/${sourceId}/`;
  const row = await upsertInbound(env.DB, source, `${OURS}f/${targetItemId}/`, targetItemId);
  await markInboundVerified(env.DB, row.id, {
    relation: opts.relation ?? "stub",
    sourceOrigin: origin,
    sourceId,
    sourceKind: "thread",
    sourceVersion: 1,
    authorJson: opts.author ? JSON.stringify({ name: opts.author }) : null,
    sourcePage: source,
  });
  return row.id;
}

describe("the public responses list (§3.4)", () => {
  it("shows nothing until the author opts the item in", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item people answer");
    await verifiedResponse(id, { author: "Their Name" });

    expect(await (await getPublic(`/blyg/f/${id}/`)).text()).not.toContain("Responses");

    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { responses: "show" })).status).toBe(200);
    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(html).toContain("Responses");
    expect(html).toContain("Their Name");
    // The origin is the load-bearing half: it is the only authenticated one.
    expect(html).toContain("friend.example");
    expect(html).toContain("stubbed this");
  });

  it("never prints a count", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item with several answers");
    for (let i = 0; i < 3; i++) await verifiedResponse(id, { origin: `https://n${i}.example/`, author: `Name ${i}` });
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { responses: "show" });

    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    const section = html.slice(html.indexOf('class="responses"'));
    expect(section).toContain("Name 0");
    expect(section).toContain("Name 2");
    expect(section).not.toMatch(/\b3 responses?\b/);
  });

  it("hides one response without deleting it, and puts it back", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item with a bad answer");
    const keep = await verifiedResponse(id, { origin: "https://good.example/", author: "Welcome" });
    const drop = await verifiedResponse(id, { origin: "https://spam.example/", author: "Unwelcome" });
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { responses: "show" });

    expect((await apiJson(cookie, "PATCH", `/blyg/api/mentions/${drop}`, { hidden: true })).status).toBe(200);
    let html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(html).toContain("Welcome");
    expect(html).not.toContain("Unwelcome");

    // Hiding affects public presentation; the owner resource still retains it.
    const mentions = await apiJson(cookie, "GET", "/blyg/api/mentions?direction=inbound");
    expect(mentions.status).toBe(200);
    expect(mentions.json.items.find((row: { id: string }) => row.id === drop)).toMatchObject({ hidden: true });
    await apiJson(cookie, "PATCH", `/blyg/api/mentions/${drop}`, { hidden: false });
    html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(html).toContain("Unwelcome");
    expect(keep).toBeTruthy();
  });

  it("shows only verified, un-hidden responses — never pending, failed or gone", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item with mixed claims");
    await verifiedResponse(id, { origin: "https://real.example/", author: "Verified" });
    const pending = await upsertInbound(env.DB, "https://liar.example/t/x/", `${OURS}f/${id}/`, id);
    await env.DB.prepare("UPDATE mentions_in SET source_author_json = ? WHERE id = ?")
      .bind(JSON.stringify({ name: "Unverified" }), pending.id)
      .run();
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { responses: "show" });

    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(html).toContain("Verified");
    expect(html).not.toContain("Unverified");
  });

  it("is chrome: it never reaches the document, the hash, the feed, or a pinned page", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item whose bytes are mine");
    // Pin first: pinning is *our* act and legitimately changes the document
    // (the changelog entry gains `pinned`). The snapshot must be taken after
    // it, so the only thing that could move it afterwards is the stranger.
    await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/${1}/pin`);
    const before = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    await verifiedResponse(id, { author: "A Stranger" });
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { responses: "show" });

    const after = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    // A stranger publishing must not change our versioned state — otherwise
    // every subscriber's importer reads it as a stealth edit (#18b).
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("A Stranger");
    expect(await (await getPublic("/blyg/feed.xml")).text()).not.toContain("A Stranger");
    // A pin is a frozen artifact; a live list on it would contradict the freeze.
    expect(await (await getPublic(`/blyg/f/${id}/v1/`)).text()).not.toContain("A Stranger");
  });

  it("clamps what an origin asserts about itself before it reaches the page", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item answered by a shouter");
    await verifiedResponse(id, { author: "X".repeat(500) });
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { responses: "show" });

    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(html).not.toContain("X".repeat(200));
    expect(html).toContain("…");
  });

  it("names the relation each response bears", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item quoted rather than stubbed");
    await verifiedResponse(id, { origin: "https://quoter.example/", relation: "transclusion", author: "Quoter" });
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { responses: "show" });
    expect(await (await getPublic(`/blyg/f/${id}/`)).text()).toContain("quoted this");
  });
});
