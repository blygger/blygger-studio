/*
 * Every Agentic feed edition is also a conformant blyg thread (Venkat, session
 * 77), composed from existing constructs only, so it can be published like any
 * thread and needs nothing new on the wire:
 *
 * - the masthead and each section are headings;
 * - an entry shown in full is an own-line quote, `![[id]]` (§10.1–§10.3; an
 *   imported item resolves by the local snapshot, #26); every other entry is a
 *   plain link, `[[id]]` (#32);
 * - every word the assistant wrote is an `impyrt` span (#37, §5.7 rule 7), so
 *   publishing discloses it as generated, with the assistant's model when it
 *   named one.
 *
 * Private by default (Venkat): the thread is a draft, which is owner-only and
 * never on the wire, until the owner publishes it from the editor. When the
 * private-items model lands (decision #94, plans/private-items-proposal.md),
 * editions become private items by default and public stays a deliberate act.
 */
import { createDraft, getItem, saveWorkingCopy } from "./model.ts";

interface Placed {
  headline?: string; summary?: string; reason?: string; present?: string;
  entry?: { key: string; own?: { id: string }; imported?: { remoteId: string } };
  receipt?: { sourcePage: string | null; sourceOrigin: string | null; author: string | null };
  remote?: { origin: string; id: string };
  site?: { title: string | null };
}
interface Layout { title: string | null; lede: string | null; agent: { name: string; model?: string }; generatedAt: string | null; sections: { title: string; note: string | null; entries: Placed[] }[] }

/**
 * The assistant's words, made safe to place inside an impyrt span: one
 * paragraph, with nothing that could open or close a TK scope, a quote, a link,
 * a code span or a heading. The words are otherwise kept as written.
 */
export function said(words: string): string {
  return words
    .replace(/\s+/g, " ")
    .replace(/\[\s*(\/?)\s*TK\s*\]/gi, "[ $1TK ]")
    .replace(/\[\[/g, "[ [")
    .replace(/\]\]/g, "] ]")
    .replace(/`/g, "'")
    .replace(/^#+\s*/, "")
    .trim();
}

const span = (words: string, model?: string) => `[TK]impyrt${model ? ` ${said(model).replace(/\s|=/g, "-")}` : ""}=${said(words)}[/TK]`;

/** A plain link to `url` when a markdown link can hold it as it is (http or https, no space, bracket or angle); its text is `words` with no bracket that could end it early, else the url's host. */
function link(words: string | null, url: string | null): string | undefined {
  if (!/^https?:\/\/[^\s()<>]+$/i.test(String(url))) return;
  return `[${said(words ?? "").replace(/[[\]]/g, "") || new URL(url!).host}](${url})`;
}

/**
 * How an entry appears in the thread: a held item as a quote or a link by id;
 * a mention or a remote item as a plain link to the page or blyg it names,
 * since the thread holds nothing of theirs. Nothing when the url cannot be linked.
 */
function reference(placed: Placed): string | undefined {
  const held = placed.entry;
  if (held) {
    const id = held.own ? held.own.id : held.imported!.remoteId;
    return placed.present === "full" ? `![[${id}]]` : `[[${id}]]`;
  }
  // An outside entry in the layout has resolved: a mention to its receipt, a remote item to its met origin.
  return placed.receipt ? link(placed.receipt.author, placed.receipt.sourcePage) : link(placed.site!.title, placed.remote!.origin);
}

/** The edition as a thread's markdown. `heading` is the owner's name for the tab, the Studio's words. */
export function editionMarkdown(layout: Layout, heading: string, date: string): string {
  const model = layout.agent.model;
  const blocks: string[] = [`# ${said(heading)}, ${date}`];
  if (layout.title) blocks.push(span(layout.title, model));
  if (layout.lede) blocks.push(span(layout.lede, model));
  for (const section of layout.sections) {
    blocks.push(`## ${span(section.title, model)}`);
    if (section.note) blocks.push(span(section.note, model));
    for (const placed of section.entries) {
      const line = reference(placed);
      if (!line) continue;
      if (placed.headline) blocks.push(span(placed.headline, model));
      if (placed.summary) blocks.push(span(placed.summary, model));
      blocks.push(line);
      if (placed.reason) blocks.push(span(placed.reason, model));
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

/**
 * Write the edition into its draft thread. The draft is the assistant's only
 * while it is unpublished and still holds what the Studio last wrote; once the
 * owner has edited or published it, a new draft starts and theirs is left
 * alone. Returns the draft's id and the markdown written.
 */
export async function writeEditionDraft(db: D1Database, previous: { id: string | null; md: string | null }, markdown: string): Promise<string> {
  const held = previous.id ? await getItem(db, previous.id) : null;
  if (held && held.status === "draft" && held.content_md === previous.md) {
    if (held.content_md !== markdown) await saveWorkingCopy(db, held.id, markdown);
    return held.id;
  }
  return (await createDraft(db, markdown, "thread")).id;
}
