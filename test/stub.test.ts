// v0.3 task 3 acceptance (plan §2.2, decision #27): a stub is a thread with
// `stub_of` — both shapes, the version-agreement rule, the citation on pins,
// and the endcap that omits it (which is what makes a withdrawn stub stop
// verifying on the far side).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyEffect, createSubscription } from "../src/importer/store.ts";
import { transition } from "../src/importer/transition.ts";
import { itemDocBody } from "./importer/fixtures.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";
import { newId } from "../src/util.ts";
import { applyVersionAgreement } from "../src/stub.ts";

const OURS = "https://example.com/blyg/";
const THEIRS = "https://friend.example/blyg/";

async function importItem(id: string): Promise<void> {
  const sub = await createSubscription(env.DB, { kind: "blyg", origin: THEIRS, feedUrl: `${THEIRS}feed.xml`, title: "Friend" });
  const doc = await itemDocBody({ id, kind: "fragment", version: 4, content_md: "their post" });
  const tr = transition({ local: { status: "absent" }, doc: JSON.parse(doc) });
  await applyEffect(env.DB, sub.id, id, tr.effect, new Date().toISOString());
}

async function createStub(cookie: string, contentMd: string, stubOf: unknown): Promise<string> {
  const created = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: contentMd, kind: "thread", stubOf: stubOf });
  expect(created.status).toBe(201);
  return created.json.id as string;
}

async function itemJson(id: string): Promise<any> {
  return (await getPublic(`/blyg/items/${id}.json`)).json<any>();
}

describe("stub_of (§2.2)", () => {
  it("publishes a blyg-target stub, quoting it, with the citation agreeing on version", async () => {
    const cookie = await login();
    const remoteId = newId();
    await importItem(remoteId);
    // The author saw v4 when they hit stub; the import is at v4 too.
    const stubId = await createStub(cookie, `Worth reading:\n\n![[${remoteId}]]\n\nMy take.`, {
      origin: THEIRS,
      id: remoteId,
      version: 4,
    });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {})).status).toBe(200);

    const doc = await itemJson(stubId);
    expect(doc.kind).toBe("thread");
    expect(doc.stub_of).toMatchObject({ origin: THEIRS, id: remoteId, version: 4 });
    expect(doc.transclusions).toMatchObject([{ id: remoteId, version: 4, origin: THEIRS }]);
  });

  it("the version-agreement rule moves the citation to the version actually baked", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "first cut");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${target}`, { contentMd: "second cut" });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${target}/publish`, {})).status).toBe(200);

    // Citation created against v1; the body bakes whatever is current (v2).
    const stubId = await createStub(cookie, `![[${target}]]`, { origin: OURS, id: target, version: 1 });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {})).status).toBe(200);

    const doc = await itemJson(stubId);
    expect(doc.stub_of).toMatchObject({ origin: OURS, id: target, version: 2 });
    expect(doc.transclusions).toEqual([{ id: target, version: 2 }]);
  });

  it("a body that doesn't quote the target keeps the version the author saw", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "v1 text");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${target}`, { contentMd: "v2 text" });
    await apiJson(cookie, "POST", `/blyg/api/items/${target}/publish`, {});

    const stubId = await createStub(cookie, "A response by link alone.", { origin: OURS, id: target, version: 1 });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {})).status).toBe(200);

    const doc = await itemJson(stubId);
    expect(doc.stub_of).toMatchObject({ origin: OURS, id: target, version: 1 });
    expect(doc.transclusions).toEqual([]);
  });

  it("carries a plain-web {url} target verbatim", async () => {
    const cookie = await login();
    const url = "https://simonwillison.net/2026/Sep/10/some-post/";
    const stubId = await createStub(cookie, "Responding to a post out on the open web.", { url });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {})).status).toBe(200);
    expect((await itemJson(stubId)).stub_of).toMatchObject({ url });
  });

  it("a pinned version carries its own citation; the withdrawal endcap carries none", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "the target");
    const stubId = await createStub(cookie, `![[${target}]]`, { origin: OURS, id: target, version: 1 });
    await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {});
    expect((await apiJson(cookie, "PUT", `/blyg/api/items/${stubId}/versions/${1}/pin`)).status).toBe(200);

    const pinned = await (await getPublic(`/blyg/items/${stubId}/v1.json`)).json<any>();
    expect(pinned.stub_of).toMatchObject({ origin: OURS, id: target, version: 1 });

    expect((await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/withdraw`, {})).status).toBe(200);
    const endcap = await itemJson(stubId);
    expect(endcap.kind).toBe("withdrawn");
    expect(endcap.stub_of).toBeUndefined();
    // The pin is untouched — it is the citation that survives withdrawal.
    expect((await (await getPublic(`/blyg/items/${stubId}/v1.json`)).json<any>()).stub_of).toMatchObject({
      origin: OURS,
      id: target,
      version: 1,
    });

    // Republishing restores it: the working copy kept the citation.
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {})).status).toBe(200);
    expect((await itemJson(stubId)).stub_of).toMatchObject({ origin: OURS, id: target, version: 1 });
  });

  it("clearing the citation leaves a thread that merely quotes", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "the target");
    const stubId = await createStub(cookie, `![[${target}]]`, { origin: OURS, id: target, version: 1 });
    expect((await apiJson(cookie, "PATCH", `/blyg/api/items/${stubId}`, { stubOf: null })).status).toBe(200);
    await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {});

    const doc = await itemJson(stubId);
    expect(doc.stub_of).toBeUndefined();
    expect(doc.transclusions).toEqual([{ id: target, version: 1 }]);
  });

  it("rejects a stub on a fragment, and every malformed citation", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "the target");
    const onFragment = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "x", stubOf: { url: "https://a.example/" } });
    expect(onFragment.status).toBe(400);

    const bad: unknown[] = [
      { origin: THEIRS, id: target }, // no version
      { origin: "not a url", id: target, version: 1 },
      { origin: THEIRS, id: "has a space", version: 1 },
      { origin: THEIRS, id: target, version: 0 },
      { url: "ftp://example.com/x" },
      { url: "https://a.example/", origin: THEIRS, id: target, version: 1 }, // both shapes
      "a string",
    ];
    for (const stub of bad) {
      const res = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "x", kind: "thread", stubOf: stub });
      expect(res.status, JSON.stringify(stub)).toBe(400);
    }
  });

  it("normalizes a citation origin to one spelling, so comparisons can be string equality", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "the target");
    const stubId = await createStub(cookie, "no quote", { origin: "https://example.com/blyg", id: target, version: 1 });
    await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {});
    expect((await itemJson(stubId)).stub_of.origin).toBe(OURS);
  });
});

describe("the citation a stub carries (session 23 ruling: conventional citation norms)", () => {
  it("prints source, excerpt, id, version, URL and retrieval date on the permalink", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const remoteId = newId();
    await importItem(remoteId);
    const stubId = await createStub(cookie, `![[${remoteId}]]\n\nMy answer.`, { origin: THEIRS, id: remoteId, version: 4 });
    await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {});

    const html = await (await getPublic(`/blyg/t/${stubId}/`)).text();
    expect(html).toContain("In response to");
    expect(html).toContain("<cite>Friend</cite>");
    expect(html).toContain("their post");
    expect(html).toContain(`item <code>${remoteId}</code>, v4`);
    // The URL is its own anchor text, so a dead link still reads as a citation.
    expect(html).toContain(`<a href="${THEIRS}f/${remoteId}/">${THEIRS}f/${remoteId}/</a>`);
    expect(html).toContain("retrieved");
  });

  it("keeps reading correctly after the subscription that named the source is gone", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const remoteId = newId();
    await importItem(remoteId);
    const stubId = await createStub(cookie, `![[${remoteId}]]\n\nMy answer.`, { origin: THEIRS, id: remoteId, version: 4 });
    await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {});

    // The whole subscription disappears — rename, unsubscribe, origin moves.
    await env.DB.prepare("DELETE FROM imported_items").run();
    await env.DB.prepare("DELETE FROM subscriptions WHERE origin = ?").bind(THEIRS).run();

    const html = await (await getPublic(`/blyg/t/${stubId}/`)).text();
    expect(html).toContain("<cite>Friend</cite>");
    expect(html).toContain("their post");
    expect(html).toContain(`${THEIRS}f/${remoteId}/`);
  });

  it("carries the citation onto a pin, and the pin keeps the version it froze", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const remoteId = newId();
    await importItem(remoteId);
    const stubId = await createStub(cookie, "Answering by link alone.", { origin: THEIRS, id: remoteId, version: 4 });
    await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {});
    expect((await apiJson(cookie, "PUT", `/blyg/api/items/${stubId}/versions/${1}/pin`)).status).toBe(200);

    const pinned = await (await getPublic(`/blyg/t/${stubId}/v1/`)).text();
    expect(pinned).toContain("In response to");
    expect(pinned).toContain("<cite>Friend</cite>");
  });

  it("cites a plain-web target by host, and never claims more than it knows", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const url = "https://simonwillison.net/2026/Sep/10/some-post/";
    const stubId = await createStub(cookie, "Responding to the open web.", { url });
    await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {});

    const html = await (await getPublic(`/blyg/t/${stubId}/`)).text();
    expect(html).toContain("<cite>simonwillison.net</cite>");
    expect(html).toContain(`<a href="${url}">${url}</a>`);
    // No blyg item id exists for a plain-web target, so none is invented.
    expect(html).not.toContain("item <code>");
  });

  it("shows a compact form on the feed card and in the RSS description", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const remoteId = newId();
    await importItem(remoteId);
    const stubId = await createStub(cookie, `![[${remoteId}]]`, { origin: THEIRS, id: remoteId, version: 4 });
    await apiJson(cookie, "POST", `/blyg/api/items/${stubId}/publish`, {});

    const feedPage = await (await getPublic("/blyg/")).text();
    expect(feedPage).toContain("stub-cite compact");
    expect(feedPage).toContain("<cite>Friend</cite>");

    const rss = await (await getPublic("/blyg/feed.xml")).text();
    expect(rss).toContain("In response to");
    expect(rss).toContain(`${THEIRS}f/${remoteId}/`);
  });

  it("a thread that is not a stub carries no citation at all", async () => {
    const cookie = await login();
    const plain = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "just a thread", kind: "thread" })).json.id;
    await apiJson(cookie, "POST", `/blyg/api/items/${plain}/publish`, {});
    expect(await (await getPublic(`/blyg/t/${plain}/`)).text()).not.toContain("In response to");
  });
});

describe("version agreement matches the stub's target by origin and id (studio#28)", () => {
  const own = "https://me.example/blyg/";
  const remote = { origin: "https://them.example/", id: "x1", version: 3 };
  it("takes the baked version when the body quotes the remote target", () => {
    expect(applyVersionAgreement(remote, [{ id: "x1", version: 5, origin: "https://them.example/" }], own)).toEqual({ ...remote, version: 5 });
  });
  it("ignores a local item that shares the remote target's id", () => {
    expect(applyVersionAgreement(remote, [{ id: "x1", version: 9 }], own)).toEqual(remote);
  });
  it("treats an origin-less quote as our own, so a self-stub still agrees", () => {
    const self = { origin: "https://me.example/blyg", id: "x1", version: 1 };
    expect(applyVersionAgreement(self, [{ id: "x1", version: 2 }], own)).toEqual({ ...self, version: 2 });
  });
  it("ignores the same id quoted from a third origin", () => {
    expect(applyVersionAgreement(remote, [{ id: "x1", version: 7, origin: "https://other.example/" }], own)).toEqual(remote);
  });
});

// Stubbing your own item from the reading feed (session 50): addressed `~own`,
// as hoppers address own items; same-origin, so no mention goes out (§15.2).
describe("stub ↗ on an own item", () => {
  const respond = (cookie: string, id: string, selection?: string) =>
    apiJson(cookie, "POST", "/blyg/api/items", { mode: "response", source: { subscriptionId: "~own", remoteId: id }, ...(selection ? { selection } : {}) });

  it("drafts a thread quoting the live version, with a same-origin stub_of, and publishes", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "first cut");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${target}`, { contentMd: "second cut, the one to answer" });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${target}/publish`, {})).status).toBe(200);
    const created = await respond(cookie, target);
    expect(created.status).toBe(201);
    expect(created.json.kind).toBe("thread");
    expect(created.json.contentMd).toBe(`![[${target}]]\n\n`);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${created.json.id}/publish`, {})).status).toBe(200);
    const doc = await itemJson(created.json.id);
    expect(doc.stub_of).toMatchObject({ origin: OURS, id: target, version: 2 });
    expect(doc.transclusions).toMatchObject([{ id: target, version: 2 }]);
    expect(doc.transclusions[0].origin).toBeUndefined();
  });

  it("quotes a selected passage only if the published version has it", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "One sentence here. Another sentence there.");
    const ok = await respond(cookie, target, "Another sentence there.");
    expect(ok.status).toBe(201);
    expect(ok.json.contentMd).toBe(`![[${target}]]\n> Another sentence there.\n\n`);
    expect((await respond(cookie, target, "not in the post")).status).toBe(400);
  });

  it("cites a withdrawn item without quoting it, and refuses a draft that was never published", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "soon gone");
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${target}/withdraw`, {})).status).toBe(200);
    const created = await respond(cookie, target);
    expect(created.status).toBe(201);
    expect(created.json.contentMd).toBe("");
    const draft = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "never published" });
    expect((await respond(cookie, draft.json.id)).status).toBe(404);
  });
});
