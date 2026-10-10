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
  const clientFor = (cookie = "") => createBlyggerClient({ baseUrl: BASE, headers: { cookie }, fetch: (input, init) => SELF.fetch(input instanceof Request ? input : new Request(input, init)) });
  const client = clientFor(await login()), denied = clientFor();
  const draft = await unwrap(api.createItem({ client, body: { content_md: "matrix" } }));
  const sub = await createSubscription(env.DB, { kind: "rss", origin: "https://matrix.example/", feedUrl: "https://matrix.example/feed", title: "Matrix" });
  await upsertL0Item(env.DB, sub.id, "remote", { version: 1, contentMd: "remote", contentHtml: "<p>remote</p>", contentHash: "hash", observedAt: "2026-10-01T00:00:00Z", created: "2026-10-01T00:00:00Z", updated: "2026-10-01T00:00:00Z" });
  const hopper = await unwrap(api.createHopper({ client, body: { name: "Matrix" } }));
  await env.DB.prepare("INSERT INTO mentions_in (id, source, source_origin, source_id, source_kind, target, target_item_id, status, first_seen, last_seen, verified_at, hidden) VALUES ('matrix-mention', 'https://matrix.example/source', 'https://matrix.example/', 'remote', 'fragment', 'target', ?, 'verified', 'now', 'now', 'now', 0)").bind(draft.id).run();
  type Result = Promise<{ response?: Response; data?: unknown; error?: unknown }>;
  type Case = [keyof typeof routes, number, (client: BlyggerClient) => Result];
  const id = draft.id, member = { id: hopper.id, sub: sub.id, remoteId: "remote" }, signal = { sub: sub.id, remoteId: "remote" };
  const cases: Case[] = [
    ['getChanges', 200, client => api.getChanges({ client })],
    ["createItem", 201, client => api.createItem({ client, body: { mode: "response", source: { subscription_id: sub.id, remote_id: "remote" } } })],
    ["updateItem", 200, client => api.updateItem({ client, path: { id }, body: { content_md: "matrix changed", responses: "hide" } })],
    ["generateItem", 400, client => api.generateItem({ client, path: { id }, body: { scope: 100 } })],
    ["publishItem", 200, client => api.publishItem({ client, path: { id } })],
    ["pinItem", 200, client => api.pinItem({ client, path: { id, version: 1 } })],
    ["restoreItem", 200, client => api.restoreItem({ client, path: { id }, body: { version: 1 } })],
    ["uploadMedia", 201, client => api.uploadMedia({ client, body: { file: new File(["image"], "image.png", { type: "image/png" }), item_id: id, alt: "matrix" } })],
    ["updateSettings", 200, client => api.updateSettings({ client, body: { site_title: "Matrix", show_responses_default: true } })],
    ["createSubscription", 422, client => api.createSubscription({ client, body: { url: "not a url" } })],
    ["updateSubscription", 200, client => api.updateSubscription({ client, path: { id: sub.id }, body: { paused: true, title: "Renamed" } })],
    ["resyncSubscription", 409, client => api.resyncSubscription({ client, path: { id: sub.id } })],
    ["pollAllSubscriptions", 200, client => api.pollAllSubscriptions({ client })],
    ["createHopper", 201, client => api.createHopper({ client, body: { name: "Other matrix" } })],
    ["updateHopper", 200, client => api.updateHopper({ client, path: { id: hopper.id }, body: { public: true } })],
    ["addHopperItem", 200, client => api.addHopperItem({ client, path: member })],
    ["removeHopperItem", 200, client => api.removeHopperItem({ client, path: member })],
    ["setSignal", 200, client => api.setSignal({ client, path: signal, body: { thumb: -1 } })],
    ["deleteSignal", 200, client => api.deleteSignal({ client, path: signal })],
    ["markRead", 200, client => api.markRead({ client, path: signal, body: { version: 1 } })],
    ["markReadBatch", 200, client => api.markReadBatch({ client, body: { items: [{ sub: sub.id, remote_id: "remote", version: 1 }] } })],
    ["markUnread", 200, client => api.markUnread({ client, path: signal })],
    ["markUnreadBatch", 200, client => api.markUnreadBatch({ client, body: { items: [{ sub: sub.id, remote_id: "remote" }] } })],
    ["updateMention", 200, client => api.updateMention({ client, path: { id: "matrix-mention" }, body: { hidden: true } })],
    ["listItems", 200, client => api.listItems({ client, query: { offset: 0, limit: 1 } })],
    ["getItem", 200, client => api.getItem({ client, path: { id } })],
    ["getSettings", 200, client => api.getSettings({ client })],
    ["listSubscriptions", 200, client => api.listSubscriptions({ client, query: { limit: 1 } })],
    ["getSubscription", 200, client => api.getSubscription({ client, path: { id: sub.id } })],
    ["listHoppers", 200, client => api.listHoppers({ client, query: { limit: 1 } })],
    ["getHopper", 200, client => api.getHopper({ client, path: { id: hopper.id }, query: { preview: "true" } })],
    ["listSignals", 200, client => api.listSignals({ client, query: { limit: 1 } })],
    ["listInteractions", 200, client => api.listInteractions({ client, query: { limit: 1, kind: "quote" } })],
    ["listThumbs", 200, client => api.listThumbs({ client })],
    ["getAiModels", 200, client => api.getAiModels({ client })],
    ["listMentions", 200, client => api.listMentions({ client, query: { direction: "outbound", limit: 1 } })],
    ["preview", 200, client => api.preview({ client, body: { content_md: "**matrix**", kind: "thread", item_id: id } })],
    ["search", 200, client => api.search({ client, query: { q: "matrix", offset: 0, limit: 1 } })],
    ["getVersion", 200, client => api.getVersion({ client, path: { id, v: 1 } })],
    ["listReading", 200, client => api.listReading({ client, query: { sub: sub.id, limit: 1 } })],
    ["listImportedReading", 200, client => api.listImportedReading({ client, query: { limit: 1 } })],
    ["getImportedItem", 200, client => api.getImportedItem({ client, path: { sub: sub.id, id: "remote" } })],
    ["getUpdateState", 200, client => api.getUpdateState({ client })],
    ["getMentionSource", 200, client => api.getMentionSource({ client, path: { id: "matrix-mention" } })],
    ["getForkOptions", 200, client => api.getForkOptions({ client, query: { id } })],
    ["listStaleThreads", 200, client => api.listStaleThreads({ client })],
    ["getItemFreshness", 409, client => api.getItemFreshness({ client, path: { id }, query: { probe: "false" } })],
    ["refreshItem", 409, client => api.refreshItem({ client, path: { id } })],
    ["deleteMedia", 404, client => api.deleteMedia({ client, path: { id: "missing-media" } })],
    ["draftNote", 409, client => api.draftNote({ client, path: { id } })],
    ["getImportedHistory", 404, client => api.getImportedHistory({ client, path: { sub: sub.id, id: "remote" } })],
    ["getImportedVersion", 404, client => api.getImportedVersion({ client, path: { sub: sub.id, id: "remote", v: 1 } })],
    ["withdrawItem", 200, client => api.withdrawItem({ client, path: { id } })],
    ["deleteItem", 409, client => api.deleteItem({ client, path: { id } })],
    ["deleteHopper", 200, client => api.deleteHopper({ client, path: { id: hopper.id } })],
    ["deleteSubscription", 200, client => api.deleteSubscription({ client, path: { id: sub.id } })],
  ];
  expect(cases.map(([name]) => name).sort()).toEqual(Object.keys(routes).sort());
  for (const [name, status, call] of cases) {
    const unauthorized = await call(denied);
    expect(unauthorized.response?.status, `${name}: auth`).toBe(401);
    expect(unauthorized.error).toEqual({ error: "unauthorized" });
    const result = await call(client);
    expect(result.response?.status, name).toBe(status);
    const definition = routes[name].responses[status];
    const media = definition && "content" in definition ? definition.content?.["application/json"] : undefined;
    const schema = media && "schema" in media ? media.schema : undefined;
    expect(schema && "safeParse" in schema && schema.safeParse(result.data ?? result.error).success, name).toBe(true);
    expect(result.response?.headers.get("cache-control"), name).toBe("no-store");
  }
}, 60_000);
