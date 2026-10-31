// Generated changelog notes — decision #40, spec §5.2 + §16.6c.
//
// Three things matter: the depth rule is enforced, not merely requested (a note
// over an unpinned prior version never reproduces its withheld wording); the
// flag is emitted only when the note really is the studio's (drafted, unedited);
// and drafting never publishes.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderFetchLike } from "../src/ai/provider.ts";
import { draftChangeNote, quotesWithheld } from "../src/change-note.ts";
import { putSettings, getItem } from "../src/model.ts";

beforeEach(() => putSettings(env.DB, { ai_model: "claude-opus-5" }));
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

function provider(text: string): { fetch: ProviderFetchLike; bodies: any[] } {
  const bodies: any[] = [];
  const fetch: ProviderFetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text }] }) };
  };
  return { fetch, bodies };
}
const keyed = { ...env, AI_PROVIDER_KEY: "test-key" };

describe("the depth rule, mechanically", () => {
  const prior = "The old claim was that stigmergy needs no coordination at all, ever.";
  const next = "The claim is now narrower: stigmergy needs little explicit coordination.";

  it("catches a run of removed wording", () => {
    expect(quotesWithheld("Replaced 'stigmergy needs no coordination at all, ever' with a narrower claim.", prior, next)).toBe(true);
  });

  it("allows describing the change, and quoting wording that survives into the new version", () => {
    expect(quotesWithheld("Narrowed the central claim about coordination.", prior, next)).toBe(false);
    expect(quotesWithheld("Now says stigmergy needs little explicit coordination.", prior, next)).toBe(false);
  });
});

describe("drafting", () => {
  it("drafts from the published version and the working copy, and publishes nothing", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "First take on the idea.");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "First take on the idea, with an example added." });
    const { fetch, bodies } = provider("Added an example.");
    const result = await draftChangeNote(keyed, (await getItem(env.DB, id))!, fetch);
    expect(result).toMatchObject({ ok: true, note: "Added an example.", model: "test-model", pinnedPrior: false });
    // The prompt carries the withheld-text instruction because v1 is unpinned.
    expect(bodies[0].messages[0].content).toContain("The previous version is private");
    expect((await getItem(env.DB, id))!.version).toBe(1);
  });

  it("refuses a draft that reproduces an unpinned prior version's removed wording", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "A sentence that will be cut from the piece entirely.");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "Something else now." });
    const { fetch } = provider("Removed 'a sentence that will be cut from the piece'.");
    expect(await draftChangeNote(keyed, (await getItem(env.DB, id))!, fetch)).toMatchObject({ ok: false, status: 422 });
  });

  it("allows the same note when the prior version is pinned — nothing was withheld", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "A sentence that will be cut from the piece entirely.");
    await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/1/pin`);
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "Something else now." });
    const { fetch, bodies } = provider("Removed 'a sentence that will be cut from the piece'.");
    expect(await draftChangeNote(keyed, (await getItem(env.DB, id))!, fetch)).toMatchObject({ ok: true, pinnedPrior: true });
    expect(bodies[0].messages[0].content).not.toContain("The previous version is private");
  });

  it("has nothing to describe for a first version or an unchanged working copy", async () => {
    const cookie = await login();
    const draft = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "never published" })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${draft}/note-draft`)).status).toBe(409);
    const same = await createAndPublish(cookie, "unchanged");
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${same}/note-draft`)).status).toBe(409);
  });
});

describe("emission (§16.6c)", () => {
  it("marks a drafted, unedited note generated in the changelog", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "v1");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "v2" });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, { note: "Tightened the wording.", noteGenerated: true })).status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(doc.changelog).toEqual([
      expect.not.objectContaining({ generated: true }),
      expect.objectContaining({ version: 2, note: "Tightened the wording.", generated: true }),
    ]);
    const detail = (await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json;
    expect(detail.versions.map((v: { noteGenerated: boolean }) => v.noteGenerated)).toEqual([false, true]);
  });

  it("an author's note, or no note at all, is never marked generated", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "v1");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "v2" });
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, { note: "my words" });
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "v3" });
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, { noteGenerated: true });
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(doc.changelog.some((e: { generated?: boolean }) => e.generated)).toBe(false);
  });
});
