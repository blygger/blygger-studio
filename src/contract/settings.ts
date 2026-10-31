import { z } from "@hono/zod-openapi";
import { CustomThemeSchema } from "./schemas.ts";

/** Private settings fields are independent of stored column names. */
export const SettingsSchema = z.object({
  siteTitle: z.string(),
  theme: z.string(),
  customTheme: z.union([CustomThemeSchema, z.null()]),
  customThemeDark: z.union([CustomThemeSchema, z.null()]),
  customThemeName: z.string(),
  font: z.string(),
  authorName: z.string(),
  authorUrl: z.string(),
  authorBio: z.string(),
  authorLinks: z.array(z.object({ label: z.string(), url: z.string() })),
  siteUrl: z.string(),
  timezone: z.string(),
  avatarMediaId: z.string(),
  aiModel: z.string(),
  aiModelTk: z.string(),
  aiModelChangelog: z.string(),
  aiModelFeed: z.string(),
  aiModelClassify: z.string().describe("The change classifier's decision model (Clef, Jev); empty, the default, is off. Studio-private: a category reaches readers only as words in a changelog note the author confirms."),
  changeCategoryInNote: z.boolean().describe("Lead the changelog note with the classifier's category, in the publish dialog where the author sees it. Matters only while aiModelClassify is set."),
  feedPrompt: z.string(),
  aiStylePrompt: z.string(),
  acceptMentions: z.boolean(),
  updateCheck: z.boolean(),
  showResponsesDefault: z.boolean(),
  highlightGeneratedDefault: z.boolean(),
  autoChangeNotes: z.boolean(),
  pickerTyping: z.enum(["auto", "editor", "panel"]),
  feedOrder: z.string().describe("The public home page order: an id from feedOrders. pace-layered (the default) and reverse-chronological are core; extensions add orders named <extension>/<id>."),
  frontPage: z.string().describe("A published thread's id shown at the mount root instead of the latest items; empty for the latest items. A front page later withdrawn or deleted falls back to the latest items."),
  postsPath: z.string().describe("Where the latest items live: {mount}/{postsPath}/, served whether or not a front page is set. Lowercase letters, digits and hyphens; names the blyg already uses are refused."),
  linksPosition: z.enum(["bottom", "left", "right"]).describe("Where the links section (main menu) sits on public pages: left (the default) or right is a sidebar on wide screens and a Menu button under the masthead on narrow ones; bottom puts it below the content at every width."),
  linksThreads: z.array(z.string()).describe("Published threads listed first in the links section, in order. A thread later withdrawn is left out."),
  linksExternal: z.array(z.object({ label: z.string(), url: z.string() })).describe("The owner's own links in the links section."),
  linksCollections: z.boolean().describe("List public collections in the links section."),
  linksOpml: z.boolean().describe("Link the blogroll's OPML file in the links section, when the blogroll is not empty."),
  linksBlyggerOrg: z.boolean().describe("Link blygger.org in the links section."),
  linksBlyggerCom: z.boolean().describe("Link blygger.com, the directory of blygs, in the links section."),
  setup: z.enum(["pending", "notice", "done"]).describe("The setup wizard: pending on a fresh install, notice on a node that published before it existed, done once finished or dismissed."),
  defaults: z.record(z.string(), z.unknown()).optional().describe("Read-only: what each setting reads as with nothing stored, for \"reset to default\". siteTitle's default is the title derived from the address; store \"\" to keep it derived."),
  feedOrders: z.array(z.object({ id: z.string(), title: z.string(), description: z.string() })).optional().describe("Read-only: the home page orders this node can use now (core, plus enabled extensions')."),
  updateFeedUrl: z.string(),
  updateNoticeAck: z.boolean(),
  extensions: z.array(z.string()).describe("Studio extensions enabled on this node (docs/extensions.md). Only names compiled into this build are accepted; every extension starts disabled."),
}).openapi("Settings");

/** Explicit boundary map, also used for the defaults dictionary and partial writes. */
export const settingsStorageKeys = {
  "siteTitle": "site_title",
  "theme": "theme",
  "customTheme": "custom_theme",
  "customThemeDark": "custom_theme_dark",
  "customThemeName": "custom_theme_name",
  "font": "font",
  "authorName": "author_name",
  "authorUrl": "author_url",
  "authorBio": "author_bio",
  "authorLinks": "author_links",
  "siteUrl": "site_url",
  "timezone": "timezone",
  "avatarMediaId": "avatar_media_id",
  "aiModel": "ai_model",
  "aiModelTk": "ai_model_tk",
  "aiModelChangelog": "ai_model_changelog",
  "aiModelFeed": "ai_model_feed",
  "aiModelClassify": "ai_model_classify",
  "changeCategoryInNote": "change_category_in_note",
  "feedPrompt": "feed_prompt",
  "aiStylePrompt": "ai_style_prompt",
  "acceptMentions": "accept_mentions",
  "updateCheck": "update_check",
  "showResponsesDefault": "show_responses_default",
  "highlightGeneratedDefault": "highlight_generated_default",
  "autoChangeNotes": "auto_change_notes",
  "pickerTyping": "picker_typing",
  "feedOrder": "feed_order",
  "frontPage": "front_page",
  "postsPath": "posts_path",
  "linksPosition": "links_position",
  "linksThreads": "links_threads",
  "linksExternal": "links_external",
  "linksCollections": "links_collections",
  "linksOpml": "links_opml",
  "linksBlyggerOrg": "links_blygger_org",
  "linksBlyggerCom": "links_blygger_com",
  "setup": "setup",
  "updateFeedUrl": "update_feed_url",
  "updateNoticeAck": "update_notice_ack",
  "extensions": "extensions"
} as const;

export function settingsInput(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settingsStorageKeys).flatMap(([field, stored]) =>
    Object.hasOwn(body, field) ? [[stored, body[field]]] : []));
}
export function settingsFields(settings: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(settingsStorageKeys).flatMap(([field, stored]) =>
    Object.hasOwn(settings, stored) ? [[field, settings[stored]]] : []));
}
