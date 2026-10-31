// `[[id]]` plain internal links — 0.3 §16.2, decision #32 (session 27, Fable).
//
// The ruling in one line: a link resolves like a transclusion directive and is
// **silent on the wire** — no `transclusions[]` entry, no mention, no wire
// class. The negatives are the feature here, exactly as they are for inbound
// mentions: this is the one citation form in the medium that does not notify,
// and §16.2 calls that affordance necessary rather than accidental.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyEffect, createSubscription } from "../src/importer/store.ts";
import { transition } from "../src/importer/transition.ts";
import { listOutbound } from "../src/mentions/store.ts";
import { newId } from "../src/util.ts";
import { itemDocBody } from "./importer/fixtures.ts";
import { apiJson, BASE, createAndPublish, getPublic, login } from "./helpers.ts";

const OURS = "https://example.com/blyg/";
const THEIRS = "https://friend.example/blyg/";

async function importFrom(origin: string, doc: Parameters<typeof itemDocBody>[0], title = "Friend"): Promise<void> {
  const sub = await createSubscription(env.DB, { kind: "blyg", origin, feedUrl: `${origin}feed.xml`, title });
  const tr = transition({ local: { status: "absent" }, doc: JSON.parse(await itemDocBody(doc)) });
  await applyEffect(env.DB, sub.id, doc.id, tr.effect, new Date().toISOString());
}

async function itemDoc(id: string): Promise<any> {
  return (await getPublic(`/blyg/items/${id}.json`)).json<any>();
}

describe("[[id]] links a local item, absolutely and silently", () => {
  it("renders an anchor to the target's page and records nothing on the wire", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const target = await createAndPublish(cookie, "The argument I want to point back at later.");

    const created = await apiJson(cookie, "POST", "/blyg/api/items", {
      contentMd: `As I said in [[${target}]], the order matters.`,
    });
    const id = created.json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);

    const doc = await itemDoc(id);
    // Absolute, because content_html travels: a subscriber rendering this
    // would resolve a relative href against their own origin.
    expect(doc.content_html).toContain(`<a href="${OURS}f/${target}/">`);
    expect(doc.content_html).toContain("The argument I want to point back at later.");
    // The anchor is inside the sentence, not a block of its own.
    expect(doc.content_html).toMatch(/As I said in <a href[^>]*>[^<]*<\/a>, the order matters\./);
    // Silent on the wire: no reference, no relation, no class.
    expect(doc.transclusions ?? []).toEqual([]);
    expect(doc.content_html).not.toContain("blyg-transclusion");
    expect(doc.content_html).not.toContain("[[");
  });

  it("links a thread as readily as a fragment, and uses the right permalink shape", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const thread = (await apiJson(cookie, "POST", "/blyg/api/items", { kind: "thread", contentMd: "A thread of mine." })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    const id = await createAndPublish(cookie, `see [[${thread}]]`);
    expect((await itemDoc(id)).content_html).toContain(`<a href="${OURS}t/${thread}/">`);
  });

  it("does not notify the target — a link asserts nothing on its behalf", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const remoteId = newId();
    await importFrom(THEIRS, { id: remoteId, kind: "fragment", version: 3, content_md: "Their post about stigmergy.", page: `f/${remoteId}/` });

    const created = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: `worth reading: [[${remoteId}]]` });
    const id = created.json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);

    const doc = await itemDoc(id);
    // Remote: origin + the target's own declared page (§16.2).
    expect(doc.content_html).toContain(`<a href="${THEIRS}f/${remoteId}/">`);
    expect(doc.transclusions ?? []).toEqual([]);
    // The whole point of the ruling: this is the citation form that stays quiet.
    expect((await listOutbound(env.DB)).filter((r) => r.item_id === id)).toHaveLength(0);
  });
});

describe("[[id]] and ![[id]] are one `!` and two different acts apart", () => {
  it("a directive line still transcludes, and produces no stray link", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const target = await createAndPublish(cookie, "Quoted in full.");
    const thread = (await apiJson(cookie, "POST", "/blyg/api/items", {
      kind: "thread",
      contentMd: `Before.\n\n![[${target}]]\n\nAnd separately I link [[${target}]] inline.`,
    })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    const doc = await itemDoc(thread);
    // One baked snapshot from the directive…
    expect(doc.transclusions).toEqual([{ id: target, version: 1 }]);
    expect((doc.content_html.match(/<blockquote class="blyg-transclusion"/g) ?? []).length).toBe(1);
    // …and one anchor from the link, which added no second reference.
    expect((doc.content_html.match(/<a href="[^"]*f\//g) ?? []).length).toBe(1);
  });

  it("fails the publish when a link does not resolve, naming what was written", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const missing = newId();
    const draft = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: `a link to [[${missing}]]` })).json.id as string;
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${draft}/publish`, {});
    expect(res.status).toBe(400);
    expect(res.json.message).toMatch(/do not resolve/);
    expect(res.json.details.errors[0].directive).toBe(`[[${missing}]]`);
    expect(res.json.details.errors[0].reason).toBe("unknown item");

    // A draft target is unresolvable for the same reason a directive's is.
    const unpublished = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "still a draft" })).json.id as string;
    const draft2 = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: `[[${unpublished}]]` })).json.id as string;
    const res2 = await apiJson(cookie, "POST", `/blyg/api/items/${draft2}/publish`, {});
    expect(res2.status).toBe(400);
    expect(res2.json.details.errors[0].reason).toBe("item is a draft, not published");
  });

  it("shows an unresolvable link in the composer preview instead of failing it", async () => {
    const cookie = await login();
    const missing = newId();
    const res = await SELF.fetch(`${BASE}/blyg/api/preview`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ contentMd: `a link to [[${missing}]]` }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ html: string; linkErrors: { reason: string }[] }>();
    expect(body.html).toContain("⚠");
    expect(body.linkErrors[0].reason).toBe("unknown item");
  });
});

describe("[[id]] link text (roadmap row 8)", () => {
  it("takes the target's opening heading as the link text", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const created = await apiJson(cookie, "POST", "/blyg/api/items", { kind: "thread", contentMd: "# How protocols eat time\n\nThe body of the argument." });
    const target = created.json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${target}/publish`, {})).status).toBe(200);
    const linker = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: `See [[${target}]] for more.` })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${linker}/publish`, {})).status).toBe(200);
    const html = (await itemDoc(linker)).content_html as string;
    expect(html).toContain(`<a href="${OURS}t/${target}/">How protocols eat time</a>`);
  });

  it("keeps the quoted excerpt when the target has no heading", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const target = await createAndPublish(cookie, "A plain fragment with no heading.");
    const linker = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: `See [[${target}]].` })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${linker}/publish`, {})).status).toBe(200);
    expect((await itemDoc(linker)).content_html).toContain("“A plain fragment with no heading.”");
  });
});

describe("author_url setting (roadmap row 6)", () => {
  it("defaults to the blyg's own address, can be set, and rejects non-http(s)", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS, authorUrl: "" });
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { authorUrl: "javascript:alert(1)" })).status).toBe(400);
    const id = await createAndPublish(cookie, "A post.");
    expect((await itemDoc(id)).author.url).toBe(OURS);
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { authorUrl: "https://author.example/me" })).status).toBe(200);
    const id2 = await createAndPublish(cookie, "Another post.");
    expect((await itemDoc(id2)).author.url).toBe("https://author.example/me");
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { authorUrl: "" });
  });
});
