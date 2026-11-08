// Changelog display and summaries (session 61): what an item's own page shows
// of its changelog, the AI summary's one-call-per-version cache, and a change
// note that summarizes the history to date.
//
// What matters: the summary reads notes and never text; it is written once per
// version however many views ask; it never reaches the item document or the
// feed; and "latest" leaves every page exactly as it was.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderFetchLike } from "../src/ai/provider.ts";
import { draftChangeNote, HISTORY_NOTE_MAX_CHARS } from "../src/change-note.ts";
import { capText, meaningful, ownChangelog, ownSubject, storedSummary, summarizeChangelog } from "../src/changelog-summary.ts";
import { getItem, putSettings } from "../src/model.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

beforeEach(() => putSettings(env.DB, { ai_model: "claude-opus-5" }));
afterEach(() => putSettings(env.DB, { changelog_display: "latest", changelog_summary_prompt: "" }));

function provider(text: string): { fetch: ProviderFetchLike; bodies: any[] } {
  const bodies: any[] = [];
  const fetch: ProviderFetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text }] }) };
  };
  return { fetch, bodies };
}
const keyed = { ...env, AI_PROVIDER_KEY: "test-key" };

/** An own fragment at v3 with three notes; v1 pinned. */
async function revised(cookie: string): Promise<string> {
  const id = await createAndPublish(cookie, "Stigmergy is coordination through traces.", "First take.");
  expect((await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/1/pin`, {})).status).toBe(200);
  await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "Stigmergy is coordination through traces left in a shared medium." });
  expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, { note: "Named the medium." })).status).toBe(200);
  await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "Stigmergy is coordination through traces left in a shared medium, as termites do." });
  expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, { note: "Added the termite example." })).status).toBe(200);
  return id;
}

describe("summary text", () => {
  it("is cut at a sentence end within the cap, or at a word with an ellipsis", () => {
    expect(capText("One. Two. Three.", 100)).toBe("One. Two. Three.");
    expect(capText("A first sentence here. A second one that runs long.", 30)).toBe("A first sentence here.");
    expect(capText("averyveryverylongwordwithnospace and more", 20)).toMatch(/…$/);
  });

  it("a changelog is worth summarizing with more than one version or any note", () => {
    expect(meaningful([{ version: 1, at: "x", note: null, pinned: false }])).toBe(false);
    expect(meaningful([{ version: 1, at: "x", note: "Why.", pinned: false }])).toBe(true);
    expect(meaningful([{ version: 1, at: "x", note: null, pinned: false }, { version: 2, at: "y", note: null, pinned: false }])).toBe(true);
  });
});

describe("the summary cache", () => {
  it("writes once per version from the notes alone, and serves the stored one after", async () => {
    const cookie = await login();
    const id = await revised(cookie);
    const entries = await ownChangelog(env.DB, id);
    const { fetch, bodies } = provider("It began as a first take, then named its medium and gained an example.");
    const first = await summarizeChangelog(keyed, ownSubject(id), 3, entries, fetch);
    expect(first).toMatchObject({ ok: true, cached: false, version: 3, model: "test-model" });
    const prompt = bodies[0].messages[0].content as string;
    expect(prompt).toContain("v1 (");
    expect(prompt).toContain("pinned");
    expect(prompt).toContain("Added the termite example.");
    // Notes only: the text of the item is never sent.
    expect(prompt).not.toContain("termites do");
    const again = await summarizeChangelog(keyed, ownSubject(id), 3, entries, fetch);
    expect(again).toMatchObject({ ok: true, cached: true });
    expect(bodies).toHaveLength(1);
  });

  it("a request that loses the claim gets 409, not a second model call", async () => {
    const cookie = await login();
    const id = await revised(cookie);
    const now = new Date();
    await env.DB.prepare("INSERT INTO changelog_summaries (subject, version, status, at) VALUES (?, 3, 'pending', ?)").bind(ownSubject(id), now.toISOString()).run();
    const { fetch, bodies } = provider("unused");
    expect(await summarizeChangelog(keyed, ownSubject(id), 3, await ownChangelog(env.DB, id), fetch, now)).toMatchObject({ ok: false, status: 409 });
    expect(bodies).toHaveLength(0);
    // A claim left by a request that died is taken over after ten minutes.
    const later = new Date(now.getTime() + 11 * 60 * 1000);
    expect(await summarizeChangelog(keyed, ownSubject(id), 3, await ownChangelog(env.DB, id), fetch, later)).toMatchObject({ ok: true });
  });

  it("a new version replaces the old summary, and the owner's instructions are sent", async () => {
    const cookie = await login();
    const id = await revised(cookie);
    await putSettings(env.DB, { changelog_summary_prompt: "Say which versions were small." });
    const { fetch, bodies } = provider("Summary at v3.");
    await summarizeChangelog(keyed, ownSubject(id), 3, await ownChangelog(env.DB, id), fetch);
    expect(bodies[0].messages[0].content).toContain("Say which versions were small.");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "Stigmergy, revised again." });
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, { note: "Rewrote the opening." });
    expect(await storedSummary(env.DB, ownSubject(id), 4)).toBeNull();
    const next = await summarizeChangelog(keyed, ownSubject(id), 4, await ownChangelog(env.DB, id), provider("Summary at v4.").fetch);
    expect(next).toMatchObject({ ok: true, summary: "Summary at v4.", version: 4 });
    expect(await storedSummary(env.DB, ownSubject(id), 3)).toBeNull();
  });
});

describe("an item's own page", () => {
  it("latest (the default) shows the version line's note and no changelog section", async () => {
    const cookie = await login();
    const id = await revised(cookie);
    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(html).toContain('<p class="version-note">&ldquo;Added the termite example.&rdquo;</p>');
    expect(html).not.toContain('aria-label="changelog"');
  });

  it("history lists every note newest first, links the pinned version, and drops the duplicate note", async () => {
    const cookie = await login();
    const id = await revised(cookie);
    await putSettings(env.DB, { changelog_display: "history" });
    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    const section = html.slice(html.indexOf('aria-label="changelog"'), html.indexOf("</section>", html.indexOf('aria-label="changelog"')));
    expect(section.indexOf("Added the termite example.")).toBeLessThan(section.indexOf("First take."));
    expect(section).toContain(`href="/blyg/f/${id}/v1/"`);
    expect(html).not.toContain('<p class="version-note">');
  });

  it("summary shows the stored summary, labelled; without one it shows the history", async () => {
    const cookie = await login();
    const id = await revised(cookie);
    await putSettings(env.DB, { changelog_display: "summary" });
    let html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(html).toContain('aria-label="changelog"');
    await env.DB.prepare("INSERT OR REPLACE INTO changelog_summaries (subject, version, status, summary, model, at) VALUES (?, 3, 'ready', 'A first take that named its medium.', 'test-model', ?)")
      .bind(ownSubject(id), new Date().toISOString()).run();
    html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(html).toContain("A first take that named its medium.");
    expect(html).toContain('class="ai-label"');
    // Studio-private: never in the item document or the feed.
    expect(await (await getPublic(`/blyg/items/${id}.json`)).text()).not.toContain("named its medium.");
    expect(await (await getPublic("/blyg/feed.xml")).text()).not.toContain("A first take that named its medium.");
  });

  it("a single version with no note shows only its version line", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "Once, without a note.");
    await putSettings(env.DB, { changelog_display: "history" });
    expect(await (await getPublic(`/blyg/f/${id}/`)).text()).not.toContain('aria-label="changelog"');
  });
});

describe("a change note that summarizes the history to date", () => {
  it("sends the earlier notes with the two texts, and keeps to its cap", async () => {
    const cookie = await login();
    const id = await revised(cookie);
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "Stigmergy, now with a second example from wikis." });
    const long = "It started as a first take. ".repeat(30);
    const { fetch, bodies } = provider(long);
    const result = await draftChangeNote(keyed, (await getItem(env.DB, id))!, fetch, { history: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.note.length).toBeLessThanOrEqual(HISTORY_NOTE_MAX_CHARS);
    const prompt = bodies[0].messages[0].content as string;
    expect(prompt).toContain("Earlier versions' notes");
    expect(prompt).toContain("Named the medium.");
    // The depth rule still holds: v3 is unpinned, so its text is private.
    expect(prompt).toContain("The previous version is private");
  });

  it("is off unless asked for", async () => {
    const cookie = await login();
    const id = await revised(cookie);
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "Stigmergy, changed." });
    const { fetch, bodies } = provider("Changed it.");
    await draftChangeNote(keyed, (await getItem(env.DB, id))!, fetch);
    expect(bodies[0].messages[0].content).not.toContain("Earlier versions' notes");
  });
});

describe("settings", () => {
  it("refuses a display mode that is not one of the three", async () => {
    const cookie = await login();
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { changelogDisplay: "everything" })).status).toBe(400);
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { readerChangelogDisplay: "history", changelogSummaryPrompt: "Brief." })).status).toBe(200);
  });
});
