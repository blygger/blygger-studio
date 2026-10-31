import { INTERACTION_KINDS, type InteractionView, type listThumbs } from '../interactions.ts';
import { BROWSE_VIA, type BrowseRow } from '../browse-log.ts';
import { versionState } from '../version-state.ts';
import { z } from '@hono/zod-openapi';
import { ItemRevisionSchema } from './schemas.ts';
import { CHANGE_CATEGORIES } from '../change-category.ts';
import type { ItemRow, VersionRow, MediaRow, SubscriptionRow, HopperRow, ImportedItemRow, MentionInRow, MentionOutRow, HopperItemRow, SignalRow } from '../types.ts';

export const CitationSchema = z.object({ source: z.string(), author: z.string().optional(), excerpt: z.string().optional(), url: z.string(), retrieved: z.string() }).openapi("Citation");
export const VersionReferenceSchema = z.object({ origin: z.string().url(), id: z.string().min(1), version: z.number().int().positive(), cited: CitationSchema.optional() }).strict().openapi("VersionReference");
export const StubSchema = z.union([VersionReferenceSchema, z.object({ url: z.string().url(), cited: CitationSchema.optional() }).strict()]).openapi("CitationTarget");
export const GenerationSourceSchema = z.object({ id: z.string(), version: z.number().int().positive(), origin: z.string().optional().describe("Present for a remote source (0.4, §5.7); omitted for this blyg's own."), cited: CitationSchema.optional() }).openapi("GenerationSource");
export const ProvenanceSchema = z.object({ sources: z.array(GenerationSourceSchema), model: z.string().optional(), at: z.string().optional() }).passthrough().openapi("GenerationProvenance");
export const TransclusionSchema = z.object({ id: z.string(), version: z.number().int().positive(), origin: z.string().optional(), cited: CitationSchema.optional(), selector: z.object({ exact: z.string(), prefix: z.string().optional(), suffix: z.string().optional() }).optional() }).openapi("Transclusion");
/** Remote protocol data remains remote data, including members this client does not know. */
const RemoteObjectSchema = z.record(z.string(), z.unknown());
export const ChangeClassSchema = z.object({ category: z.enum(CHANGE_CATEGORIES).nullable(), model: z.string().nullable(), probability: z.number().nullable(), classifiedAt: z.string(), overridden: z.boolean() }).openapi('ChangeClass');

export const ItemSchema = z.object({
  id: z.string(),
  revision: ItemRevisionSchema,
  kind: z.enum(["fragment", "thread"]),
  status: z.enum(["draft", "public", "withdrawn"]),
  created: z.string(),
  updated: z.string(),
  version: z.number(),
  contentMd: z.string(),
  dirty: z.boolean(),
  stubOf: z.union([StubSchema, z.null()]),
  forkedFrom: z.union([VersionReferenceSchema, z.null()]),
  forkCite: z.union([CitationSchema, z.null()]),
  provenance: z.array(z.union([ProvenanceSchema, z.null()])),
  responses: z.enum(["default", "show", "hide"]),
  highlight: z.enum(["default", "show", "hide"]),
}).openapi("Item");

export const VersionSchema = z.object({
  kind: z.enum(["fragment", "thread", "withdrawn"]),
  itemId: z.string(),
  version: z.number(),
  contentMd: z.string(),
  contentHtml: z.string(),
  contentHash: z.string(),
  publishedAt: z.string(),
  note: z.string().nullable(),
  transclusions: z.array(TransclusionSchema),
  pinned: z.boolean(),
  pinnedAt: z.string().nullable(),
  stubOf: z.union([StubSchema, z.null()]),
  stubCite: z.union([CitationSchema, z.null()]),
  noteGenerated: z.boolean(),
  generated: z.array(ProvenanceSchema),
  changeClass: z.union([ChangeClassSchema, z.null()]).optional(),
}).openapi("Version");

export const MediaSchema = z.object({
  id: z.string(),
  itemId: z.string().nullable(),
  mime: z.string(),
  alt: z.string().nullable(),
  created: z.string(),
  inline: z.boolean(),
  url: z.url(),
}).openapi("Media");

export const SubscriptionSchema = z.object({
  id: z.string(),
  kind: z.enum(["blyg", "rss"]),
  origin: z.string(),
  feedUrl: z.string(),
  title: z.string(),
  status: z.enum(["active", "paused", "degraded"]),
  lastPollAt: z.string().nullable(),
  failCount: z.number(),
  lastIndexSyncAt: z.string().nullable(),
  inBlogroll: z.boolean(),
  flags: z.array(z.object({ type: z.string(), at: z.string(), detail: z.string().optional() })),
  created: z.string(),
  titleFollowsSource: z.boolean(),
}).openapi("Subscription");

export const HopperSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable(),
  public: z.boolean(),
  created: z.string(),
  slugFrozen: z.boolean(),
  description: z.string().nullable(),
}).openapi("Hopper");

export const ImportedItemSchema = z.object({
  subscriptionId: z.string(),
  remoteId: z.string(),
  kind: z.enum(["fragment", "thread"]),
  state: z.enum(["current", "tombstone"]),
  version: z.number(),
  created: z.string().nullable(),
  updated: z.string().nullable(),
  observedAt: z.string(),
  contentMd: z.string(),
  contentHtml: z.string(),
  contentHash: z.string().nullable(),
  l0: z.boolean(),
  pinnedVersionRetained: z.number().nullable(),
  page: z.string().nullable(),
  author: z.union([RemoteObjectSchema, z.null()]),
  media: z.array(z.unknown()).nullable(),
  transclusions: z.array(z.unknown()).nullable(),
  stubOf: z.union([RemoteObjectSchema, z.null()]),
  forkedFrom: z.union([RemoteObjectSchema, z.null()]),
  generated: z.array(z.unknown()).nullable(),
}).openapi("ImportedItem");

export const MentionSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  targetItemId: z.string(),
  status: z.enum(["pending", "verified", "failed", "gone"]),
  relation: z.enum(["stub", "transclusion", "fork", "source"]).nullable(),
  sourceOrigin: z.string().nullable(),
  sourceId: z.string().nullable(),
  sourceKind: z.string().nullable(),
  sourceVersion: z.number().nullable(),
  sourcePage: z.string().nullable(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  verifiedAt: z.string().nullable(),
  attempts: z.number(),
  error: z.string().nullable(),
  hidden: z.boolean(),
  sourceAuthor: z.union([RemoteObjectSchema, z.null()]),
}).openapi("Mention");

export const OutboundMentionSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  version: z.number(),
  targetVersion: z.number().nullable(),
  target: z.string(),
  endpoint: z.string().nullable(),
  status: z.enum(["pending", "sent", "failed", "no_endpoint"]),
  attempts: z.number(),
  nextAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  created: z.string(),
}).openapi("OutboundMention");

export const HopperMembershipSchema = z.object({
  hopperId: z.string(),
  subscriptionId: z.string(),
  remoteId: z.string(),
  addedAt: z.string(),
}).openapi("HopperMembership");

export const SignalSchema = z.object({
  subscriptionId: z.string(),
  remoteId: z.string(),
  thumb: z.union([z.literal(1), z.literal(-1)]),
  at: z.string(),
}).openapi("Signal");

/** Parse damaged columns independently without changing stored or remote bytes. */
function stored<T>(value: string | null, schema: z.ZodType<T>, fallback: T): T {
  if (value === null) return fallback;
  try { const parsed = schema.safeParse(JSON.parse(value)); return parsed.success ? parsed.data : fallback; }
  catch { return fallback; }
}
const overrideMode = (value: number | null | undefined) => value == null ? 'default' : value === 1 ? 'show' : 'hide';
export const mediaUrl = (key: string, publicBase: string) => `${publicBase}/${key}`;

export const itemResource = (row: ItemRow, kind: "fragment" | "thread") => ItemSchema.parse({
  id: row.id,
  revision: row.revision,
  kind: kind,
  status: row.status,
  created: row.created,
  updated: row.updated,
  version: row.version,
  contentMd: row.content_md,
  dirty: row.dirty === 1,
  stubOf: stored(row.stub_of, ItemSchema.shape.stubOf, null),
  forkedFrom: stored(row.forked_from, ItemSchema.shape.forkedFrom, null),
  forkCite: stored(row.fork_cite, ItemSchema.shape.forkCite, null),
  provenance: stored(row.tk_provenance_json, ItemSchema.shape.provenance, []),
  responses: overrideMode(row.responses_override),
  highlight: overrideMode(row.highlight_override),
});

export const versionResource = (row: VersionRow) => VersionSchema.parse({
  kind: versionState(row),
  itemId: row.item_id,
  version: row.version,
  contentMd: row.content_md,
  contentHtml: row.content_html,
  contentHash: row.content_hash,
  publishedAt: row.published_at,
  note: row.note,
  transclusions: stored(row.transclusions, VersionSchema.shape.transclusions, []),
  pinned: row.pinned === 1,
  pinnedAt: row.pinned_at,
  stubOf: stored(row.stub_of, VersionSchema.shape.stubOf, null),
  stubCite: stored(row.stub_cite, VersionSchema.shape.stubCite, null),
  noteGenerated: row.note_generated === 1,
  generated: stored(row.generated_json, VersionSchema.shape.generated, []),
});

export const mediaResource = (row: MediaRow, publicBase: string) => MediaSchema.parse({
  id: row.id,
  itemId: row.item_id,
  mime: row.mime,
  alt: row.alt,
  created: row.created,
  inline: row.inline === 1,
  url: mediaUrl(row.r2_key, publicBase),
});

export const subscriptionResource = (row: SubscriptionRow) => SubscriptionSchema.parse({
  id: row.id,
  kind: row.kind,
  origin: row.origin,
  feedUrl: row.feed_url,
  title: row.title,
  status: row.status,
  lastPollAt: row.last_poll_at,
  failCount: row.fail_count,
  lastIndexSyncAt: row.last_index_sync_at,
  inBlogroll: row.in_blogroll === 1,
  flags: stored(row.flags, SubscriptionSchema.shape.flags, []),
  created: row.created,
  titleFollowsSource: row.title_auto !== 0,
});

export const hopperResource = (row: HopperRow) => HopperSchema.parse({
  id: row.id,
  name: row.name,
  slug: row.slug,
  public: row.public === 1,
  created: row.created,
  slugFrozen: row.slug_frozen === 1,
  description: row.description,
});

export const importedResource = (row: ImportedItemRow) => ImportedItemSchema.parse({
  subscriptionId: row.subscription_id,
  remoteId: row.remote_id,
  kind: row.kind,
  state: row.state,
  version: row.version,
  created: row.created,
  updated: row.updated,
  observedAt: row.observed_at,
  contentMd: row.content_md,
  contentHtml: row.content_html,
  contentHash: row.content_hash,
  l0: row.l0 === 1,
  pinnedVersionRetained: row.pinned_version_retained,
  page: row.page,
  author: stored(row.author_json, ImportedItemSchema.shape.author, null),
  media: stored(row.media_json, ImportedItemSchema.shape.media, null),
  transclusions: stored(row.transclusions_json, ImportedItemSchema.shape.transclusions, null),
  stubOf: stored(row.stub_of_json, ImportedItemSchema.shape.stubOf, null),
  forkedFrom: stored(row.forked_from_json, ImportedItemSchema.shape.forkedFrom, null),
  generated: stored(row.generated_json, ImportedItemSchema.shape.generated, null),
});

export const mentionResource = (row: MentionInRow) => MentionSchema.parse({
  id: row.id,
  source: row.source,
  target: row.target,
  targetItemId: row.target_item_id,
  status: row.status,
  relation: row.relation,
  sourceOrigin: row.source_origin,
  sourceId: row.source_id,
  sourceKind: row.source_kind,
  sourceVersion: row.source_version,
  sourcePage: row.source_page,
  firstSeen: row.first_seen,
  lastSeen: row.last_seen,
  verifiedAt: row.verified_at,
  attempts: row.attempts,
  error: row.error,
  hidden: row.hidden === 1,
  sourceAuthor: stored(row.source_author_json, MentionSchema.shape.sourceAuthor, null),
});

export const outboundMentionResource = (row: MentionOutRow) => OutboundMentionSchema.parse({
  id: row.id,
  itemId: row.item_id,
  version: row.version,
  targetVersion: row.target_version,
  target: row.target,
  endpoint: row.endpoint,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  lastError: row.last_error,
  created: row.created,
});

export const membershipResource = (row: HopperItemRow) => HopperMembershipSchema.parse({
  hopperId: row.hopper_id,
  subscriptionId: row.subscription_id,
  remoteId: row.remote_id,
  addedAt: row.added_at,
});

export const signalResource = (row: SignalRow) => SignalSchema.parse({
  subscriptionId: row.subscription_id,
  remoteId: row.remote_id,
  thumb: row.thumb,
  at: row.at,
});

export const InteractionSchema = z.object({ id: z.number().int(), at: z.string(), kind: z.enum(INTERACTION_KINDS), origin: z.string(), remoteId: z.string(), version: z.number().int().nullable(), ownItemId: z.string().nullable(), ownVersion: z.number().int().nullable(), hopperId: z.string().nullable(), hopperName: z.string().nullable(), backfilled: z.boolean(), subscriptionId: z.string().nullable(), label: z.string().nullable() }).openapi("Interaction");

export const ThumbSchema = z.object({ thumb: z.union([z.literal(1), z.literal(-1)]), at: z.string(), origin: z.string(), remoteId: z.string(), subscriptionId: z.string().nullable(), label: z.string().nullable() }).openapi("Thumb");

export const BrowseStepSchema = z.object({ id: z.number().int(), at: z.string(), trail: z.string(), parentId: z.number().int().nullable(), origin: z.string(), remoteId: z.string(), version: z.number().int().nullable(), via: z.enum(BROWSE_VIA), title: z.string().nullable() }).openapi("BrowseStep");

export const interactionResource = (row: InteractionView) => InteractionSchema.parse({
  id: row.id, at: row.at, kind: row.kind, origin: row.origin, remoteId: row.remote_id,
  version: row.version, ownItemId: row.own_item_id, ownVersion: row.own_version,
  hopperId: row.hopper_id, hopperName: row.hopper_name, backfilled: row.backfilled === 1,
  subscriptionId: row.subscription_id, label: row.label,
});
export const thumbResource = (row: Awaited<ReturnType<typeof listThumbs>>[number]) => ThumbSchema.parse({
  thumb: row.thumb, at: row.at, origin: row.origin, remoteId: row.remote_id,
  subscriptionId: row.subscription_id, label: row.label,
});
export const browseResource = (row: BrowseRow) => BrowseStepSchema.parse({
  id: row.id, at: row.at, trail: row.trail, parentId: row.parent_id, origin: row.origin,
  remoteId: row.remote_id, version: row.version, via: row.via, title: row.title,
});
