import { z } from "@hono/zod-openapi";

export const ItemRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["fragment", "thread", "withdrawn"]),
  status: z.enum(["draft", "public", "withdrawn"]),
  created: z.string(),
  updated: z.string(),
  version: z.number(),
  content_md: z.string(),
  dirty: z.number(),
  tk_provenance_json: z.string().nullable(),
  show_responses: z.number(),
  responses_override: z.number().nullable(),
  highlight_override: z.number().nullable(),
  stub_of: z.string().nullable(),
  forked_from: z.string().nullable(),
  fork_cite: z.string().nullable(),
}).openapi("ItemRow");

export const VersionRowSchema = z.object({
  item_id: z.string(),
  version: z.number(),
  content_md: z.string(),
  content_html: z.string(),
  content_hash: z.string(),
  published_at: z.string(),
  note: z.string().nullable(),
  transclusions: z.string().nullable(),
  pinned: z.number(),
  pinned_at: z.string().nullable(),
  generated_json: z.string().nullable(),
  stub_of: z.string().nullable(),
  stub_cite: z.string().nullable(),
  note_generated: z.number(),
}).openapi("VersionRow");

export const MediaRowSchema = z.object({
  id: z.string(),
  item_id: z.string().nullable(),
  r2_key: z.string(),
  mime: z.string(),
  alt: z.string().nullable(),
  created: z.string(),
  inline: z.number(),
}).openapi("MediaRow");

export const SubscriptionRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["blyg", "rss"]),
  origin: z.string(),
  feed_url: z.string(),
  title: z.string(),
  status: z.enum(["active", "paused", "degraded"]),
  etag: z.string().nullable(),
  last_modified: z.string().nullable(),
  last_poll_at: z.string().nullable(),
  newest_guid: z.string().nullable(),
  fail_count: z.number(),
  last_index_sync_at: z.string().nullable(),
  in_blogroll: z.number(),
  flags: z.string(),
  created: z.string(),
  title_auto: z.number(),
}).openapi("SubscriptionRow");

export const ImportedItemRowSchema = z.object({
  subscription_id: z.string(),
  remote_id: z.string(),
  kind: z.enum(["fragment", "thread"]),
  state: z.enum(["current", "tombstone"]),
  version: z.number(),
  created: z.string().nullable(),
  updated: z.string().nullable(),
  observed_at: z.string(),
  content_md: z.string(),
  content_html: z.string(),
  content_hash: z.string().nullable(),
  author_json: z.string().nullable(),
  media_json: z.string().nullable(),
  transclusions_json: z.string().nullable(),
  l0: z.number(),
  pinned_version_retained: z.number().nullable(),
  page: z.string().nullable(),
  stub_of_json: z.string().nullable(),
  forked_from_json: z.string().nullable(),
}).openapi("ImportedItemRow");

export const HopperRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable(),
  public: z.number(),
  created: z.string(),
  slug_frozen: z.number(),
  description: z.string().nullable(),
}).openapi("HopperRow");

export const HopperItemRowSchema = z.object({
  hopper_id: z.string(),
  subscription_id: z.string(),
  remote_id: z.string(),
  added_at: z.string(),
}).openapi("HopperItemRow");

export const SignalRowSchema = z.object({
  subscription_id: z.string(),
  remote_id: z.string(),
  thumb: z.union([z.literal(1), z.literal(-1)]),
  at: z.string(),
}).openapi("SignalRow");

export const MentionInRowSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  target_item_id: z.string(),
  status: z.enum(["pending", "verified", "failed", "gone"]),
  relation: z.enum(["stub", "transclusion", "fork"]).nullable(),
  source_origin: z.string().nullable(),
  source_id: z.string().nullable(),
  source_kind: z.string().nullable(),
  source_version: z.number().nullable(),
  source_author_json: z.string().nullable(),
  source_page: z.string().nullable(),
  first_seen: z.string(),
  last_seen: z.string(),
  verified_at: z.string().nullable(),
  attempts: z.number(),
  error: z.string().nullable(),
  hidden: z.number(),
}).openapi("MentionInRow");

export const MentionOutRowSchema = z.object({
  id: z.string(),
  item_id: z.string(),
  version: z.number(),
  target_version: z.number().nullable(),
  target: z.string(),
  endpoint: z.string().nullable(),
  status: z.enum(["pending", "sent", "failed", "no_endpoint"]),
  attempts: z.number(),
  next_attempt_at: z.string().nullable(),
  last_error: z.string().nullable(),
  created: z.string(),
}).openapi("MentionOutRow");

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a #rrggbb colour");
/** An author-defined palette: the same nine values as a preset theme. Colours only. */
export const CustomThemeSchema = z.object({
  dark: z.boolean(),
  page: hexColor,
  paper: hexColor,
  ink: hexColor,
  inkSoft: hexColor,
  rule: hexColor,
  pencil: hexColor,
  genBg: hexColor,
  genRule: hexColor,
}).strict().openapi("CustomTheme");

export const SettingsSchema = z.object({
  site_title: z.string(),
  theme: z.string(),
  custom_theme: CustomThemeSchema.nullable(),
  custom_theme_dark: CustomThemeSchema.nullable(),
  font: z.string(),
  author_name: z.string(),
  author_url: z.string(),
  author_bio: z.string(),
  author_links: z.array(z.object({ label: z.string(), url: z.string() })),
  site_url: z.string(),
  timezone: z.string(),
  avatar_media_id: z.string(),
  ai_model: z.string(),
  ai_model_tk: z.string(),
  ai_model_changelog: z.string(),
  ai_model_feed: z.string(),
  feed_prompt: z.string(),
  ai_style_prompt: z.string(),
  accept_mentions: z.boolean(),
  update_check: z.boolean(),
  show_responses_default: z.boolean(),
  highlight_generated_default: z.boolean(),
  auto_change_notes: z.boolean(),
  picker_typing: z.enum(["auto", "editor", "panel"]),
  update_feed_url: z.string(),
  update_notice_ack: z.boolean(),
  extensions: z.array(z.string()).describe("Studio extensions enabled on this node (docs/extensions.md). Only names compiled into this build are accepted; every extension starts disabled."),
}).openapi("Settings");
