import { readOperation, draftOperation, publishOperation, manageOperation, readingStateOperation, authenticatedOperation, presentationScopes, avatarScopes } from '../operation-policy.ts';
import { ItemSchema, VersionSchema, MediaSchema, SubscriptionSchema, HopperSchema, ImportedItemSchema, MentionSchema, VersionReferenceSchema, StubSchema, TransclusionSchema, ProvenanceSchema } from "./resources.ts";
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema, route } from "./route.ts";
import { extensionRoutes } from "../../extensions/catalog.ts";
import { ItemRevisionSchema, SettingsSchema, HopperItemRowSchema, SignalRowSchema, MentionOutRowSchema } from "./schemas.ts";
import { CHANGE_DOMAINS } from '../change-state.ts';
import { CHANGE_CATEGORIES } from "../change-category.ts";
import { READ_BATCH_MAX, READ_ID_MAX, READ_VERSION_MAX } from '../importer/read-state.ts';
import { BROWSE_VIA } from "../browse-log.ts";
import { CLASSIFY_MAX } from "../peek.ts";
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
const settingsBody = SettingsSchema.partial().extend({ accept_mentions: toggle.optional(), update_check: toggle.optional(), show_responses_default: toggle.optional(), highlight_generated_default: toggle.optional(), auto_change_notes: toggle.optional(), change_category_in_note: toggle.optional(), update_notice_ack: toggle.optional() }).strict();
const condition = z.object({ expectedRevision: ItemRevisionSchema });
const note = condition.extend({ note: z.string().optional() });
const changeCategory = z.enum(CHANGE_CATEGORIES);
const version = condition.extend({ version: z.number().int().positive() });
const page = z.object({ offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
const collection = (schema: z.ZodType) => z.object({ items: z.array(schema), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive() });
const issue = z.object({ id: z.string().optional(), directive: z.string().optional(), reason: z.string().optional() }).passthrough();
const scopeSource = z.object({ id: z.string(), ok: z.boolean(), from: z.string().optional().describe('"you", or the subscription title of a remote source'), remote: z.boolean().optional().describe("A remote source: its author is sent a `source` mention when the generated text is published."), excerpt: z.string().optional(), reason: z.string().optional().describe("Why generate would refuse this source") });
const scopes = z.array(z.object({ index: z.number(), instruction: z.string(), output: z.string().nullable(), hasOutput: z.boolean(), block: z.boolean(), imported: z.boolean(), sources: z.array(scopeSource) }));
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
  generated: z.array(z.unknown()).nullable().describe("The origin's generated[] verbatim (GenerationProvenance shape, remote sources' origin and cited included); remote and unvalidated. Null when none."),
}).openapi("ImportedReadingEntry");
const readingCursor = z.string().max(READING_CURSOR_MAX).refine((raw) => decodeReadingCursor(raw) !== null, "malformed cursor").describe("The next value of the previous page. Opaque.");
export const ReadingEntrySchema = z.object({ key: z.string(), source: z.enum(["own", "imported"]), kind: z.enum(["fragment", "thread"]), withdrawn: z.boolean(), l0: z.boolean(), contentHtml: z.string(), displayAt: z.string(), own: ownEntry.optional(), imported: importedEntry.optional() }).openapi("ReadingEntry");
const subscribed = SubscriptionSchema;
const confirmation = z.object({ needsConfirm: z.literal(true), kind: z.enum(["blyg", "rss"]), origin: z.string().optional(), feedUrl: z.string().optional(), title: z.string(), siteMismatch: z.object({ asserted: z.string(), actual: z.string() }).optional() });
const quoteFreshness = z.object({ id: z.string(), origin: z.string().optional(), baked: z.number().int(), held: z.number().int().nullable(), live: z.number().int().nullable(), partial: z.boolean(), status: z.enum(["current", "refreshable", "behind", "passage-missing", "unresolvable", "retained"]), reason: z.string().optional() }).openapi("QuoteFreshness");
export const ThreadFreshnessSchema = z.object({ id: z.string(), version: z.number().int(), dirty: z.boolean(), quotes: z.array(quoteFreshness), stale: z.number().int().nonnegative(), blocking: z.number().int().nonnegative(), behind: z.number().int().nonnegative() }).openapi("ThreadFreshness");
const interactionKind = z.enum(["thumb_up", "thumb_down", "thumb_clear", "hopper_add", "hopper_remove", "stub", "fork", "quote"]);
/** The owner's private interaction log (0.25.0). Never on the wire. */
export const PeekItemSchema = z.object({ origin: z.string(), id: z.string(), kind: z.enum(["fragment", "thread", "withdrawn"]), version: z.number().int().positive(), content_html: z.string().describe("Sanitized, as a subscribed item's is."), page: z.string().nullable(), url: z.string(), stub_of: z.unknown().nullable(), forked_from: z.unknown().nullable(), subscription_id: z.string().nullable().describe("The subscription holding this origin, when there is one: open the held copy at /reading/{sub}/{id}.") }).openapi("PeekItem");
export const BrowseStepSchema = z.object({ id: z.number().int(), at: z.string(), trail: z.string(), parent_id: z.number().int().nullable(), origin: z.string(), remote_id: z.string(), version: z.number().int().nullable(), via: z.enum(BROWSE_VIA), title: z.string().nullable() }).openapi("BrowseStep");
export const InteractionSchema = z.object({ id: z.number().int(), at: z.string(), kind: interactionKind, origin: z.string(), remote_id: z.string(), version: z.number().int().nullable(), own_item_id: z.string().nullable(), own_version: z.number().int().nullable(), hopper_id: z.string().nullable(), hopper_name: z.string().nullable(), backfilled: z.number().int(), subscription_id: z.string().nullable(), label: z.string().nullable() }).openapi("Interaction");
export const ThumbSchema = z.object({ thumb: z.union([z.literal(1), z.literal(-1)]), at: z.string(), origin: z.string(), remote_id: z.string(), subscription_id: z.string().nullable(), label: z.string().nullable() }).openapi("Thumb");
/** The model manifest for Settings (0.26.0): which models exist, and which providers have a key. Never a key's value. */
export const AiModelsSchema = z.object({
  providers: z.array(z.object({
    id: z.string(),
    label: z.string(),
    key_secret: z.string().optional().describe("The Worker secret holding this provider's key. Absent for a Workers AI provider (it uses `binding`) and for a keyless OpenAI-compatible endpoint."),
    binding: z.string().optional().describe("Workers AI only: the Worker binding the provider calls (studio#8)."),
    configured: z.boolean().describe("The key secret is set, the binding is bound, or the provider needs neither."),
  })),
  models: z.array(z.object({ id: z.string(), provider: z.string(), label: z.string(), note: z.string().optional(), kind: z.literal("decision").optional().describe("A decision model (Clef, Jev): offered only for the change classifier (ai_model_classify), never for text generation.") })),
  local: z.boolean(),
}).openapi("AiModels");
const readVersion = z.number().int().min(1).max(READ_VERSION_MAX);
const readAt = z.iso.datetime({ offset: true }).optional().describe("When the client read it (ISO-8601). A read earlier than the row's latest clear is ignored; omitted, the read always applies.");
const readId = z.string().min(1).max(READ_ID_MAX);
const readMark = z.object({ sub: readId, remote_id: readId, version: readVersion, read_at: readAt }).strict();
const unreadMark = z.object({ sub: readId, remote_id: readId }).strict();
const counts = z.object({ all: z.number(), own: z.number(), subscriptions: z.record(z.string(), z.number()) });


export const routes = {
  getCapabilities: route('getCapabilities', authenticatedOperation, 'get', '/capabilities', z.object({
    contractVersion: z.string(),
    endpoints: z.object({ publicBase: z.string(), studio: z.string(), api: z.string(), issuer: z.string(), mcp: z.string(), media: z.string() }),
    operations: z.array(z.string()),
    extensions: z.array(z.object({ name: z.string(), declared: z.boolean(), compiled: z.boolean(), enabled: z.boolean(), granted: z.boolean() })),
  }).openapi('Capabilities')),
  getChanges: route('getChanges', readOperation(), 'get', '/changes', z.object({ epoch: z.string().min(1), domains: z.object(Object.fromEntries(CHANGE_DOMAINS.map(domain => [domain, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])) as Record<typeof CHANGE_DOMAINS[number], z.ZodNumber>) }).openapi('ChangeState')),
  createItem: route("createItem", draftOperation({"writes":["items"],"network":true}), "post", "/items", created, ItemCreateSchema, 201, undefined, true),
  updateItem: route("updateItem", draftOperation({"writes":["items","presentation"],"destructive":true}, 'write', presentationScopes), "patch", "/items/{id}", ItemSchema, ItemEditSchema.extend({ expectedRevision: ItemRevisionSchema })),
  publishItem: route("publishItem", publishOperation({"writes":["items","publication","mentions"],"destructive":true,"network":true,"background":true}), "post", "/items/{id}/publish", ok.extend({ revision: ItemRevisionSchema, version: z.number(), warning: z.string().optional() }), note.extend({ note_generated: z.boolean().optional(), change_category: changeCategory.nullable().optional().describe("The change category the author confirmed in the publish dialog: kept with the version in studio-private storage (never on the wire). Omitted: a classification made for these words stands; null: cleared.") }), 200),
  classifyChange: route("classifyChange", draftOperation({"writes":["changeClass"],"destructive":true,"network":true}), "post", "/items/{id}/classify", z.object({ revision: ItemRevisionSchema, version: z.number().int().describe("The version the working copy would publish as."), category: changeCategory.nullable().describe("Null when no category could be had; see reason."), model: z.string().nullable().describe("The decision model that answered; null for refresh, decided locally from content_hash."), probability: z.number().nullable(), reason: z.string().optional().describe("Why there is no category: a provider error, an exhausted AI budget, or an unusable answer. Never fatal: publish as usual.") }), condition),
  draftNote: route("draftNote", draftOperation({"writes":[],"network":true}), "post", "/items/{id}/note-draft", z.object({ note: z.string(), model: z.string(), pinned_prior: z.boolean(), revision: ItemRevisionSchema }), condition),
  generateItem: route("generateItem", draftOperation({"writes":["items"],"destructive":true,"network":true}), "post", "/items/{id}/generate", z.object({ text: z.string(), model: z.string(), content_md: z.string(), revision: ItemRevisionSchema }), condition.extend({ scope: z.number().int().min(0) })),
  withdrawItem: route("withdrawItem", publishOperation({"writes":["items","publication","mentions"],"destructive":true,"network":true,"background":true}), "post", "/items/{id}/withdraw", ok.extend({ revision: ItemRevisionSchema, version: z.number() }), note, 200),
  pinItem: route("pinItem", publishOperation({"writes":["publication"]}), "put", "/items/{id}/versions/{version}/pin", ok.extend({ revision: ItemRevisionSchema, version: z.number(), already: z.boolean() }), condition),
  restoreItem: route("restoreItem", draftOperation({"writes":["items","media"],"destructive":true}), "post", "/items/{id}/restore", ok.extend({ revision: ItemRevisionSchema, restored: z.number(), publishesAs: z.number() }), version),
  deleteItem: route("deleteItem", draftOperation({"writes":["items","media"],"destructive":true}), "delete", "/items/{id}", ok.extend({ outcome: z.literal("discarded") }), condition),
  uploadMedia: createRoute({ ...route("uploadMedia", { ...draftOperation({"writes":["media"]}), scopeNotes: 'Attaching new media to a published item also requires owner:publish. Returning an existing duplicate does not.' }, "post", "/media", z.object({ id: z.string(), url: z.string(), mime: z.string(), revision: ItemRevisionSchema.optional() }), undefined, 201), request: { body: { required: true, content: { "multipart/form-data": { schema: z.object({ file: z.custom<File>((value) => value instanceof File, "file field required (multipart)").openapi({ type: "string", format: "binary" }), item_id: z.string().optional(), expectedRevision: z.coerce.number().pipe(ItemRevisionSchema).optional(), alt: z.string().optional(), inline: z.enum(["true", "false"]).optional() }) } } } } }),
  deleteMedia: route("deleteMedia", publishOperation({"writes":["media","presentation"],"destructive":true}), "delete", "/media/{id}", ok.extend({ outcome: z.enum(["deleted", "detached"]), revision: ItemRevisionSchema.optional() }), condition.partial()),
  updateSettings: route("updateSettings", manageOperation({"writes":["settings","presentation","media"],"destructive":true}, avatarScopes), "patch", "/settings", SettingsSchema, settingsBody),
  createSubscription: route("createSubscription", manageOperation({"writes":["subscriptions","imports"],"network":true,"background":true}), "post", "/subscriptions", confirmation, z.object({ url: z.string(), confirm: z.boolean().optional(), title: z.string().optional(), backfill: z.boolean().optional().describe("With confirm: start importing the archive at once (true, the default). false creates the subscription only; the next quarter-hour poll imports it, since a never-polled subscription is always due. For bulk imports such as OPML.") })),
  updateSubscription: route("updateSubscription", manageOperation({"writes":["subscriptions","presentation"],"destructive":true}), "patch", "/subscriptions/{id}", SubscriptionSchema, z.object({ in_blogroll: z.boolean().optional(), title: z.string().trim().min(1).nullable().optional().describe("A name of your own; null hands the name back to the source, refreshed while polling."), paused: z.boolean().optional() }).strict()),
  pollAllSubscriptions: route("pollAllSubscriptions", manageOperation({"writes":["subscriptions","imports"],"network":true,"background":true}), "post", "/subscriptions/poll", z.object({ polling: z.number().int().nonnegative() })),
  resyncSubscription: route("resyncSubscription", manageOperation({"writes":["subscriptions","imports"],"network":true}), "post", "/subscriptions/{id}/resync", ok.extend({ changed: z.number() })),
  deleteSubscription: route("deleteSubscription", manageOperation({"writes":["subscriptions","imports","hoppers","signals","readingState"],"destructive":true}), "delete", "/subscriptions/{id}", ok),
  createHopper: route("createHopper", manageOperation({"writes":["hoppers"]}), "post", "/hoppers", HopperSchema, z.object({ name: z.string() }), 201),
  updateHopper: route("updateHopper", manageOperation({"writes":["hoppers","presentation"],"destructive":true}), "patch", "/hoppers/{id}", HopperSchema, z.object({ name: z.string().trim().min(1).optional(), public: z.boolean().optional(), description: z.string().trim().max(280).optional() }).strict()),
  deleteHopper: route("deleteHopper", manageOperation({"writes":["hoppers","presentation"],"destructive":true}), "delete", "/hoppers/{id}", ok),
  // sub "~own" with remoteId = an item id puts one of the owner's own items in the hopper (session 47).
  addHopperItem: route("addHopperItem", manageOperation({"writes":["hoppers","presentation"]}), "put", "/hoppers/{id}/items/{sub}/{remoteId}", ok),
  removeHopperItem: route("removeHopperItem", manageOperation({"writes":["hoppers","presentation"],"destructive":true}), "delete", "/hoppers/{id}/items/{sub}/{remoteId}", ok),
  setSignal: route("setSignal", manageOperation({"writes":["signals"],"destructive":true}), "put", "/signals/{sub}/{remoteId}", ok, z.object({ thumb: z.union([z.literal(1), z.literal(-1)]) })),
  deleteSignal: route("deleteSignal", manageOperation({"writes":["signals"],"destructive":true}), "delete", "/signals/{sub}/{remoteId}", ok),
  markRead: route("markRead", readingStateOperation({"writes":["readingState"]}), "put", "/reading/{sub}/{remoteId}/read", ok.extend({ stored: z.boolean(), read_version: z.number().int().nullable() }), z.object({ version: readVersion, read_at: readAt })),
  markUnread: route("markUnread", readingStateOperation({"writes":["readingState"],"destructive":true}), "delete", "/reading/{sub}/{remoteId}/read", ok.extend({ stored: z.literal(false), read_version: z.null() })),
  markReadBatch: route("markReadBatch", readingStateOperation({"writes":["readingState"]}), "post", "/reading/read", ok.extend({ received: z.number().int().nonnegative() }), z.object({ items: z.array(readMark).max(READ_BATCH_MAX) })),
  markUnreadBatch: route("markUnreadBatch", readingStateOperation({"writes":["readingState"],"destructive":true}), "post", "/reading/unread", ok.extend({ received: z.number().int().nonnegative() }), z.object({ items: z.array(unreadMark).max(READ_BATCH_MAX) })),
  updateMention: route("updateMention", manageOperation({"writes":["mentions","presentation"],"destructive":true}), "patch", "/mentions/{id}", ok.extend({ hidden: z.boolean() }), z.object({ hidden: z.boolean() })),
  listItems: route("listItems", readOperation(), "get", "/items", z.object({ items: z.array(ItemSchema.extend({ pins: z.array(z.object({ version: z.number().int().positive(), kind: z.enum(["fragment", "thread"]) })).optional() })), total: z.number(), offset: z.number(), limit: z.number() }), undefined, 200, page),
  getItem: route("getItem", readOperation(), "get", "/items/{id}", z.object({ ...ItemSchema.shape, authored_kind: z.enum(["fragment", "thread"]), media: z.array(MediaSchema).describe("The working copy's attachments: what the next version lists."), published_media: z.array(MediaSchema).describe("What the live version lists, including attachments removed from the working copy since (studio#7)."), versions: z.array(VersionSchema), published: z.union([VersionSchema, z.null()]) })),
  getSettings: route("getSettings", readOperation(), "get", "/settings", SettingsSchema),
  listSubscriptions: route("listSubscriptions", readOperation(), "get", "/subscriptions", collection(SubscriptionSchema), undefined, 200, page),
  getSubscription: route("getSubscription", readOperation(), "get", "/subscriptions/{id}", SubscriptionSchema),
  listHoppers: route("listHoppers", readOperation(), "get", "/hoppers", collection(HopperSchema), undefined, 200, page),
  getHopper: route("getHopper", readOperation(), "get", "/hoppers/{id}", z.object({ hopper: HopperSchema, memberships: z.array(HopperItemRowSchema), items: z.array(ImportedItemSchema), total: z.number().int().nonnegative(), source_count: z.number().int().nonnegative() }), undefined, 200, z.object({ preview: z.literal("true").optional() })),
  listSignals: route("listSignals", readOperation(), "get", "/signals", collection(SignalRowSchema), undefined, 200, page),
  listInteractions: route("listInteractions", readOperation(), "get", "/interactions", collection(InteractionSchema), undefined, 200, page.extend({ kind: interactionKind.optional() })),
  listThumbs: route("listThumbs", readOperation(), "get", "/thumbs", z.object({ items: z.array(ThumbSchema) })),
  getAiModels: route("getAiModels", readOperation(), "get", "/ai/models", AiModelsSchema),
  listMentions: route("listMentions", readOperation(), "get", "/mentions", collection(z.union([MentionSchema, MentionOutRowSchema])).extend({ direction: z.enum(["inbound", "outbound"]) }), undefined, 200, page.extend({ direction: z.enum(["inbound", "outbound"]).optional() })),
  preview: route("preview", draftOperation({"writes":[]}, 'read'), "post", "/preview", preview, z.object({ content_md: z.string().optional(), item_id: z.string().optional(), kind: z.enum(["fragment", "thread"]).optional() })),
  search: route("search", readOperation(), "get", "/search", z.object({ items: z.array(z.object({ id: z.string(), excerpt: z.string(), label: z.string().openapi({ description: "The text a `[[id]]` link to this item shows: its opening heading, else a short quoted excerpt. Written as the label by the picker (0.4 §10.1)." }), version: z.number(), updated: z.string(), badge: z.string(), source: z.enum(["mine", "imported"]), kind: z.enum(["fragment", "thread"]), subscription_id: z.string().nullable(), source_title: z.string().nullable() })), total: z.number(), offset: z.number(), limit: z.number() }), undefined, 200, page.extend({ q: z.string().optional(), source: z.enum(["all", "mine", "imported"]).optional(), sub: z.string().optional(), sort: z.enum(["newest", "oldest"]).optional() })),
  getVersion: route("getVersion", readOperation(), "get", "/items/{id}/versions/{v}", VersionSchema),
  listReading: route("listReading", readOperation(), "get", "/reading", z.object({ items: z.array(ReadingEntrySchema), counts, total: z.number(), offset: z.number(), limit: z.number(), selected: z.string(), read_state: z.literal(true).describe("This server stores read state: each imported entry's readVersion is meaningful."), read_state_clear: z.literal(true).describe("Read state can be cleared: DELETE /reading/{sub}/{remoteId}/read, POST /reading/unread, and read_at on reads.") }), undefined, 200, page.extend({ limit: z.coerce.number().int().min(1).max(50).optional(), sub: z.string().optional(), kind: z.enum(["thread", "fragment"]).optional(), background: z.enum(["true"]).optional().describe("Only withdrawn items (the Background lens). Without it, withdrawn items are left out.") })),
  listImportedReading: route("listImportedReading", readOperation(), "get", "/reading/imported", z.object({ items: z.array(ImportedReadingEntrySchema), next: z.string().nullable().describe("Pass as cursor for the next page; null on the last page."), limit: z.number().int().positive() }), undefined, 200, z.object({ cursor: readingCursor.optional(), limit: z.coerce.number().int().min(1).max(IMPORTED_READING_MAX).optional() })),
  getImportedItem: route("getImportedItem", readOperation(), "get", "/imports/{sub}/{id}", ImportedItemSchema),
  getImportedHistory: route("getImportedHistory", readOperation({"writes":[],"network":true}), "get", "/imports/{sub}/{id}/history", z.object({ current: z.number().int(), withdrawn: z.boolean(), changelog: z.array(z.object({ version: z.number().int(), at: z.string(), note: z.string().nullable(), pinned: z.boolean(), generated: z.boolean() })) })),
  getImportedVersion: route("getImportedVersion", readOperation({"writes":[],"network":true}), "get", "/imports/{sub}/{id}/versions/{v}", z.object({ version: z.number().int(), content_md: z.string(), note: z.string().nullable(), pinned: z.boolean() })),
  // Following a link out of an entry (0.49.0): the item fetched from its own blyg, which
  // links in an entry name a blyg item, and the owner's private browsing path.
  peekItem: route("peekItem", readOperation({"writes":[],"network":true}), "get", "/peek", PeekItemSchema, undefined, 200, z.object({ origin: z.string(), id: z.string() })),
  classifyLinks: route("classifyLinks", readOperation({"writes":["cache"],"network":true}, 'write'), "post", "/peek/links", z.object({ links: z.array(z.object({ url: z.string(), target: z.union([z.object({ origin: z.string(), id: z.string() }), z.null()]) })) }), z.object({ urls: z.array(z.string().max(2048)).max(CLASSIFY_MAX) })),
  listBrowse: route("listBrowse", readOperation(), "get", "/browse", collection(BrowseStepSchema), undefined, 200, page.extend({ trail: z.string().optional() })),
  logBrowse: route("logBrowse", readingStateOperation({"writes":["browse"]}), "post", "/browse", z.object({ id: z.number().int() }), z.object({ trail: z.string().min(8).max(64), parent_id: z.number().int().nullable().optional(), origin: z.string().min(1).max(2048), remote_id: z.string().min(1).max(256), version: z.number().int().positive().nullable().optional(), via: z.enum(BROWSE_VIA), title: z.string().max(400).nullable().optional() }), 201),
  clearBrowse: route("clearBrowse", readingStateOperation({"writes":["browse"],"destructive":true}), "delete", "/browse", ok, undefined, 200, z.object({ trail: z.string().optional() })),
  getUpdateState: route("getUpdateState", readOperation({"writes":["settings"],"network":true,"background":true}), "get", "/update-state", z.record(z.string(), z.string())),
  getMentionSource: route("getMentionSource", readOperation(), "get", "/mentions/{id}/source", z.object({ holder: z.string().nullable(), subscription: z.union([SubscriptionSchema, z.null()]) })),
  listStaleThreads: route("listStaleThreads", readOperation(), "get", "/freshness", z.object({ items: z.array(ThreadFreshnessSchema) })),
  getItemFreshness: route("getItemFreshness", readOperation({"writes":[],"network":true}), "get", "/items/{id}/freshness", ThreadFreshnessSchema, undefined, 200, z.object({ probe: z.enum(["true", "false"]).optional() })),
  refreshItem: route("refreshItem", publishOperation({"writes":["items","publication","subscriptions","imports","mentions"],"destructive":true,"network":true,"background":true}), "post", "/items/{id}/refresh", ok.extend({ revision: ItemRevisionSchema, version: z.number(), refreshed: z.array(z.string()), resynced: z.number().int().nonnegative(), warning: z.string().optional() }), note, 200),
  getForkOptions: route("getForkOptions", readOperation({"writes":[],"network":true}), "get", "/fork-options", z.object({ origin: z.string(), ourOrigin: z.string(), versions: z.array(z.object({ version: z.number(), at: z.string(), note: z.string().nullable() })), error: z.string().optional() }), undefined, 200, z.object({ id: z.string(), sub: z.string().optional(), origin: z.string().optional() })),
  // Read routes contributed by the extensions in this repository (extensions/catalog.ts).
  ...extensionRoutes,
};
// An identical file uploaded again to the same item returns the existing row (studio#7).
routes.uploadMedia.responses[200] = { description: "Already attached", content: json(z.object({ id: z.string(), url: z.string(), mime: z.string(), duplicate: z.literal(true), revision: ItemRevisionSchema.optional() })) };
// The resolve/confirm operation has two successful response shapes and statuses.
routes.createSubscription.responses[201] = { description: "Subscribed", content: json(subscribed) };
