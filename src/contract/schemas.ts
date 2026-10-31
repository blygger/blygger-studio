import { z } from "@hono/zod-openapi";

export const ItemRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const ItemRowSchema = z.object({
  id: z.string(),
  revision: ItemRevisionSchema,
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
  kind: z.enum(["fragment", "thread", "withdrawn"]).nullable(),
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
