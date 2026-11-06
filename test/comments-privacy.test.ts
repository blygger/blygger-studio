// Comments to self must reach nothing public. The working copy keeps them; every
// surface below is read after publishing and must not hold the secret. The list
// follows the `pub` routes in src/index.ts, plus what leaves the Worker for a
// model. A new public route belongs here.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderFetchLike } from "../src/ai/provider.ts";
import { classifyChange } from "../src/change-class.ts";
import { draftChangeNote } from "../src/change-note.ts";
import { CommentPublishError } from "../src/comments.ts";
import { createDraft, getItem, publish, putSettings } from "../src/model.ts";
import { runGenerateScope } from "../src/tk-generate.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const SECRET = "xyzzyprivatenote";

beforeEach(() => putSettings(env.DB, { ai_model: "claude-opus-5" }));

async function publicBody(path: string): Promise<{ status: number; body: string }> {
  const res = await getPublic(path);
  return { status: res.status, body: await res.text() };
}

function provider(text: string): { fetch: ProviderFetchLike; bodies: string[] } {
  const bodies: string[] = [];
  const fetch: ProviderFetchLike = async (_url, init) => {
    bodies.push(String(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text }] }) };
  };
  return { fetch, bodies };
}

describe("no public surface carries a comment", () => {
  it("every public route, for a fragment, a thread quoting it, pinned versions and a hopper", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { hopperFeeds: true });
    const fragment = await createAndPublish(cookie, `Fragment words. /* ${SECRET} one */ And more.`, "first note");
    const thread = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: `# Title /* ${SECRET} heading */\n\n/* ${SECRET} block\n\nover paragraphs */\n\n![[${fragment}]]\n\nThread words.`, kind: "thread" })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);
    for (const id of [fragment, thread]) {
      expect((await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/1/pin`, {})).status).toBe(200);
    }
    const hopper = (await apiJson(cookie, "POST", "/blyg/api/hoppers", { name: "Comments" })).json as { id: string };
    await apiJson(cookie, "PATCH", `/blyg/api/hoppers/${hopper.id}`, { public: true });
    const slug = (await apiJson(cookie, "GET", `/blyg/api/hoppers/${hopper.id}`)).json.hopper.slug as string;
    expect((await apiJson(cookie, "PUT", `/blyg/api/hoppers/${hopper.id}/items/~own/${fragment}`)).status).toBe(200);

    const paths = [
      "/blyg/", "/blyg/archive", "/blyg/feed.xml", "/blyg/blyg.json", "/blyg/items/index.json",
      `/blyg/h/${slug}`, `/blyg/h/${slug}/feed.xml`,
      `/blyg/f/${fragment}/`, `/blyg/f/${fragment}/v1/`, `/blyg/items/${fragment}.json`, `/blyg/items/${fragment}/v1.json`,
      `/blyg/t/${thread}/`, `/blyg/t/${thread}/v1/`, `/blyg/items/${thread}.json`, `/blyg/items/${thread}/v1.json`,
    ];
    for (const path of paths) {
      const { status, body } = await publicBody(path);
      expect(status, path).toBeLessThan(400);
      expect(body, path).not.toContain(SECRET);
    }
    // The pages really were about these items.
    expect((await publicBody(`/blyg/f/${fragment}/`)).body).toContain("Fragment words.");
    expect((await publicBody(`/blyg/t/${thread}/`)).body).toContain("Thread words.");
    expect((await publicBody(`/blyg/t/${thread}/`)).body).toContain("Fragment words.");
  });

  it("stored versions, their hash and their HTML hold none of it, and the working copy keeps it", async () => {
    const item = await createDraft(env.DB, `Words. /* ${SECRET} */ More.`);
    await publish(env.DB, item, null);
    const row = await env.DB.prepare("SELECT * FROM versions WHERE item_id = ?").bind(item.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(row!.content_md).toBe("Words. More.");
    const after = await getItem(env.DB, item.id);
    expect(after!.content_md).toContain(SECRET);
    expect(after!.dirty).toBe(0);
  });

  it("a fork copies the published words", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, `Forkable. /* ${SECRET} */`);
    await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/1/pin`, {});
    const fork = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: "https://example.com/blyg", id, version: 1 } });
    expect(fork.status).toBe(201);
    expect(fork.json.contentMd).toContain("Forkable.");
    expect(JSON.stringify(fork.json)).not.toContain(SECRET);
  });
});

describe("what comments contain does nothing at publish", () => {
  it("a bad quote, bad link, ungenerated scope and @handle in a comment don't stop or touch it", async () => {
    const item = await createDraft(env.DB, `Words.\n\n/*\n![[nosuchitem00000000000000]]\n[[nosuchitem00000000000000]]\n[TK]never generated[/TK]\n@nobody\n*/`, "thread");
    expect(await publish(env.DB, item, null)).toBe(1);
    const row = await env.DB.prepare("SELECT content_md, transclusions, generated_json FROM versions WHERE item_id = ?").bind(item.id).first<{ content_md: string; transclusions: string; generated_json: string | null }>();
    expect(row!.content_md).toBe("Words.");
    expect(JSON.parse(row!.transclusions)).toEqual([]);
    expect(row!.generated_json).toBeNull();
  });

  it("a comment doesn't count against the fragment cap", async () => {
    const item = await createDraft(env.DB, `Short. /* ${"long ".repeat(400)} */`);
    expect(await publish(env.DB, item, null)).toBe(1);
  });

  it("a scope in a comment gives its provenance to no visible scope", async () => {
    const item = await createDraft(env.DB, "/* [TK]private[/TK] */\n\n[TK]public[/TK]");
    const first = await runGenerateScope({ ...env, AI_PROVIDER_KEY: "k" }, item, 0, provider(`${SECRET} output`).fetch);
    expect(first.ok).toBe(true);
    const second = await runGenerateScope({ ...env, AI_PROVIDER_KEY: "k" }, (await getItem(env.DB, item.id))!, 1, provider("public output").fetch);
    expect(second.ok).toBe(true);
    await publish(env.DB, (await getItem(env.DB, item.id))!, null);
    const row = await env.DB.prepare("SELECT content_md, generated_json FROM versions WHERE item_id = ?").bind(item.id).first<{ content_md: string; generated_json: string }>();
    expect(row!.content_md).toBe("public output");
    expect(JSON.parse(row!.generated_json)).toHaveLength(1);
    expect((await getItem(env.DB, item.id))!.content_md).toContain(SECRET);
  });
});

describe("publish refuses what it can't be sure of, and writes nothing", () => {
  it.each([
    ["an unclosed opener", `Words /* ${SECRET}`],
    ["a stray closer", `Words /* a */ ${SECRET} */`],
    ["only comments", `/* ${SECRET} */`],
  ])("%s", async (_name, text) => {
    const item = await createDraft(env.DB, text);
    await expect(publish(env.DB, item, null)).rejects.toThrow(CommentPublishError);
    expect((await getItem(env.DB, item.id))!.version).toBe(0);
    const { results } = await env.DB.prepare("SELECT 1 FROM versions WHERE item_id = ?").bind(item.id).all();
    expect(results).toHaveLength(0);
  });

  it("the API says why, as invalid input", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "Words /* open" })).json.id;
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain("never closed");
  });
});

describe("a comment-only edit is not an unpublished change", () => {
  const save = (cookie: string, id: string, contentMd: string) => apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd });

  it("stays clean, with no new version, and the next publish carries the note along", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "Published words.");
    const saved = await save(cookie, id, `Published words. /* ${SECRET} */`);
    expect(saved.status).toBe(200);
    expect(saved.json.dirty).toBe(false);
    expect(saved.json.contentMd).toContain(SECRET);
    expect((await getItem(env.DB, id))!.version).toBe(1);

    const edited = await save(cookie, id, `Published words, changed. /* ${SECRET} */`);
    expect(edited.json.dirty).toBe(true);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    expect((await getItem(env.DB, id))!.content_md).toContain(SECRET);
    expect((await publicBody(`/blyg/items/${id}.json`)).body).not.toContain(SECRET);
  });

  it("goes clean again once a half-typed comment closes", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "First.\n\nSecond.");
    expect((await save(cookie, id, "First.\n\n/* typing\n\nSecond.")).json.dirty).toBe(true);
    expect((await save(cookie, id, "First.\n\n/* typing */\n\nSecond.")).json.dirty).toBe(false);
  });

  it("a real edit, and an edit with no comments in it, still mark it dirty", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "Words.");
    expect((await save(cookie, id, "Words.")).json.dirty).toBe(true);
    const other = await createAndPublish(cookie, "Words.");
    expect((await save(cookie, other, "Other words. /* x */")).json.dirty).toBe(true);
  });

  it("a draft stays a draft", async () => {
    const cookie = await login();
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "Words." })).json.id;
    expect((await save(cookie, id, "Words. /* x */")).json.dirty).toBe(true);
  });

  it("generating a scope in a comment leaves a clean item clean", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "Words.");
    await save(cookie, id, "Words. /* [TK]note[/TK] */");
    const result = await runGenerateScope({ ...env, AI_PROVIDER_KEY: "k" }, (await getItem(env.DB, id))!, 0, provider("generated").fetch);
    expect(result.ok).toBe(true);
    expect((await getItem(env.DB, id))!.dirty).toBe(0);
  });
});

describe("the preview", () => {
  it("shows what readers get, and still lists a scope in a comment for generating", async () => {
    const cookie = await login();
    const res = await apiJson(cookie, "POST", "/blyg/api/preview", { contentMd: `Words. /* ${SECRET} [TK]note[/TK] */\n\n[TK]visible[=]out[/TK]`, kind: "fragment" });
    expect(res.status).toBe(200);
    expect(res.json.html).not.toContain(SECRET);
    expect(res.json.scopes.map((s: { instruction: string }) => s.instruction)).toEqual(["note", "visible"]);
    const thread = await apiJson(cookie, "POST", "/blyg/api/preview", { contentMd: `Words. /* ${SECRET} ![[nosuchitem00000000000000]] */`, kind: "thread" });
    expect(thread.json.html).not.toContain(SECRET);
    expect(thread.json.errors).toEqual([]);
  });

  it("a quote in a comment bakes nothing and takes no provenance line from a visible quote", async () => {
    const cookie = await login();
    const hidden = await createAndPublish(cookie, `${SECRET} quoted words`);
    const shown = await createAndPublish(cookie, "Shown words");
    const res = await apiJson(cookie, "POST", "/blyg/api/preview", { kind: "thread", contentMd: `/*\n![[${hidden}]]\n*/\n\n![[${shown}]]\n` });
    expect(res.json.errors).toEqual([]);
    expect(res.json.transclusions.map((t: { id: string }) => t.id)).toEqual([shown]);
    expect(res.json.html).not.toContain(SECRET);
    expect(res.json.html).not.toContain(`/f/${hidden}/`);
    expect(res.json.html).toContain('<p class="provenance">');
    expect(res.json.html).toContain(`/f/${shown}/`);
  });

  it("warns about what would stop a publish", async () => {
    const cookie = await login();
    const res = await apiJson(cookie, "POST", "/blyg/api/preview", { contentMd: `Words. /* ${SECRET}`, kind: "fragment" });
    expect(res.json.html).not.toContain(SECRET);
    expect(res.json.html).toContain("never closed");
  });
});

describe("nothing goes to a model that could come back in public", () => {
  it("a drafted change note is written from the words, not the notes", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "Old words.");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: `New words. /* ${SECRET} */` });
    const { fetch, bodies } = provider("Changed the words.");
    const result = await draftChangeNote({ ...env, AI_PROVIDER_KEY: "k" }, (await getItem(env.DB, id))!, fetch);
    expect(result.ok).toBe(true);
    expect(bodies.join()).not.toContain(SECRET);
    expect(bodies.join()).toContain("New words.");
  });

  it("a comment-only change has no change to describe", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "Same words.");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: `Same words. /* ${SECRET} */` });
    const { fetch, bodies } = provider("nothing");
    const result = await draftChangeNote({ ...env, AI_PROVIDER_KEY: "k" }, (await getItem(env.DB, id))!, fetch);
    expect(result.ok).toBe(false);
    expect(bodies).toEqual([]);
  });

  it("the change classifier compares the same words as a refresh, with no call", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "Same words.");
    await putSettings(env.DB, { ai_model_classify: "typesafe/test" });
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: `Same words. /* ${SECRET} */` });
    let called = false;
    const result = await classifyChange({ ...env, AI_PROVIDER_KEY: "k" }, (await getItem(env.DB, id))!, async () => {
      called = true;
      throw new Error("no call expected");
    });
    expect(called).toBe(false);
    expect(result).toMatchObject({ ok: true, category: "refresh" });
    await putSettings(env.DB, { ai_model_classify: "" });
  });

  it("a TK scope's context leaves out other comments, and keeps its own", async () => {
    const outside = await createDraft(env.DB, `/* ${SECRET} */ Words [TK]write[/TK].`);
    const a = provider("out");
    expect((await runGenerateScope({ ...env, AI_PROVIDER_KEY: "k" }, outside, 0, a.fetch)).ok).toBe(true);
    expect(a.bodies.join()).not.toContain(SECRET);
    expect(a.bodies.join()).toContain("Words");

    const inside = await createDraft(env.DB, `/* ${SECRET}other */ Words /* mine [TK]write[/TK] */`);
    const b = provider("out");
    expect((await runGenerateScope({ ...env, AI_PROVIDER_KEY: "k" }, inside, 0, b.fetch)).ok).toBe(true);
    expect(b.bodies.join()).not.toContain(`${SECRET}other`);
    expect(b.bodies.join()).toContain("mine");
  });
});

describe("a quote refresh", () => {
  it("doesn't count a comment as an unpublished edit", async () => {
    const cookie = await login();
    const fragment = await createAndPublish(cookie, "Quoted.");
    const thread = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: `![[${fragment}]]\n\nWords.`, kind: "thread" })).json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {});
    await apiJson(cookie, "PATCH", `/blyg/api/items/${thread}`, { contentMd: `![[${fragment}]]\n\nWords. /* ${SECRET} */` });
    const report = await apiJson(cookie, "GET", `/blyg/api/items/${thread}/freshness?probe=false`);
    expect(report.json.dirty).toBe(false);
  });
});
