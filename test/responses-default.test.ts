// A global default for showing responses, overridable per item (session 28).
//
// `items.show_responses` was two-valued, so "off" and "no opinion" were the
// same row. A global default makes them different things: an item nobody has
// decided about should follow the setting, and one the author decided about
// should not. Migration 0012 adds a nullable `responses_override` for that.
//
// The session-23 ruling is unchanged in shape — a response list is opt-in,
// because it is a page built out of other people's items and publishing one is
// an editorial act. This moves that decision from per-item to once.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";
import { markInboundVerified, upsertInbound } from "../src/mentions/store.ts";
import { newId } from "../src/util.ts";

const OURS = "https://example.com/blyg/";

/** A verified response to one of our items, from a stranger. */
async function respondTo(itemId: string, origin = "https://friend.example/blyg/"): Promise<string> {
  const sourceId = newId();
  const source = `${origin}t/${sourceId}/`;
  const row = await upsertInbound(env.DB, source, `${OURS}f/${itemId}/`, itemId);
  await markInboundVerified(env.DB, row.id, {
    relation: "stub",
    sourceOrigin: origin,
    sourceId,
    sourceKind: "thread",
    sourceVersion: 1,
    authorJson: JSON.stringify({ name: "A Stranger" }),
    sourcePage: source,
  });
  return row.id;
}

const setDefault = (cookie: string, on: boolean) =>
  apiJson(cookie, "PATCH", "/blyg/api/settings", { showResponsesDefault: on });
const setItem = (cookie: string, id: string, mode: string) =>
  apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { responses: mode });
const page = async (id: string) => (await getPublic(`/blyg/f/${id}/`)).text();

// Settings are one row per blyg and this file's storage is shared across its
// tests, so every case states the default it depends on rather than inheriting
// whatever ran before it.

describe("the global default", () => {
  it("is off, so nothing changes for an existing blyg", async () => {
    const cookie = await login();
    await setDefault(cookie, false);
    const id = await createAndPublish(cookie, "an item");
    await respondTo(id);
    expect(await page(id)).not.toContain("A Stranger");
  });

  it("shows responses on every undecided item when turned on", async () => {
    const cookie = await login();
    await setDefault(cookie, false);
    const id = await createAndPublish(cookie, "an item");
    await respondTo(id);
    await setDefault(cookie, true);
    expect(await page(id)).toContain("A Stranger");
  });

  it("reaches items published before it was turned on", async () => {
    const cookie = await login();
    await setDefault(cookie, false);
    const id = await createAndPublish(cookie, "published first");
    await respondTo(id);
    expect(await page(id)).not.toContain("A Stranger");
    await setDefault(cookie, true);
    // The point of a default: it applies to what already exists, not only to
    // what comes next.
    expect(await page(id)).toContain("A Stranger");
  });
});

describe("a per-item override beats the default, both ways", () => {
  it("always-show wins while the default is off", async () => {
    const cookie = await login();
    await setDefault(cookie, false);
    const id = await createAndPublish(cookie, "an item");
    await respondTo(id);
    await setItem(cookie, id, "show");
    expect(await page(id)).toContain("A Stranger");
  });

  it("never-show wins after the default is turned on", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item");
    await respondTo(id);
    await setItem(cookie, id, "hide");
    await setDefault(cookie, true);
    // An author who said no about this item is not overruled by a later
    // change to a global preference.
    expect(await page(id)).not.toContain("A Stranger");
  });

  it("use-my-default hands the item back to the setting", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item");
    await respondTo(id);
    await setItem(cookie, id, "hide");
    await setDefault(cookie, true);
    expect(await page(id)).not.toContain("A Stranger");
    await setItem(cookie, id, "default");
    expect(await page(id)).toContain("A Stranger");
  });

  it("reports what is published, not what was asked for", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item");
    await setDefault(cookie, true);
    // With a default in play the caller cannot compute this itself.
    const res = await setItem(cookie, id, "default");
    expect(res.json).toMatchObject({ responses: "default" });
  });

  it("uses an explicit show preference as a hard override", async () => {
    const cookie = await login();
    await setDefault(cookie, false);
    const id = await createAndPublish(cookie, "an item");
    await respondTo(id);
    // Third-party tools already call this endpoint.
    const res = await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { responses: "show" });
    expect(res.status).toBe(200);
    expect(res.json.responses).toBe("show");
    expect(await page(id)).toContain("A Stranger");
  });

  it("rejects a mode it does not understand", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item");
    expect((await setItem(cookie, id, "sometimes")).status).toBe(400);
  });
});

describe("per-mention hiding is unaffected", () => {
  it("takes one response off a page the item is otherwise showing", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item");
    const mentionId = await respondTo(id);
    await setDefault(cookie, true);
    expect(await page(id)).toContain("A Stranger");
    await apiJson(cookie, "PATCH", `/blyg/api/mentions/${mentionId}`, { hidden: true });
    expect(await page(id)).not.toContain("A Stranger");
  });
});
