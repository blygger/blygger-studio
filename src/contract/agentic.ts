import { z } from "@hono/zod-openapi";
import { OWN_SUBSCRIPTION } from "../own-subscription.ts";
import { AGENTIC_LIMITS, AGENTIC_PRESENTS, AGENTIC_SECTION_KINDS } from "../agentic-limits.ts";

// The Agentic feed's edition (blygger-spec docs/agentic-feed-plan.md §3–§4): a
// closed set of fields the Studio knows how to draw. Everything an assistant
// writes in words is shown as the assistant's and disclosed as generated.

const reference = {
  sub: z.string().min(1).max(128).describe(`The subscription the entry is held under, or "${OWN_SUBSCRIPTION}" for one of the owner's own items (as Saved names entries).`),
  remoteId: z.string().min(1).max(256).describe("The item's id: the own item's id, else the imported item's remote id."),
};
const words = (max: number, what: string) => z.string().trim().min(1).max(max).optional().describe(`${what} Written by the assistant and shown as its own, disclosed as generated.`);

export const AgenticEntrySchema = z.object({
  sub: reference.sub.optional(),
  remoteId: reference.remoteId.optional(),
  mention: z.string().min(1).max(128).optional().describe("Instead of sub and remoteId: a verified mention receipt's id, from a blyg the reader may not follow. It resolves only while the receipt is verified, and is drawn from what the receiver stored (source page, author, relation)."),
  remote: z.object({
    origin: z.string().url().max(2048).describe("The blyg's origin."),
    id: z.string().min(1).max(256).describe("The item's id on that blyg."),
  }).strict().optional().describe("Instead of sub and remoteId: an item on a blyg the reader does not hold, read live when opened. It resolves only when the built-in digest's last discovery met that origin (in the blygger.com directory or the reading)."),
  version: z.number().int().positive().optional().describe("The version the assistant judged. Shown so a reader can tell when the item has moved on since."),
  headline: words(AGENTIC_LIMITS.headline, "A headline for the entry in this edition."),
  summary: words(AGENTIC_LIMITS.summary, "A short summary or dek."),
  reason: words(AGENTIC_LIMITS.reason, "Why the reader is seeing it."),
  present: z.enum(AGENTIC_PRESENTS).optional().describe("How much of the entry to show: the full text, an excerpt (the default), only its title, or folded under its group's first entry."),
  group: z.string().trim().min(1).max(AGENTIC_LIMITS.group).optional().describe("Entries in a section with the same group are shown together under the first of them."),
}).strict().openapi("AgenticEntry");

/** An entry names exactly one thing: a held item (sub and remoteId together), a mention receipt, or a remote item. */
const namesOne = (x: z.infer<typeof AgenticEntrySchema>) =>
  (x.sub === undefined) === (x.remoteId === undefined) && [x.sub !== undefined, x.mention !== undefined, x.remote !== undefined].filter(Boolean).length === 1;

export const AgenticSectionSchema = z.object({
  title: z.string().trim().min(1).max(AGENTIC_LIMITS.title).describe("The section's heading. Written by the assistant."),
  kind: z.enum(AGENTIC_SECTION_KINDS).optional().describe("A layout hint: the lead story, an ordinary section (the default), or a column of briefs."),
  note: words(AGENTIC_LIMITS.note, "An introduction to the section."),
  entries: z.array(AgenticEntrySchema).max(AGENTIC_LIMITS.entries),
}).strict().openapi("AgenticSection");

export const AgenticScoreSchema = z.object({
  ...reference,
  score: z.number().finite().describe("Higher is shown first. Any finite number; only the order matters."),
  reason: words(AGENTIC_LIMITS.reason, "Why the reader is seeing it."),
}).strict().openapi("AgenticScore");

export const AgenticEditionInputSchema = z.object({
  title: words(AGENTIC_LIMITS.title, "The edition's name, a masthead line."),
  lede: words(AGENTIC_LIMITS.note, "An opening paragraph for the whole edition."),
  agent: z.object({
    name: z.string().trim().min(1).max(80).describe("Who wrote the edition: \"resident\" for the Studio's own assistant, else the outside assistant's name."),
    model: z.string().trim().min(1).max(120).optional().describe("The model it used, when it says."),
  }).strict(),
  generatedAt: z.string().datetime().optional().describe("When the assistant made the edition (ISO 8601 UTC)."),
  sections: z.array(AgenticSectionSchema).min(1).max(AGENTIC_LIMITS.sections).optional().describe("Edition mode: the assistant lays out the sections itself. Send sections or scores, never both."),
  scores: z.array(AgenticScoreSchema).min(1).max(AGENTIC_LIMITS.scores).optional().describe("Scores mode: per-entry scores; the Studio lays out one section, highest first. Send sections or scores, never both."),
}).strict()
  .refine((e) => (e.sections ? 1 : 0) + (e.scores ? 1 : 0) === 1, { message: "send sections or scores, exactly one" })
  .refine((e) => (e.sections ?? []).every((s) => s.entries.every(namesOne)), { message: "each entry names one thing: sub and remoteId, or mention, or remote" })
  .openapi("AgenticEditionInput");

/** The GET/PUT response, given the reading entry schema (routes.ts owns it). */
export function agenticEditionSchema<E extends z.ZodTypeAny>(readingEntry: E) {
  const resolved = AgenticEntrySchema.extend({
    entry: readingEntry.optional().describe("For sub and remoteId: the reading entry the reference resolves to, as GET /reading returns it."),
    receipt: z.object({
      sourcePage: z.string().nullable(), sourceOrigin: z.string().nullable(), sourceId: z.string().nullable(), sourceKind: z.string().nullable(),
      relation: z.string().nullable().describe("How the source answers: stub, transclusion or fork."),
      author: z.string().nullable(), verifiedAt: z.string().nullable(),
      targetItemId: z.string().describe("The owner's item it answers."),
    }).optional().describe("For a mention: the verified receipt, as the receiver stored it."),
    site: z.object({ title: z.string().nullable(), listed: z.boolean().describe("Listed in the blygger.com directory.") }).optional().describe("For a remote entry: the met origin, as the last discovery saw it."),
  }).openapi("AgenticResolvedEntry");
  return z.object({
    revision: z.number().int().nonnegative().describe("Send it back as expectedRevision for a conditional replace; every successful PUT bumps it. A never-written edition is at 0."),
    updatedAt: z.string().nullable(),
    mode: z.enum(["sections", "scores"]).nullable(),
    edition: z.unknown().describe("The edition as the assistant wrote it (AgenticEditionInput); null before the first PUT."),
    layout: z.object({
      title: z.string().nullable(),
      lede: z.string().nullable(),
      agent: z.object({ name: z.string(), model: z.string().optional() }),
      generatedAt: z.string().nullable(),
      sections: z.array(z.object({
        title: z.string(),
        kind: z.enum(AGENTIC_SECTION_KINDS),
        note: z.string().nullable(),
        entries: z.array(resolved),
      })),
    }).nullable().describe("What the tab draws: sections with each reference resolved to its reading entry. A reference that no longer resolves (unsubscribed, discarded, withdrawn) is left out, and a section left empty is dropped."),
    draft: z.object({ id: z.string() }).nullable().describe("The edition as a conformant blyg thread: a draft (private, owner-only) composed from headings, quotes, links and impyrt spans for the assistant's words, which the owner may edit and publish like any thread. A new draft starts when the owner has edited or published the previous one."),
  }).openapi("AgenticEdition");
}

export const CatchUpSchema = z.object({
  ordered: z.enum(["time", "depth"]).describe("time when every card's time is known; otherwise deeper first (a quote is always of something older), then by time."),
  cards: z.array(z.object({
    id: z.string(), origin: z.string(),
    sub: z.string().nullable().describe('Where it is held: a subscription id, "~own", or null when this reader does not hold it.'),
    version: z.number().int().nullable(), source: z.string().describe('Whose it is: the subscription name, "you", or the host.'),
    at: z.string().nullable(), depth: z.number().int().nonnegative(), partial: z.boolean(), label: z.string().nullable(),
    html: z.string().describe("The post's own words: its layer with every quote inside it taken out, sanitized."),
  })),
}).openapi("CatchUp");

export const CatchUpSummarySchema = z.object({
  summary: z.string().describe("A few plain sentences, oldest first: who said what and where the conversation stands. Generated: place it in a thread only as an impyrt span."),
  model: z.string(), at: z.string().describe("When it was written."),
  sources: z.array(z.object({ id: z.string(), version: z.number().int().nullable(), origin: z.string().optional() })).describe("Every post it read, oldest first, in the §5.9 reference shape (no origin for your own items)."),
  cached: z.boolean().describe("True when the same versions were summarized before and nothing was spent."),
}).openapi("CatchUpSummary");
