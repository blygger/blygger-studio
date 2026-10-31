import { testItemRevision, testMediaRevision } from './helpers.ts';
import { SELF, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { BlyggerApi as api, createBlyggerClient, unwrap, type BlyggerClient } from "../sdk/dist/browser.js";
import { routes } from "../src/contract/routes.ts";
import { createSubscription, upsertL0Item } from "../src/importer/store.ts";
import { BASE, login } from "./helpers.ts";

// This matrix proves operation wiring, serialization, auth, and declared shape.
// The independent oracles own semantic correctness. Generate/subscribe success
// needs a provider fixture; this matrix explicitly credits only their errors.
it("exercises every declared operation through its named SDK method, including auth", async () => {
  const clientFor = (cookie = "") => createBlyggerClient({ baseUrl: BASE + '/blyg/api', headers: { cookie }, fetch: (input, init) => SELF.fetch(input instanceof Request ? input : new Request(input, init)) });
  const client = clientFor(await login()), denied = clientFor();
  const draft = await unwrap(api.createItem({ client, body: { contentMd: "matrix" } }));
  const sub = await createSubscription(env.DB, { kind: "rss", origin: "https://matrix.example/", feedUrl: "https://matrix.example/feed", title: "Matrix" });
  await upsertL0Item(env.DB, sub.id, "remote", { version: 1, contentMd: "remote", contentHtml: "<p>remote</p>", contentHash: "hash", observedAt: "2026-10-01T00:00:00Z", created: "2026-10-01T00:00:00Z", updated: "2026-10-01T00:00:00Z" });
  const hopper = await unwrap(api.createHopper({ client, body: { name: "Matrix" } }));
  await env.DB.prepare("INSERT INTO mentions_in (id, source, source_origin, source_id, source_kind, target, target_item_id, status, first_seen, last_seen, verified_at, hidden) VALUES ('matrix-mention', 'https://matrix.example/source', 'https://matrix.example/', 'remote', 'fragment', 'target', ?, 'verified', 'now', 'now', 'now', 0)").bind(draft.id).run();
  type Result = Promise<{ response?: Response; data?: unknown; error?: unknown }>;
  type Case = [keyof typeof routes, number, (client: BlyggerClient) => Result];
  const id = draft.id, member = { id: hopper.id, sub: sub.id, remoteId: "remote" }, signal = { sub: sub.id, remoteId: "remote" };
  const cases: Case[] = [
    ['getCapabilities', 200, async client => api.getCapabilities({ client })],
    ['getChanges', 200, async client => api.getChanges({ client })],
    ["createItem", 201, async client => api.createItem({ client, body: { mode: "response", source: { subscriptionId: sub.id, remoteId: "remote" } } })],
    ["updateItem", 200, async client => api.updateItem({ client, path: { id }, body: { ...({ contentMd: "matrix changed", responses: "hide" }), expectedRevision: await testItemRevision(id) } })],
    ["generateItem", 400, async client => api.generateItem({ client, path: { id }, body: { ...({ scope: 100 }), expectedRevision: await testItemRevision(id) } })],
    ["publishItem", 200, async client => api.publishItem({ client, path: { id } , body: { expectedRevision: await testItemRevision(id) } })],
    ["pinItem", 200, async client => api.pinItem({ client, path: { id, version: 1 } , body: { expectedRevision: await testItemRevision(id) } })],
    ["restoreItem", 200, async client => api.restoreItem({ client, path: { id }, body: { ...({ version: 1 }), expectedRevision: await testItemRevision(id) } })],
    ["uploadMedia", 201, async client => api.uploadMedia({ client, body: { file: new File(["image"], "image.png", { type: "image/png" }), itemId: id, expectedRevision: await testItemRevision(id), alt: "matrix" } })],
    ["updateSettings", 200, async client => api.updateSettings({ client, body: { siteTitle: "Matrix", showResponsesDefault: true } })],
    ["createSubscription", 422, async client => api.createSubscription({ client, body: { url: "not a url" } })],
    ["updateSubscription", 200, async client => api.updateSubscription({ client, path: { id: sub.id }, body: { paused: true, title: "Renamed" } })],
    ["resyncSubscription", 409, async client => api.resyncSubscription({ client, path: { id: sub.id } })],
    ["pollAllSubscriptions", 200, async client => api.pollAllSubscriptions({ client })],
    ["createHopper", 201, async client => api.createHopper({ client, body: { name: "Other matrix" } })],
    ["updateHopper", 200, async client => api.updateHopper({ client, path: { id: hopper.id }, body: { public: true } })],
    ["addHopperItem", 200, async client => api.addHopperItem({ client, path: member })],
    ["removeHopperItem", 200, async client => api.removeHopperItem({ client, path: member })],
    ["setSignal", 200, async client => api.setSignal({ client, path: signal, body: { thumb: -1 } })],
    ["deleteSignal", 200, async client => api.deleteSignal({ client, path: signal })],
    ["markRead", 200, async client => api.markRead({ client, path: signal, body: { version: 1 } })],
    ["markReadBatch", 200, async client => api.markReadBatch({ client, body: { items: [{ sub: sub.id, remoteId: "remote", version: 1 }] } })],
    ["markUnread", 200, async client => api.markUnread({ client, path: signal })],
    ["markUnreadBatch", 200, async client => api.markUnreadBatch({ client, body: { items: [{ sub: sub.id, remoteId: "remote" }] } })],
    ["updateMention", 200, async client => api.updateMention({ client, path: { id: "matrix-mention" }, body: { hidden: true } })],
    ["listItems", 200, async client => api.listItems({ client, query: { offset: 0, limit: 1 } })],
    ["getItem", 200, async client => api.getItem({ client, path: { id } })],
    ["getSettings", 200, async client => api.getSettings({ client })],
    ["listSubscriptions", 200, async client => api.listSubscriptions({ client, query: { limit: 1 } })],
    ["getSubscription", 200, async client => api.getSubscription({ client, path: { id: sub.id } })],
    ["listHoppers", 200, async client => api.listHoppers({ client, query: { limit: 1 } })],
    ["getHopper", 200, async client => api.getHopper({ client, path: { id: hopper.id }, query: { preview: "true" } })],
    ["listSignals", 200, async client => api.listSignals({ client, query: { limit: 1 } })],
    ["listInteractions", 200, async client => api.listInteractions({ client, query: { limit: 1, kind: "quote" } })],
    ["listThumbs", 200, async client => api.listThumbs({ client })],
    ["getAiModels", 200, async client => api.getAiModels({ client })],
    ["listMentions", 200, async client => api.listMentions({ client, query: { direction: "outbound", limit: 1 } })],
    ["preview", 200, async client => api.preview({ client, body: { contentMd: "**matrix**", kind: "thread", itemId: id } })],
    ["search", 200, async client => api.search({ client, query: { q: "matrix", offset: 0, limit: 1 } })],
    ["getVersion", 200, async client => api.getVersion({ client, path: { id, v: 1 } })],
    ["listReading", 200, async client => api.listReading({ client, query: { sub: sub.id, limit: 1 } })],
    ["listImportedReading", 200, async client => api.listImportedReading({ client, query: { limit: 1 } })],
    ["getImportedItem", 200, async client => api.getImportedItem({ client, path: { sub: sub.id, id: "remote" } })],
    // A malformed origin is refused before anything is fetched.
    ["peekItem", 400, async client => api.peekItem({ client, query: { origin: "not a url", id } })],
    ["classifyLinks", 200, async client => api.classifyLinks({ client, body: { urls: ["javascript:0"] } })],
    ["listBrowse", 200, async client => api.listBrowse({ client, query: { limit: 1 } })],
    ["logBrowse", 201, async client => api.logBrowse({ client, body: { trail: "matrix-trail-0001", origin: "https://matrix.example/", remoteId: "remote", via: "start" } })],
    ["clearBrowse", 200, async client => api.clearBrowse({ client, query: { trail: "matrix-trail-0001" } })],
    ["getUpdateState", 200, async client => api.getUpdateState({ client })],
    ["getMentionSource", 200, async client => api.getMentionSource({ client, path: { id: "matrix-mention" } })],
    ["getForkOptions", 200, async client => api.getForkOptions({ client, query: { id } })],
    // Extension routes answer 404 while the extension is disabled, as it is here.
    ["extLineageGlyphGetLineage", 404, async client => api.extLineageGlyphGetLineage({ client, query: { id } })],
    ["extLineageGlyphListSummaries", 404, async client => api.extLineageGlyphListSummaries({ client, query: { keys: JSON.stringify([`own:${id}`]) } })],
    ["listStaleThreads", 200, async client => api.listStaleThreads({ client })],
    ["getItemFreshness", 409, async client => api.getItemFreshness({ client, path: { id }, query: { probe: "false" } })],
    ["refreshItem", 409, async client => api.refreshItem({ client, path: { id } , body: { expectedRevision: await testItemRevision(id) } })],
    ["deleteMedia", 404, async client => api.deleteMedia({ client, path: { id: "missing-media" } , body: { expectedRevision: await testMediaRevision("missing-media") } })],
    ["draftNote", 409, async client => api.draftNote({ client, path: { id } , body: { expectedRevision: await testItemRevision(id) } })],
    // Off (409) until Settings names a decision model, as it does not here.
    ["classifyChange", 409, async client => api.classifyChange({ client, path: { id } , body: { expectedRevision: await testItemRevision(id) } })],
    ["getImportedHistory", 404, async client => api.getImportedHistory({ client, path: { sub: sub.id, id: "remote" } })],
    ["getImportedVersion", 404, async client => api.getImportedVersion({ client, path: { sub: sub.id, id: "remote", v: 1 } })],
    ["withdrawItem", 200, async client => api.withdrawItem({ client, path: { id } , body: { expectedRevision: await testItemRevision(id) } })],
    ["deleteItem", 409, async client => api.deleteItem({ client, path: { id } , body: { expectedRevision: await testItemRevision(id) } })],
    ["deleteHopper", 200, async client => api.deleteHopper({ client, path: { id: hopper.id } })],
    ["deleteSubscription", 200, async client => api.deleteSubscription({ client, path: { id: sub.id } })],
  ];
  expect(cases.map(([name]) => name).sort()).toEqual(Object.keys(routes).sort());
  for (const [name, status, call] of cases) {
    const unauthorized = await call(denied);
    expect(unauthorized.response?.status, `${name}: auth`).toBe(401);
    expect(unauthorized.error).toEqual({ code: "unauthorized", message: "unauthorized" });
    const result = await call(client);
    expect(result.response?.status, name).toBe(status);
    const definition = routes[name].responses[status];
    const media = definition && "content" in definition ? definition.content?.["application/json"] : undefined;
    const schema = media && "schema" in media ? media.schema : undefined;
    expect(schema && "safeParse" in schema && schema.safeParse(result.data ?? result.error).success, name).toBe(true);
    expect(result.response?.headers.get("cache-control"), name).toBe("no-store");
  }
}, 60_000);
