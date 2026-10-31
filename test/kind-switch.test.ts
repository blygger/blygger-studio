// Switching a draft between fragment and thread (session 28).
//
// The composer's toggle has always worked by deleting the draft and recreating
// it, which is safe only because the text lives in the textarea it was typed
// into. Past the Full Editor door that stops being true — the draft has
// attachments, TK scopes and a save history — so the editor changes the row in
// place instead. Before this, choosing the wrong kind and clicking through
// meant retyping.
//
// The boundary under test is `version === 0`. A draft has no wire presence, so
// its kind is studio state; a published item's kind is a field readers already
// have and history records, and must never move.
import { describe, expect, it } from "vitest";
import { apiJson, createAndPublish, login } from "./helpers.ts";

const ORIGIN = "https://friend.example/blyg/";

async function draft(cookie: string, kind: "fragment" | "thread", contentMd = "a draft"): Promise<string> {
  const res = await apiJson(cookie, "POST", "/blyg/api/items", { content_md: contentMd, kind });
  expect(res.status).toBe(201);
  return res.json.id as string;
}

async function detail(cookie: string, id: string) {
  const res = await apiJson(cookie, "GET", `/blyg/api/items/${id}`);
  expect(res.status).toBe(200);
  return res.json;
}

describe("a never-published draft can change kind", () => {
  it("fragment to thread, keeping the text and landing in the thread editor", async () => {
    const cookie = await login();
    const id = await draft(cookie, "fragment", "words I want to keep");
    expect((await detail(cookie, id)).authored_kind).toBe("fragment");

    const res = await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { kind: "thread" });
    expect(res.status).toBe(200);
    expect(res.json.kind).toBe("thread");

    // The same resource keeps its text when its authored kind changes.
    expect(await detail(cookie, id)).toMatchObject({ id, authored_kind: "thread", content_md: "words I want to keep" });
  });

  it("thread to fragment, the same way", async () => {
    const cookie = await login();
    const id = await draft(cookie, "thread", "words I want to keep");
    expect(await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { kind: "fragment" })).toMatchObject({ status: 200 });
    expect(await detail(cookie, id)).toMatchObject({ id, authored_kind: "fragment", content_md: "words I want to keep" });
  });

  it("accepts kind and content_md in one call", async () => {
    const cookie = await login();
    const id = await draft(cookie, "fragment", "before");
    const res = await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { kind: "thread", content_md: "after" });
    expect(res.status).toBe(200);
    expect(await detail(cookie, id)).toMatchObject({ id, authored_kind: "thread", content_md: "after" });
  });
});

describe("a published item's kind is fixed", () => {
  it("refuses the change with 409 rather than rewriting the archive", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "published, so its kind is public");
    const res = await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { kind: "thread" });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/published/);
  });

  it("stays fixed after withdrawal — the endcap and the versions are both out there", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "about to go");
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/withdraw`, {});
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { kind: "thread" })).status).toBe(409);
  });

  it("a rejected switch does not quietly save the content sent with it", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "the published text");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { kind: "thread", content_md: "sneaked in" });
    expect(await detail(cookie, id)).toMatchObject({ authored_kind: "fragment", content_md: "the published text" });
  });
});

describe("a stub thread will not silently become a fragment", () => {
  it("refuses, and names clearing the stub as the way through", async () => {
    const cookie = await login();
    const created = await apiJson(cookie, "POST", "/blyg/api/items", {
      content_md: "responding",
      kind: "thread",
      stub_of: { origin: ORIGIN, id: "7c9wk2n4h6q1x8v0z3m5rjy2ke", version: 1 },
    });
    expect(created.status).toBe(201);
    const id = created.json.id as string;

    const res = await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { kind: "fragment" });
    // A stub is a claim the author made about what they are responding to.
    // Dropping it as a side effect of a kind switch would discard that claim.
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/clear the stub/);

    // Clear it and the switch goes through.
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { stub_of: null })).status).toBe(200);
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { kind: "fragment" })).status).toBe(200);
  });

  it("a stub thread may still be switched nowhere and stay a thread", async () => {
    const cookie = await login();
    const created = await apiJson(cookie, "POST", "/blyg/api/items", {
      content_md: "responding",
      kind: "thread",
      stub_of: { origin: ORIGIN, id: "7c9wk2n4h6q1x8v0z3m5rjy2ke", version: 1 },
    });
    const id = created.json.id as string;
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { kind: "thread" })).status).toBe(200);
  });
});
