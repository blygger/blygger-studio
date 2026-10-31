// `cited` — the human half of a reference, on the wire (0.3 §16.1, decision
// #30, session 27 Fable round).
//
// Three references can carry it — `stub_of`, a remote `transclusions[]` entry,
// `forked_from` — and the rules that matter are about what it is *not*: not
// authoritative, not verification input, not content. It is frozen at the
// moment the reference was made, which is the difference between a citation and
// a lookup, and it is what a reader shows when the target has disappeared.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyEffect, createSubscription } from "../src/importer/store.ts";
import { transition } from "../src/importer/transition.ts";
import { relationTo } from "../src/mentions/receive.ts";
import { newId } from "../src/util.ts";
import { itemDocBody } from "./importer/fixtures.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const OURS = "https://example.com/blyg/";
const THEIRS = "https://friend.example/blyg/";

async function importItem(doc: Record<string, unknown>, title = "Friend's Blyg"): Promise<void> {
  const sub = await createSubscription(env.DB, { kind: "blyg", origin: THEIRS, feedUrl: `${THEIRS}feed.xml`, title });
  const tr = transition({ local: { status: "absent" }, doc });
  await applyEffect(env.DB, sub.id, doc.id as string, tr.effect, new Date().toISOString());
}

async function remoteFragment(
  opts: { id: string; content_md?: string; author?: { name: string } },
  title = "Friend's Blyg",
): Promise<string> {
  const body = JSON.parse(
    await itemDocBody({ id: opts.id, kind: "fragment", version: 2, content_md: opts.content_md ?? "Their words, quoted later.", page: `f/${opts.id}/`, origin: THEIRS }),
  );
  if (opts.author) body.author = opts.author;
  await importItem(body, title);
  return opts.id;
}

async function itemDoc(id: string): Promise<any> {
  return (await getPublic(`/blyg/items/${id}.json`)).json<any>();
}

describe("cited rides all three references", () => {
  it("a remote stub carries the source, the author as they asserted it, an excerpt and a date", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const remoteId = await remoteFragment({ id: newId(), content_md: "Stigmergy is what a protocol looks like from inside.", author: { name: "Their Author" } });

    const stub = await apiJson(cookie, "POST", "/blyg/api/items", {
      kind: "thread",
      contentMd: `![[${remoteId}]]\n\nMy answer.`,
      stubOf: { origin: THEIRS, id: remoteId, version: 2 },
    });
    const id = stub.json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);

    const doc = await itemDoc(id);
    expect(doc.stub_of.cited).toMatchObject({
      source: "Friend's Blyg",
      author: "Their Author",
      url: `${THEIRS}f/${remoteId}/`,
    });
    expect(doc.stub_of.cited.excerpt).toContain("Stigmergy");
    // REQUIRED: a citation without a date is not a citation (§16.1).
    expect(doc.stub_of.cited.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The same reference, quoted in the body, carries the same frozen half.
    expect(doc.transclusions[0].cited).toEqual(doc.stub_of.cited);

    // …and never reaches the content. The quote's *bytes* are in there by
    // design; the citation is not, because it is not what the author wrote.
    expect(doc.content_html).not.toContain(doc.stub_of.cited.retrieved);
    expect(doc.content_html).not.toContain("Friend's Blyg");
  });

  it("an own-origin transclusion carries none — a label adds nothing a fetch cannot", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const mine = await createAndPublish(cookie, "My own fragment.");
    const thread = (await apiJson(cookie, "POST", "/blyg/api/items", { kind: "thread", contentMd: `![[${mine}]]` })).json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {})).status).toBe(200);

    // Byte-identical to the 0.2 shape, which is what keeps every 0.2 document
    // a valid 0.3 document (decision #26, and now #30 does not disturb it).
    expect((await itemDoc(thread)).transclusions).toEqual([{ id: mine, version: 1 }]);
  });

  it("rides a pinned document, which is the copy that has to outlive the link", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const remoteId = await remoteFragment({ id: newId() });
    const stub = await apiJson(cookie, "POST", "/blyg/api/items", {
      kind: "thread",
      contentMd: `![[${remoteId}]]`,
      stubOf: { origin: THEIRS, id: remoteId, version: 2 },
    });
    const id = stub.json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
    expect((await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/${1}/pin`)).status).toBe(200);

    const pinned = await (await getPublic(`/blyg/items/${id}/v1.json`)).json<any>();
    expect(pinned.stub_of.cited.source).toBe("Friend's Blyg");
    expect(pinned.transclusions[0].cited.source).toBe("Friend's Blyg");
  });

  it("rides lineage, and keeps riding it after the fork is withdrawn", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS, siteTitle: "My Blyg" });
    const parent = await createAndPublish(cookie, "The parent item.");
    await apiJson(cookie, "PUT", `/blyg/api/items/${parent}/versions/${1}/pin`);
    const forked = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: parent, version: 1 } });
    const id = forked.json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});

    // The URL a lineage citation names is the **pinned version**, not the live
    // item — the only URL somebody promised to keep serving (§2.4, #8).
    expect((await itemDoc(id)).forked_from.cited).toMatchObject({ source: "My Blyg", url: `${OURS}f/${parent}/v1/` });

    // Lineage survives withdrawal (§2.4) and so does its citation: where the
    // work came from is not the work.
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/withdraw`, {});
    const endcap = await itemDoc(id);
    expect(endcap.kind).toBe("withdrawn");
    expect(endcap.forked_from.cited.source).toBe("My Blyg");
  });
});

describe("cited is never authority", () => {
  it("mention verification reads the bare reference and ignores the citation entirely", () => {
    const targetId = newId();
    // A true reference with a citation full of lies still verifies: the
    // relation is decided by origin + id, which is all §15.4 ever reads.
    expect(
      relationTo(
        { stub_of: { origin: OURS, id: targetId, cited: { source: "Somebody Else", url: "https://evil.example/", retrieved: "1999-01-01T00:00:00Z" } } },
        OURS,
        targetId,
      ),
    ).toBe("stub");
    // And a citation that names us cannot manufacture a reference that isn't
    // there — which is the attack a verified-looking label would invite.
    expect(
      relationTo(
        { stub_of: { origin: "https://elsewhere.example/", id: newId(), cited: { source: "us", url: `${OURS}f/${targetId}/`, retrieved: "2026-09-28T00:00:00Z" } } },
        OURS,
        targetId,
      ),
    ).toBeNull();
  });

  it("an imported document's own citations are retained verbatim, not recomposed", async () => {
    const remoteId = newId();
    const theirTarget = newId();
    const theirCite = { source: "A Third Blyg", author: "Someone", excerpt: "what they quoted", url: `https://third.example/blyg/f/${theirTarget}/`, retrieved: "2026-09-20T12:00:00Z" };
    const doc = JSON.parse(await itemDocBody({ id: remoteId, kind: "thread", version: 1, content_md: "their thread", origin: THEIRS }));
    doc.transclusions = [{ id: theirTarget, version: 3, origin: "https://third.example/blyg/", cited: theirCite }];
    await importItem(doc);

    const row = await env.DB.prepare("SELECT transclusions_json AS t FROM imported_items WHERE remote_id = ?").bind(remoteId).first<{ t: string }>();
    // Kept as they asserted it (invariant 6 pass-through). Nothing renders it
    // yet — the second-degree view does not exist — but a citation we threw
    // away on import could never be recovered, and one we recomposed would be
    // our guess wearing their byline.
    expect(JSON.parse(row!.t)[0].cited).toEqual(theirCite);
  });

  it("a published byline stops depending on a live join — the stale-byline fix", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: OURS });
    const remoteId = await remoteFragment({ id: newId() }, "The Name At Publish Time");
    const thread = (await apiJson(cookie, "POST", "/blyg/api/items", { kind: "thread", contentMd: `![[${remoteId}]]` })).json.id as string;
    await apiJson(cookie, "POST", `/blyg/api/items/${thread}/publish`, {});

    const before = await (await getPublic(`/blyg/t/${thread}/`)).text();
    expect(before).toContain("The Name At Publish Time");

    // Rename the subscription — the live join the page used to use.
    await env.DB.prepare("UPDATE subscriptions SET title = ? WHERE origin = ?").bind("Renamed Later", THEIRS).run();
    const after = await (await getPublic(`/blyg/t/${thread}/`)).text();
    expect(after).toContain("The Name At Publish Time");
    expect(after).not.toContain("Renamed Later");
  });
});
