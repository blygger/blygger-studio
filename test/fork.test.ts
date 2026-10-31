// v0.3 Phase B task 11 acceptance (plan §2.4, §2.3.3, §2.3.5; shape reserved
// since 0.1 §5.6): `forked_from` end to end — the pinned-only rule at fork
// time, at publish time, and on the receiving side, where the target is the
// only party who can say whether the version a stranger claims descent from
// is actually pinned.
//
// The remote half is driven at the module boundary with a fixture FetchLike,
// the same split the importer uses: route-level tests go over the local path
// (where the database is the authority and no fetch happens at all), and the
// network logic is tested where it can be injected.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkForkTarget, pinnedVersionUrl, resolveForkSource } from "../src/fork.ts";
import type { FetchLike } from "../src/importer/http.ts";
import { createSubscription } from "../src/importer/store.ts";
import { forkedVersion, relationTo, upsertAndVerify } from "./fork-helpers.ts";
import { createFork } from "../src/model.ts";
import { listOutbound } from "../src/mentions/store.ts";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";
import { newId } from "../src/util.ts";

const OURS = "https://example.com/blyg/";
const THEIRS = "https://friend.example/blyg/";

function net(map: Record<string, { status?: number; body?: string }>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const entry = map[url];
    const status = entry?.status ?? (entry ? 200 : 404);
    return { ok: status >= 200 && status < 300, status, url, headers: new Headers(), text: async () => entry?.body ?? "" };
  };
  return { fetch, calls };
}

/** What a conformant blyg serves at items/{id}/v{n}.json (§2.8). */
function pinnedDoc(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    blyg: "0.3",
    id: "remote-item",
    kind: "fragment",
    version: 2,
    at: "2026-09-01T10:00:00Z",
    note: null,
    pinned: true,
    origin: THEIRS,
    author: { name: "Friend", url: THEIRS },
    content_md: "their pinned words",
    content_html: "<p>their pinned words</p>",
    content_hash: "sha256:x",
    ...over,
  });
}

it.each(['fragment', 'thread'])('can fork a remote empty pinned %s publication', async kind => {
  const source = { origin: THEIRS, id: 'remote-item', version: 2 };
  const url = pinnedVersionUrl(source);
  const { fetch } = net({ [url]: { body: pinnedDoc({ kind, content_md: '', content_html: '' }) } });
  expect(await resolveForkSource(env.DB, source, OURS, 'Mine', fetch, 'now')).toMatchObject({ ok: true, source: { kind, contentMd: '' } });
});

it.each([
  { name: 'missing markdown', content: { content_md: undefined } },
  { name: 'null markdown', content: { content_md: null } },
  { name: 'numeric markdown', content: { content_md: 42 } },
  { name: 'withdrawal endcap', content: { content_md: '', kind: 'withdrawn' } },
])('does not fork $name while accepting empty publications', async ({ content }) => {
  const source = { origin: THEIRS, id: 'remote-item', version: 2 };
  const { fetch } = net({ [pinnedVersionUrl(source)]: { body: pinnedDoc(content) } });
  expect(await resolveForkSource(env.DB, source, OURS, 'Mine', fetch, 'now')).toMatchObject({ ok: false });
});

async function itemJson(id: string): Promise<any> {
  return (await getPublic(`/blyg/items/${id}.json`)).json<any>();
}

/** Publish, pin v1, and hand back the item id — the only state a fork can start from. */
async function publishAndPin(cookie: string, md: string): Promise<string> {
  const id = await createAndPublish(cookie, md);
  expect((await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/${1}/pin`)).status).toBe(200);
  return id;
}

describe("forking a pinned version of our own (§2.4)", () => {
  it("copies the pinned text into a new draft and records the lineage permanently", async () => {
    const cookie = await login();
    const parent = await publishAndPin(cookie, "the original text");

    const forked = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: parent, version: 1 } });
    expect(forked.status).toBe(201);
    const id = forked.json.id as string;

    const draft = await apiJson(cookie, "GET", `/blyg/api/items/${id}`);
    expect(draft.status).toBe(200);
    expect(draft.json.contentMd).toBe("the original text");

    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    const doc = await itemJson(id);
    expect(doc.forked_from).toMatchObject({ origin: OURS, id: parent, version: 1 });
  });

  it("refuses a version that is not pinned — the whole basis of the claim", async () => {
    const cookie = await login();
    const parent = await createAndPublish(cookie, "never pinned");
    const res = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: parent, version: 1 } });
    expect(res.status).toBe(400);
    expect(res.json.message).toContain("not pinned");
  });

  it("refuses a malformed reference rather than coercing one", async () => {
    const cookie = await login();
    // `origin` is REQUIRED even for our own item (#27: a citation is absolute).
    expect((await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { id: "x", version: 1 } })).status).toBe(400);
    expect((await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: "x", version: 0 } })).status).toBe(400);
  });

  it("forks a thread as a thread, flattening its quotes from the pinned document (#57)", async () => {
    const cookie = await login();
    const quoted = await createAndPublish(cookie, "a fragment to quote");
    const created = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: `intro\n\n![[${quoted}]]`, kind: "thread" });
    const threadId = created.json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${threadId}/publish`, {})).status).toBe(200);
    expect((await apiJson(cookie, "PUT", `/blyg/api/items/${threadId}/versions/${1}/pin`)).status).toBe(200);

    const forked = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: threadId, version: 1 } });
    expect(forked.status).toBe(201);
    expect(forked.json.kind).toBe("thread");
    // Decision #57 overrules the session-24 call this test used to assert: the
    // directive re-resolved in the forker's context, so the fork descended from
    // a composition, not from the pinned bytes. The quote is now flattened.
    const draft = await apiJson(cookie, "GET", `/blyg/api/items/${forked.json.id}`);
    expect(draft.json.contentMd).toBe(`intro\n\n> a fragment to quote\n>\n> — quoted from [example.com · v1](${OURS}f/${quoted}/)`);
  });
});

describe("lineage on the wire and on the page", () => {
  it("rides the pinned version document too, and cannot drift from the live item", async () => {
    const cookie = await login();
    const parent = await publishAndPin(cookie, "ancestor");
    const forked = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: parent, version: 1 } });
    const id = forked.json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    expect((await apiJson(cookie, "PUT", `/blyg/api/items/${id}/versions/${1}/pin`)).status).toBe(200);

    const pinned = await (await getPublic(`/blyg/items/${id}/v1.json`)).json<any>();
    expect(pinned.forked_from).toMatchObject({ origin: OURS, id: parent, version: 1 });
  });

  it("survives withdrawal — the endcap empties the work, not where the work came from", async () => {
    const cookie = await login();
    const parent = await publishAndPin(cookie, "ancestor");
    const forked = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: parent, version: 1 } });
    const id = forked.json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/withdraw`, {})).status).toBe(200);

    const doc = await itemJson(id);
    expect(doc.kind).toBe("withdrawn");
    expect(doc.content_md).toBe("");
    expect(doc.forked_from).toMatchObject({ origin: OURS, id: parent, version: 1 });
  });

  it("states the lineage on the item's own page, citing the pinned version page", async () => {
    const cookie = await login();
    const parent = await publishAndPin(cookie, "ancestor text");
    const forked = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: parent, version: 1 } });
    const id = forked.json.id as string;
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);

    const html = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(html).toContain("Forked from");
    expect(html).toContain(`${OURS}f/${parent}/v1/`);
    // The excerpt was frozen at fork time, from the pinned bytes.
    expect(html).toContain("ancestor text");
  });
});

describe("the publish-time check (§2.4)", () => {
  it("blocks publishing when a local lineage target turns out not to be pinned", async () => {
    const cookie = await login();
    const parent = await publishAndPin(cookie, "ancestor");
    const forked = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: parent, version: 1 } });
    const id = forked.json.id as string;
    // Pins are irrevocable through every supported path, so the only way to
    // reach this state is to corrupt it directly — which is exactly the state
    // the check exists to catch.
    await env.DB.prepare("UPDATE versions SET pinned = 0 WHERE item_id = ? AND version = 1").bind(parent).run();

    const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
    expect(res.status).toBe(400);
    expect(res.json.message).toContain("not pinned");
  });

  it("does not let an unreachable origin veto the author's publish", async () => {
    const cookie = await login();
    // A fork of a remote pin, created directly: the route's own fetch is the
    // production one, and friend.example does not answer in the test runtime —
    // which is precisely the inconclusive case.
    const item = await createFork(
      env.DB,
      "forked text",
      "fragment",
      { origin: THEIRS, id: "remote-item", version: 2 },
      { source: "Friend", url: `${THEIRS}items/remote-item/v2.json`, retrieved: new Date().toISOString() },
    );
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${item.id}/publish`, {});
    expect(res.status).toBe(200);
    expect(res.json.warning).toContain("not re-checked");
    expect((await itemJson(item.id)).forked_from).toMatchObject({ origin: THEIRS, id: "remote-item", version: 2 });
  });

  it("enqueues a mention to the remote origin, like any other remote reference (§2.3.3)", async () => {
    const cookie = await login();
    await createSubscription(env.DB, { kind: "blyg", origin: THEIRS, feedUrl: `${THEIRS}feed.xml`, title: "Friend" });
    const item = await createFork(
      env.DB,
      "forked text",
      "fragment",
      { origin: THEIRS, id: "remote-item", version: 2 },
      { source: "Friend", url: `${THEIRS}items/remote-item/v2.json`, retrieved: new Date().toISOString() },
    );
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${item.id}/publish`, {})).status).toBe(200);
    // The mention targets the live item, not the pinned file: a receiver
    // verifies against the item a `target` names. Nothing imported declares
    // a `page`, so that is the item document, never a guessed `f/{id}/`
    // (§15.2, decision #85).
    const targets = (await listOutbound(env.DB)).map((r) => r.target);
    expect(targets).toContain(`${THEIRS}items/remote-item.json`);
    expect(targets).not.toContain(`${THEIRS}f/remote-item/`);
  });
});

describe("resolving a remote pinned version (fork.ts, fixture network)", () => {
  const ref = { origin: THEIRS, id: "remote-item", version: 2 };
  const url = `${THEIRS}items/remote-item/v2.json`;

  it("reads content and freezes the citation from the pinned document itself", async () => {
    // A subscribed origin, on its own host: tests in a file share one D1, and
    // the whole point of this assertion is which row supplies the name.
    const known = "https://subscribed.example/blyg/";
    const knownUrl = `${known}items/remote-item/v2.json`;
    await createSubscription(env.DB, { kind: "blyg", origin: known, feedUrl: `${known}feed.xml`, title: "Friend's blyg" });
    const { fetch, calls } = net({ [knownUrl]: { body: pinnedDoc({ origin: known }) } });
    const res = await resolveForkSource(env.DB, { ...ref, origin: known }, OURS, "Mine", fetch, "2026-09-22T00:00:00Z");
    // The pinned page is probed and, absent here, the citation keeps the JSON.
    expect(calls).toEqual([knownUrl, `${known}f/remote-item/v2/`]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source.kind).toBe("fragment");
    expect(res.source.contentMd).toBe("their pinned words");
    expect(res.source.cite).toMatchObject({ source: "Friend's blyg", author: "Friend", url: knownUrl, retrieved: "2026-09-22T00:00:00Z" });
    expect(res.source.cite.excerpt).toContain("their pinned words");
  });

  it("cites the pinned page when the origin serves one, at its declared page (studio#30)", async () => {
    const origin = "https://pages.example/blyg/";
    const json = `${origin}items/remote-item/v2.json`;
    const page = `${origin}notes/my-slug/v2/`;
    const { fetch } = net({ [json]: { body: pinnedDoc({ origin, page: "notes/my-slug/" }) }, [page]: { body: "<html></html>" } });
    const res = await resolveForkSource(env.DB, { ...ref, origin }, OURS, "Mine", fetch, "now");
    expect(res.ok && res.source.cite.url).toBe(page);
  });

  it("keeps the JSON citation when a declared page points off the origin", async () => {
    const origin = "https://offsite.example/blyg/";
    const json = `${origin}items/remote-item/v2.json`;
    const { fetch, calls } = net({ [json]: { body: pinnedDoc({ origin, page: "https://elsewhere.example/x/" }) } });
    const res = await resolveForkSource(env.DB, { ...ref, origin }, OURS, "Mine", fetch, "now");
    expect(res.ok && res.source.cite.url).toBe(json);
    expect(calls).toEqual([json]);
  });

  it("names the host when we hold no subscription — forking is not limited to what we follow", async () => {
    const stranger = "https://stranger.example/blyg/";
    const strangerUrl = `${stranger}items/remote-item/v2.json`;
    const { fetch } = net({ [strangerUrl]: { body: pinnedDoc({ origin: stranger }) } });
    const res = await resolveForkSource(env.DB, { ...ref, origin: stranger }, OURS, "Mine", fetch, "2026-09-22T00:00:00Z");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.source.cite.source).toBe("stranger.example");
  });

  it("reads a 404 as 'not pinned', because that is what it means", async () => {
    const { fetch } = net({});
    const res = await resolveForkSource(env.DB, ref, OURS, "Mine", fetch, "now");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("not pinned");
  });

  it("refuses a document that does not declare itself pinned, or names something else", async () => {
    const notPinned = net({ [url]: { body: pinnedDoc({ pinned: false }) } });
    expect((await resolveForkSource(env.DB, ref, OURS, "Mine", notPinned.fetch, "now")).ok).toBe(false);
    const wrongVersion = net({ [url]: { body: pinnedDoc({ version: 7 }) } });
    expect((await resolveForkSource(env.DB, ref, OURS, "Mine", wrongVersion.fetch, "now")).ok).toBe(false);
    const notBlyg = net({ [url]: { body: JSON.stringify({ hello: "world" }) } });
    expect((await resolveForkSource(env.DB, ref, OURS, "Mine", notBlyg.fetch, "now")).ok).toBe(false);
  });

  it("separates evidence from silence at publish time", async () => {
    // 404 is evidence the promise is not kept → the claim is false.
    expect((await checkForkTarget(env.DB, ref, OURS, net({}).fetch)).ok).toBe(false);
    // 5xx and a dead socket are evidence of nothing → the author still publishes.
    const down = await checkForkTarget(env.DB, ref, OURS, net({ [url]: { status: 503 } }).fetch);
    expect(down).toEqual({ ok: true, skipped: expect.stringContaining("503") });
    const thrower: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect((await checkForkTarget(env.DB, ref, OURS, thrower)).ok).toBe(true);
    // A live, correct pinned file passes with no complaint.
    expect(await checkForkTarget(env.DB, ref, OURS, net({ [url]: { body: pinnedDoc() } }).fetch)).toEqual({ ok: true });
  });
});

describe("inbound: a fork mention verifies only against a real pin (§2.3.5)", () => {
  it("reads the claim from forked_from and ranks below stub and transclusion", () => {
    const doc = { forked_from: { origin: OURS, id: "target-id", version: 3 } };
    expect(relationTo(doc, OURS, "target-id")).toBe("fork");
    expect(relationTo(doc, OURS, "other-id")).toBeNull();
    expect(relationTo({ forked_from: { origin: THEIRS, id: "target-id", version: 3 } }, OURS, "target-id")).toBeNull();
    expect(forkedVersion(doc, OURS, "target-id")).toBe(3);
    // An item that both quotes us and descends from us is a transclusion: the
    // stronger, more specific claim wins (§2.3.5's ordering).
    expect(relationTo({ ...doc, transclusions: [{ origin: OURS, id: "target-id", version: 1 }] }, OURS, "target-id")).toBe("transclusion");
  });

  it("verifies a fork of a pinned version and refuses one that names an unpinned version", async () => {
    const cookie = await login();
    const pinnedTarget = await publishAndPin(cookie, "worth forking");
    const unpinnedTarget = await createAndPublish(cookie, "not pinned");

    // Each source is the item document at its real URL: §15.4 step 2
    // (decision #61) verifies only a document served from {origin}items/{id}.json.
    const srcId = newId();
    const sourcePage = `${THEIRS}items/${srcId}.json`;
    const good = await upsertAndVerify(env.DB, sourcePage, `${OURS}f/${pinnedTarget}/`, pinnedTarget, OURS, {
      [sourcePage]: JSON.stringify({ blyg: "0.3", id: srcId, kind: "fragment", origin: THEIRS, version: 1, forked_from: { origin: OURS, id: pinnedTarget, version: 1 } }),
    });
    expect(good).toMatchObject({ status: "verified", relation: "fork" });

    const srcId2 = newId();
    const badPage = `${THEIRS}items/${srcId2}.json`;
    const bad = await upsertAndVerify(env.DB, badPage, `${OURS}f/${unpinnedTarget}/`, unpinnedTarget, OURS, {
      [badPage]: JSON.stringify({ blyg: "0.3", id: srcId2, kind: "fragment", origin: THEIRS, version: 1, forked_from: { origin: OURS, id: unpinnedTarget, version: 1 } }),
    });
    expect(bad.status).toBe("failed");
    expect(bad.reason).toContain("not pinned");
  });
});
