// Forward-only version restore (session 17) + the studio history viewer route.
// The load-bearing property: restoring NEVER rewinds the version counter, so
// decision #19's strict +1 and importer invariant #18b (a subscriber must
// never see a version go backwards) both hold.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiJson, BASE, createAndPublish, getPublic, login } from "./helpers.ts";

async function publishEdit(cookie: string, id: string, contentMd: string, note?: string) {
  await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { content_md: contentMd });
  const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, note ? { note } : {});
  expect(res.status).toBe(200);
  return res.json.version as number;
}

describe("restore is forward-only", () => {
  it("loads old content into the working copy without moving the version", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "take one");
    await publishEdit(cookie, id, "take two");
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, { version: 1 })).json).toMatchObject({
      ok: true,
      restored: 1,
      publishesAs: 3,
    });

    // Public surface still serves v2 — restore published nothing.
    const pub = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(pub.version).toBe(2);
    expect(pub.content_md).toBe("take two");
  });

  it("publishing a restored draft moves the counter forward, never back", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "original");
    await publishEdit(cookie, id, "revised");
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, { version: 1 });
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, { note: "back to the original" });

    expect(res.json.version).toBe(3);
    const pub = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(pub.version).toBe(3);
    expect(pub.content_md).toBe("original"); // content came back...
    expect(pub.changelog.map((c: any) => c.version)).toEqual([1, 2, 3]); // ...history did not rewind
  });

  it("marks the item dirty so the restore is reviewable before publishing", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "v1 text");
    await publishEdit(cookie, id, "v2 text");
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, { version: 1 });
    const detail = await apiJson(cookie, "GET", `/blyg/api/items/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ dirty: true, version: 2, content_md: "v1 text" });
  });
});

describe("discard changes (restoring the current version)", () => {
  // venkateshrao.com/blyg/t/1t9vkcm4…, session 46: a stub published at the
  // quote's v7 while its working copy still cited v2. The text matched, so
  // publish had nothing to describe, but discard kept `dirty` and the old
  // citation, and the list said "unpublished changes" forever.
  it("brings back the published citation and leaves the copy clean", async () => {
    const cookie = await login();
    const stub = { url: "https://x.test/p", cited: { source: "X", url: "https://x.test/p", retrieved: "2026-10-03T00:00:00Z" } };
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "Re: that page", kind: "thread" })).json.id as string;
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { stub_of: stub });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    const published = (await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json.stub_of;

    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { stub_of: { ...stub, url: "https://x.test/q", cited: { ...stub.cited, url: "https://x.test/q" } } });
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json.dirty).toBe(true);

    await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, { version: 1 });
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json).toMatchObject({ dirty: false, stub_of: published, content_md: "Re: that page" });
  });

  it("never arises from publish: the agreed citation is written back to the working copy", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { site_url: "https://ours.example/blyg/" });
    const target = await createAndPublish(cookie, "their words");
    await publishEdit(cookie, target, "their words, revised");
    const id = (await apiJson(cookie, "POST", "/blyg/api/items", {
      content_md: `![[${target}]]\n\nMy take.`,
      kind: "thread",
      stub_of: { origin: "https://ours.example/blyg/", id: target, version: 1 },
    })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    expect((await (await getPublic(`/blyg/items/${id}.json`)).json<any>()).stub_of.version).toBe(2);
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json).toMatchObject({ dirty: false, stub_of: { version: 2 } });
  });

  it("clears an edit of the text", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "as published");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { content_md: "an edit" });
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, { version: 1 });
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json).toMatchObject({ dirty: false, content_md: "as published" });
  });

  it("keeps a version with generated text dirty: its provenance does not come back", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "plain");
    await env.DB.prepare("UPDATE versions SET generated_json = '[{}]' WHERE item_id = ?").bind(id).run();
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, { version: 1 });
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json.dirty).toBe(true);
  });
});

describe("restore rejects what it cannot restore", () => {
  it("404s an unknown item", async () => {
    const cookie = await login();
    expect((await apiJson(cookie, "POST", "/blyg/api/items/nope/restore", { version: 1 })).status).toBe(404);
  });

  it("400s without a version", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "x");
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, {})).status).toBe(400);
  });

  it("409s a version that does not exist", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "x");
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, { version: 99 });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/no version 99/);
  });

  it("409s a withdrawal endcap, which has no content", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "here then gone");
    const wd = await apiJson(cookie, "POST", `/blyg/api/items/${id}/withdraw`, {});
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, { version: wd.json.version });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/endcap/);
  });

  it("requires auth", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "x");
    const res = await SELF.fetch(`${BASE}/blyg/api/items/${id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("restore clears TK provenance", () => {
  it("drops the positional provenance cache, which cannot survive a content swap", async () => {
    // Published content_md is TK-stripped, so a restored copy has zero scopes;
    // keeping a scope-ordered provenance cache would misattribute generation
    // records to scopes that no longer exist.
    const cookie = await login();
    const id = await createAndPublish(cookie, "plain one");
    await publishEdit(cookie, id, "plain two");
    await env.DB.prepare("UPDATE items SET tk_provenance_json = ? WHERE id = ?")
      .bind(JSON.stringify([{ sources: [], model: "stale", at: "2026-01-01T00:00:00Z" }]), id)
      .run();

    await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, { version: 1 });

    const row = await env.DB.prepare("SELECT content_md, tk_provenance_json, dirty FROM items WHERE id = ?")
      .bind(id)
      .first<{ content_md: string; tk_provenance_json: string | null; dirty: number }>();
    expect(row?.content_md).toBe("plain one");
    expect(row?.tk_provenance_json).toBeNull();
    expect(row?.dirty).toBe(1);
  });
});

describe("studio history viewer", () => {
  it("serves any version's stored HTML, pinned or not", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "first *emphasis*");
    await publishEdit(cookie, id, "second", "changed my mind");

    const v1 = await (await SELF.fetch(`${BASE}/blyg/api/items/${id}/versions/1`, { headers: { cookie } })).json<any>();
    expect(v1.version).toBe(1);
    expect(v1.pinned).toBe(false); // unpinned, yet still readable locally
    expect(v1.content_html).toContain("<em>emphasis</em>");

    const v2 = await (await SELF.fetch(`${BASE}/blyg/api/items/${id}/versions/2`, { headers: { cookie } })).json<any>();
    expect(v2.note).toBe("changed my mind");
  });

  it("is studio-only: the public surface still serves pinned versions only", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "unpinned content");
    // Locally readable...
    const local = await SELF.fetch(`${BASE}/blyg/api/items/${id}/versions/1`, { headers: { cookie } });
    expect(local.status).toBe(200);
    // ...but not publicly promised.
    expect((await getPublic(`/blyg/items/${id}/v1.json`)).status).toBe(404);
  });

  it("404s an unknown version and requires auth", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "x");
    expect((await SELF.fetch(`${BASE}/blyg/api/items/${id}/versions/42`, { headers: { cookie } })).status).toBe(404);
    const noAuth = await SELF.fetch(`${BASE}/blyg/api/items/${id}/versions/1`, { redirect: "manual" });
    expect(noAuth.status).toBe(401);
  });
});
