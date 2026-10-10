import { ItemSchema, VersionSchema, MediaSchema, SubscriptionSchema, HopperSchema, ImportedItemSchema, MentionSchema, VersionReferenceSchema, StubSchema, TransclusionSchema, ProvenanceSchema } from "./resources.ts";
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema, route } from "./route.ts";
import { extensionRoutes } from "../../extensions/catalog.ts";
import { SettingsSchema, HopperItemRowSchema, SignalRowSchema, MentionOutRowSchema } from "./schemas.ts";
import { CHANGE_DOMAINS } from '../change-state.ts';
import { READ_BATCH_MAX, READ_ID_MAX, READ_VERSION_MAX } from '../importer/read-state.ts';
import { IMPORTED_READING_MAX, READING_CURSOR_MAX, decodeReadingCursor } from '../imported-reading.ts';

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
export { ErrorSchema };
const ok = z.object({ ok: z.boolean() });
const created = ItemSchema;
const ref = VersionReferenceSchema;
const stub = StubSchema;
export const ItemEditSchema = z.object({ provenance: z.array(z.union([ProvenanceSchema, z.null()])).optional(), content_md: z.string().optional(), kind: z.enum(["fragment", "thread"]).optional(), stub_of: z.union([stub, z.null()]).optional(), responses: z.enum(["default", "show", "hide"]).optional(), highlight: z.enum(["default", "show", "hide"]).optional() }).strict();
export const ItemCreateSchema = z.union([
  ItemEditSchema.omit({ responses: true, highlight: true }).extend({ mode: z.literal("blank").optional() }).strict(),
  z.object({ mode: z.literal("fork"), source: ref }).strict(),
  z.object({ mode: z.literal("response"), source: z.object({ subscription_id: z.string().min(1), remote_id: z.string().min(1) }).strict(), selection: z.string().optional() }).strict(),
]);
const toggle = z.boolean();
const settingsBody = SettingsSchema.partial().extend({ accept_mentions: toggle.optional(), update_check: toggle.optional(), show_responses_default: toggle.optional(), highlight_generated_default: toggle.optional(), auto_change_notes: toggle.optional(), update_notice_ack: toggle.optional() }).strict();
const note = z.object({ note: z.string().optional() });
const version = z.object({ version: z.number().int().positive() });
const page = z.object({ offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
const collection = (schema: z.ZodType) => z.object({ items: z.array(schema), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive() });
const issue = z.object({ id: z.string().optional(), directive: z.string().optional(), reason: z.string().optional() }).passthrough();
const scopes = z.array(z.object({ index: z.number(), instruction: z.string(), output: z.string().nullable(), hasOutput: z.boolean(), block: z.boolean(), imported: z.boolean() }));
const preview = z.object({ html: z.string(), scopes, link_errors: z.array(issue).optional(), errors: z.array(issue).optional(), transclusions: z.array(TransclusionSchema).optional() });
const ownEntry = z.object({ id: z.string(), kind: z.enum(["fragment", "thread"]), withdrawn: z.boolean(), updated: z.string(), contentHtml: z.string() });
const importedEntry = z.object({ subscriptionId: z.string(), subscriptionTitle: z.string(), remoteId: z.string(), kind: z.enum(["fragment", "thread"]), withdrawn: z.boolean(), l0: z.boolean(), updated: z.string().nullable(), observedAt: z.string(), contentHtml: z.string(), pinnedVersionRetained: z.number().nullable(), sourceUrl: z.string().nullable(), version: z.number().int().describe("The version of the item held here. A readVersion below it means a newer version arrived after the owner read it."), readVersion: z.number().int().nullable().describe("The highest version the owner has marked read; null when unread or cleared.") });
/** One row of GET /reading/imported (studio#11): an imported entry with the fields a client authors from. */
export const ImportedReadingEntrySchema = importedEntry.extend({
  origin: z.string(),
  created: z.string().nullable(),
  contentMd: z.string().describe("The item's markdown as imported; empty for a withdrawn item and for feeds that carry none."),
  author: z.object({ name: z.string().nullable(), url: z.string().nullable() }).nullable(),
  page: z.string().nullable().describe("The origin's declared page, as the origin declared it; null when it declares none."),
  thumb: z.union([z.literal(1), z.literal(-1)]).nullable().describe("The owner's signal; null when none."),
  hoppers: z.array(z.string()).describe("Ids of the hoppers holding this item."),
  transclusions: z.array(z.unknown()).nullable().describe("The origin's transclusions[] verbatim (Transclusion shape, cited included); remote and unvalidated. Null for fragments, L0 items, withdrawn items, or malformed data."),
  stubOf: z.record(z.string(), z.unknown()).nullable().describe("The origin's stub_of verbatim (CitationTarget shape); remote and unvalidated. Null when none."),
  forkedFrom: z.record(z.string(), z.unknown()).nullable().describe("The origin's forked_from verbatim (VersionReference shape); remote and unvalidated. Null when none."),
}).openapi("ImportedReadingEntry");
const readingCursor = z.string().max(READING_CURSOR_MAX).refine((raw) => decodeReadingCursor(raw) !== null, "malformed cursor").describe("The next value of the previous page. Opaque.");
export const ReadingEntrySchema = z.object({ key: z.string(), source: z.enum(["own", "imported"]), kind: z.enum(["fragment", "thread"]), withdrawn: z.boolean(), l0: z.boolean(), contentHtml: z.string(), displayAt: z.string(), own: ownEntry.optional(), imported: importedEntry.optional() }).openapi("ReadingEntry");
const subscribed = SubscriptionSchema;
const confirmation = z.object({ needsConfirm: z.literal(true), kind: z.enum(["blyg", "rss"]), origin: z.string().optional(), feedUrl: z.string().optional(), title: z.string(), siteMismatch: z.object({ asserted: z.string(), actual: z.string() }).optional() });
const quoteFreshness = z.object({ id: z.string(), origin: z.string().optional(), baked: z.number().int(), held: z.number().int().nullable(), live: z.number().int().nullable(), partial: z.boolean(), status: z.enum(["current", "refreshable", "behind", "passage-missing", "unresolvable", "retained"]), reason: z.string().optional() }).openapi("QuoteFreshness");
export const ThreadFreshnessSchema = z.object({ id: z.string(), version: z.number().int(), dirty: z.boolean(), quotes: z.array(quoteFreshness), stale: z.number().int().nonnegative(), blocking: z.number().int().nonnegative(), behind: z.number().int().nonnegative() }).openapi("ThreadFreshness");
const interactionKind = z.enum(["thumb_up", "thumb_down", "thumb_clear", "hopper_add", "hopper_remove", "stub", "fork", "quote"]);
/** The owner's private interaction log (0.25.0). Never on the wire. */
export const InteractionSchema = z.object({ id: z.number().int(), at: z.string(), kind: interactionKind, origin: z.string(), remote_id: z.string(), version: z.number().int().nullable(), own_item_id: z.string().nullable(), own_version: z.number().int().nullable(), hopper_id: z.string().nullable(), hopper_name: z.string().nullable(), backfilled: z.number().int(), subscription_id: z.string().nullable(), label: z.string().nullable() }).openapi("Interaction");
export const ThumbSchema = z.object({ thumb: z.union([z.literal(1), z.literal(-1)]), at: z.string(), origin: z.string(), remote_id: z.string(), subscription_id: z.string().nullable(), label: z.string().nullable() }).openapi("Thumb");
/** The model manifest for Settings (0.26.0): which models exist, and which providers have a key. Never a key's value. */
export const AiModelsSchema = z.object({
  providers: z.array(z.object({ id: z.string(), label: z.string(), key_secret: z.string(), configured: z.boolean() })),
  models: z.array(z.object({ id: z.string(), provider: z.string(), label: z.string(), note: z.string().optional() })),
  local: z.boolean(),
}).openapi("AiModels");
const readVersion = z.number().int().min(1).max(READ_VERSION_MAX);
const readAt = z.iso.datetime({ offset: true }).optional().describe("When the client read it (ISO-8601). A read earlier than the row's latest clear is ignored; omitted, the read always applies.");
const readId = z.string().min(1).max(READ_ID_MAX);
const readMark = z.object({ sub: readId, remote_id: readId, version: readVersion, read_at: readAt }).strict();
const unreadMark = z.object({ sub: readId, remote_id: readId }).strict();
const counts = z.object({ all: z.number(), own: z.number(), subscriptions: z.record(z.string(), z.number()) });


export const routes = {
  getChanges: route('getChanges', 'get', '/changes', z.object({ epoch: z.string().min(1), domains: z.object(Object.fromEntries(CHANGE_DOMAINS.map(domain => [domain, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])) as Record<typeof CHANGE_DOMAINS[number], z.ZodNumber>) }).openapi('ChangeState')),
  createItem: route("createItem", "post", "/items", created, ItemCreateSchema, 201, undefined, true),
  updateItem: route("updateItem", "patch", "/items/{id}", ItemSchema, ItemEditSchema),
  publishItem: route("publishItem", "post", "/items/{id}/publish", ok.extend({ version: z.number(), warning: z.string().optional() }), note.extend({ note_generated: z.boolean().optional() }), 200, undefined, true),
  draftNote: route("draftNote", "post", "/items/{id}/note-draft", z.object({ note: z.string(), model: z.string(), pinned_prior: z.boolean() })),
  generateItem: route("generateItem", "post", "/items/{id}/generate", z.object({ text: z.string(), model: z.string(), content_md: z.string() }), z.object({ scope: z.number().int().min(0) })),
  withdrawItem: route("withdrawItem", "post", "/items/{id}/withdraw", ok.extend({ version: z.number() }), note, 200, undefined, true),
  pinItem: route("pinItem", "put", "/items/{id}/versions/{version}/pin", ok.extend({ version: z.number(), already: z.boolean() })),
  restoreItem: route("restoreItem", "post", "/items/{id}/restore", ok.extend({ restored: z.number(), publishesAs: z.number() }), version),
  deleteItem: route("deleteItem", "delete", "/items/{id}", ok.extend({ outcome: z.literal("discarded") })),
  uploadMedia: createRoute({ ...route("uploadMedia", "post", "/media", z.object({ id: z.string(), url: z.string(), mime: z.string() }), undefined, 201), request: { body: { required: true, content: { "multipart/form-data": { schema: z.object({ file: z.custom<File>((value) => value instanceof File, "file field required (multipart)").openapi({ type: "string", format: "binary" }), item_id: z.string().optional(), alt: z.string().optional(), inline: z.enum(["true", "false"]).optional() }) } } } } }),
  deleteMedia: route("deleteMedia", "delete", "/media/{id}", ok.extend({ outcome: z.enum(["deleted", "detached"]) })),
  updateSettings: route("updateSettings", "patch", "/settings", SettingsSchema, settingsBody),
  createSubscription: route("createSubscription", "post", "/subscriptions", confirmation, z.object({ url: z.string(), confirm: z.boolean().optional(), title: z.string().optional() })),
  updateSubscription: route("updateSubscription", "patch", "/subscriptions/{id}", SubscriptionSchema, z.object({ in_blogroll: z.boolean().optional(), title: z.string().trim().min(1).nullable().optional().describe("A name of your own; null hands the name back to the source, refreshed while polling."), paused: z.boolean().optional() }).strict()),
  pollAllSubscriptions: route("pollAllSubscriptions", "post", "/subscriptions/poll", z.object({ polling: z.number().int().nonnegative() })),
  resyncSubscription: route("resyncSubscription", "post", "/subscriptions/{id}/resync", ok.extend({ changed: z.number() })),
  deleteSubscription: route("deleteSubscription", "delete", "/subscriptions/{id}", ok),
  createHopper: route("createHopper", "post", "/hoppers", HopperSchema, z.object({ name: z.string() }), 201),
  updateHopper: route("updateHopper", "patch", "/hoppers/{id}", HopperSchema, z.object({ name: z.string().trim().min(1).optional(), public: z.boolean().optional(), description: z.string().trim().max(280).optional() }).strict()),
  deleteHopper: route("deleteHopper", "delete", "/hoppers/{id}", ok),
  addHopperItem: route("addHopperItem", "put", "/hoppers/{id}/items/{sub}/{remoteId}", ok),
  removeHopperItem: route("removeHopperItem", "delete", "/hoppers/{id}/items/{sub}/{remoteId}", ok),
  setSignal: route("setSignal", "put", "/signals/{sub}/{remoteId}", ok, z.object({ thumb: z.union([z.literal(1), z.literal(-1)]) })),
  deleteSignal: route("deleteSignal", "delete", "/signals/{sub}/{remoteId}", ok),
  markRead: route("markRead", "put", "/reading/{sub}/{remoteId}/read", ok.extend({ stored: z.boolean(), read_version: z.number().int().nullable() }), z.object({ version: readVersion, read_at: readAt })),
  markUnread: route("markUnread", "delete", "/reading/{sub}/{remoteId}/read", ok.extend({ stored: z.literal(false), read_version: z.null() })),
  markReadBatch: route("markReadBatch", "post", "/reading/read", ok.extend({ received: z.number().int().nonnegative() }), z.object({ items: z.array(readMark).max(READ_BATCH_MAX) })),
  markUnreadBatch: route("markUnreadBatch", "post", "/reading/unread", ok.extend({ received: z.number().int().nonnegative() }), z.object({ items: z.array(unreadMark).max(READ_BATCH_MAX) })),
  updateMention: route("updateMention", "patch", "/mentions/{id}", ok.extend({ hidden: z.boolean() }), z.object({ hidden: z.boolean() })),
  listItems: route("listItems", "get", "/items", z.object({ items: z.array(ItemSchema.extend({ pins: z.array(z.object({ version: z.number().int().positive(), kind: z.enum(["fragment", "thread"]) })).optional() })), total: z.number(), offset: z.number(), limit: z.number() }), undefined, 200, page),
  getItem: route("getItem", "get", "/items/{id}", z.object({ ...ItemSchema.shape, authored_kind: z.enum(["fragment", "thread"]), media: z.array(MediaSchema), versions: z.array(VersionSchema), published: z.union([VersionSchema, z.null()]) })),
  getSettings: route("getSettings", "get", "/settings", SettingsSchema),
  listSubscriptions: route("listSubscriptions", "get", "/subscriptions", collection(SubscriptionSchema), undefined, 200, page),
  getSubscription: route("getSubscription", "get", "/subscriptions/{id}", SubscriptionSchema),
  listHoppers: route("listHoppers", "get", "/hoppers", collection(HopperSchema), undefined, 200, page),
  getHopper: route("getHopper", "get", "/hoppers/{id}", z.object({ hopper: HopperSchema, memberships: z.array(HopperItemRowSchema), items: z.array(ImportedItemSchema), total: z.number().int().nonnegative(), source_count: z.number().int().nonnegative() }), undefined, 200, z.object({ preview: z.literal("true").optional() })),
  listSignals: route("listSignals", "get", "/signals", collection(SignalRowSchema), undefined, 200, page),
  listInteractions: route("listInteractions", "get", "/interactions", collection(InteractionSchema), undefined, 200, page.extend({ kind: interactionKind.optional() })),
  listThumbs: route("listThumbs", "get", "/thumbs", z.object({ items: z.array(ThumbSchema) })),
  getAiModels: route("getAiModels", "get", "/ai/models", AiModelsSchema),
  listMentions: route("listMentions", "get", "/mentions", collection(z.union([MentionSchema, MentionOutRowSchema])).extend({ direction: z.enum(["inbound", "outbound"]) }), undefined, 200, page.extend({ direction: z.enum(["inbound", "outbound"]).optional() })),
  preview: route("preview", "post", "/preview", preview, z.object({ content_md: z.string().optional(), item_id: z.string().optional(), kind: z.enum(["fragment", "thread"]).optional() })),
  search: route("search", "get", "/search", z.object({ items: z.array(z.object({ id: z.string(), excerpt: z.string(), version: z.number(), updated: z.string(), badge: z.string(), source: z.enum(["mine", "imported"]), kind: z.enum(["fragment", "thread"]), subscription_id: z.string().nullable(), source_title: z.string().nullable() })), total: z.number(), offset: z.number(), limit: z.number() }), undefined, 200, page.extend({ q: z.string().optional(), source: z.enum(["all", "mine", "imported"]).optional(), sub: z.string().optional(), sort: z.enum(["newest", "oldest"]).optional() })),
  getVersion: route("getVersion", "get", "/items/{id}/versions/{v}", VersionSchema),
  listReading: route("listReading", "get", "/reading", z.object({ items: z.array(ReadingEntrySchema), counts, total: z.number(), offset: z.number(), limit: z.number(), selected: z.string(), read_state: z.literal(true).describe("This server stores read state: each imported entry's readVersion is meaningful."), read_state_clear: z.literal(true).describe("Read state can be cleared: DELETE /reading/{sub}/{remoteId}/read, POST /reading/unread, and read_at on reads.") }), undefined, 200, page.extend({ limit: z.coerce.number().int().min(1).max(50).optional(), sub: z.string().optional(), kind: z.enum(["thread", "fragment"]).optional() })),
  listImportedReading: route("listImportedReading", "get", "/reading/imported", z.object({ items: z.array(ImportedReadingEntrySchema), next: z.string().nullable().describe("Pass as cursor for the next page; null on the last page."), limit: z.number().int().positive() }), undefined, 200, z.object({ cursor: readingCursor.optional(), limit: z.coerce.number().int().min(1).max(IMPORTED_READING_MAX).optional() })),
  getImportedItem: route("getImportedItem", "get", "/imports/{sub}/{id}", ImportedItemSchema),
  getImportedHistory: route("getImportedHistory", "get", "/imports/{sub}/{id}/history", z.object({ current: z.number().int(), withdrawn: z.boolean(), changelog: z.array(z.object({ version: z.number().int(), at: z.string(), note: z.string().nullable(), pinned: z.boolean(), generated: z.boolean() })) })),
  getImportedVersion: route("getImportedVersion", "get", "/imports/{sub}/{id}/versions/{v}", z.object({ version: z.number().int(), content_md: z.string(), note: z.string().nullable(), pinned: z.boolean() })),
  getUpdateState: route("getUpdateState", "get", "/update-state", z.record(z.string(), z.string())),
  getMentionSource: route("getMentionSource", "get", "/mentions/{id}/source", z.object({ holder: z.string().nullable(), subscription: z.union([SubscriptionSchema, z.null()]) })),
  listStaleThreads: route("listStaleThreads", "get", "/freshness", z.object({ items: z.array(ThreadFreshnessSchema) })),
  getItemFreshness: route("getItemFreshness", "get", "/items/{id}/freshness", ThreadFreshnessSchema, undefined, 200, z.object({ probe: z.enum(["true", "false"]).optional() })),
  refreshItem: route("refreshItem", "post", "/items/{id}/refresh", ok.extend({ version: z.number(), refreshed: z.array(z.string()), resynced: z.number().int().nonnegative(), warning: z.string().optional() }), note, 200, undefined, true),
  getForkOptions: route("getForkOptions", "get", "/fork-options", z.object({ origin: z.string(), ourOrigin: z.string(), versions: z.array(z.object({ version: z.number(), at: z.string(), note: z.string().nullable() })), error: z.string().optional() }), undefined, 200, z.object({ id: z.string(), sub: z.string().optional(), origin: z.string().optional() })),
  // Read routes contributed by the extensions in this repository (extensions/catalog.ts).
  ...extensionRoutes,
};
// The resolve/confirm operation has two successful response shapes and statuses.
routes.createSubscription.responses[201] = { description: "Subscribed", content: json(subscribed) };
