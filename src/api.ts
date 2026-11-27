import { PRIVATE_SCOPE, getItemAs, hiddenOwnIds, privateItemHidden, seesPrivate, workingCopyHidden } from './private-access.ts';
import { retainedMediaSql } from './media-retention.ts';
import { httpsUrl, listSyndication, refuseSyndication, replaceSyndication, type SyndicationEntry } from './syndication.ts';
import { assertCurrentRevision, assertItemRevision, ItemRevisionConflict } from './item-revision.ts';
import { consumeHandles, contactResource, createContact, deleteContact, getContact, handleTaken, HANDLE, listContacts, resolveContact, updateContact } from './contacts.ts';
import { readShelf, replaceShelf, unique, type Shelf, type ShelfEntry } from './shelf.ts';
import { OWN_SUBSCRIPTION } from './own-subscription.ts';
import { normalizeWords, readDictionary, replaceSource, SOURCE_PATTERN, SOURCES_MAX, TOTAL_WORDS_MAX, wordProblem } from './dictionary.ts';
import { success, created, failure, modelFailure, type OperationContext, type OperationInput } from './operation-types.ts';
import { versionState } from './version-state.ts';
import { isFont } from "./fonts.ts";
import { availableFeedAlgorithms } from "./feeds/available.ts";
import { settingsInput } from './contract/settings.ts';
import { deploymentUrls } from './deployment-urls.ts';
import { mediaUrl } from './contract/resources.ts';
import { settingsResource } from "./settings-resource.ts";
import { CUSTOM_THEME_ID, pairError, themeNameError, THEMES, validateCustomTheme, type CustomTheme } from "./themes.ts";
import { itemResource } from "./contract/resources.ts";
import { itemUrl, storedSurface } from "./surface.ts";
import { z } from "@hono/zod-openapi";
import { createResponseDraft } from "./item-create.ts";
import { ItemCreateSchema, ItemEditSchema } from "./contract/routes.ts";
import { compiledExtensionNames } from "../build/extensions.names.ts";
import { BACKGROUND_RULES, settleOwnBackground } from "./background.ts";
import { READER_ORDERS } from "./feeds/reader-order.ts";
import { listFeeds, readEdition, replaceEdition, type AgenticEditionInput } from "./agentic.ts";
import { writeResidentDigest } from "./agentic-digest.ts";
// Owner API (cookie auth, JSON) — v0.1-plan §3.3.

import { canBeFrontPage, MAX_LINKS, postsPathError } from "./front-page.ts";
import {
  authoredKind,
  createDraft,
  createFork,
  discardDraft,
  publishPrivately,
  FragmentTooLongError,
  getItem,
  getMedia,
  getSettings,
  getVersion,
  findDuplicateMedia,
  insertMedia,
  pinVersion,
  publish,
  putSettings,
  RestoreVersionError,
  restoreVersion,
  MathPublishError,
  TkPublishError,
  TransclusionResolveError,
  withdraw,
  keepsPublishedWords,
} from "./model.ts";
import { mentionFetchFor } from "./mentions/http.ts";
import { drainOutbound, enqueueForVersion } from "./mentions/send.ts";
import { checkForkTarget, resolveForkSource } from "./fork.ts";
import { flattenFork } from "./fork-flatten.ts";
import { blygItemUrl } from "./importer/util.ts";
import { siteOrigin } from "./protocol.ts";
import { parseForkedFrom, parseStoredFork, parseStoredStub, parseStubOf } from "./stub.ts";
import { unrequestedOutputDirectives } from './tk.ts';
import { parseTangles, partBody, rewriteTangles, tangleLabel, type TangleSpan } from './tangle.ts';
import { directiveOwnLine, linkInline } from './grammar.ts';
import { CommentPublishError, withoutComments } from './comments.ts';
import { runGenerateScope } from "./tk-generate.ts";
import type { ItemRow, SubscriptionRow } from "./types.ts";
import { CHANGELOG_DISPLAYS } from "./types.ts";
import { BLOCKING, staleThreads, threadFreshness } from "./freshness.ts";
import { draftChangeNote } from "./change-note.ts";
import { classifyChange, settleChangeClass } from "./change-class.ts";
import type { ChangeCategory } from "./change-category.ts";
import { isDecisionModel } from "./ai/models.ts";
import { platformFetchFor } from "./importer/http.ts";
import { importedSubject, ownChangelog, ownSubject, summarizeChangelog, type ChangelogEntry } from "./changelog-summary.ts";
import { catchUp } from "./helpers/catch-up.ts";
import { summarizeCatchUp, summarySubject } from "./helpers/catch-up-summary.ts";
import { INSTRUCTION_MAX_CHARS } from "./background-model.ts";
import { blygSubscription } from "./read-api.ts";
import { fetchImportedHistory } from "./imported-history.ts";
import { reconcileIndex } from "./importer/poll.ts";
import { deploymentPaths, hex, isFollowableUrl, isValidTimeZone, newId, newMediaId, normalizeMount, nowIso } from "./util.ts";

const MEDIA_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};
const MEDIA_MAX_BYTES = 5 * 1024 * 1024;


type ItemBody = z.infer<typeof ItemEditSchema>;

async function observedItem(context: OperationContext, input: OperationInput) {
  const item = await getItemAs(context.env.DB, input.path.id, context.access);
  if (item) assertItemRevision(item, (input.body as { expectedRevision: number }).expectedRevision);
  return item;
}


const createItemOperation = async (context: OperationContext, input: OperationInput) => {
  const body = (input.body as z.infer<typeof ItemCreateSchema>);
  if (body.mode === "fork") return createForkResponse(context, body.source);
  if (body.mode === "response") {
    const item = await createResponseDraft(context, { subscription_id: body.source.subscriptionId, remote_id: body.source.remoteId, selection: body.selection });
    return created(itemResource(item, await authoredKind(context.env.DB, item)), `${deploymentPaths(context.env.MOUNT).api}/items/${item.id}`);
  }
  const kind = body.kind === "thread" ? "thread" : "fragment";
  // A stub is a thread declaring one target (§2.2) — the stub action creates
  // the draft and its citation in one call.
  let stub = null;
  if (body.stubOf != null) {
    if (kind !== "thread") return failure('invalid-input', { error: "only threads can be stubs" });
    const parsed = parseStubOf(body.stubOf);
    if (!parsed.ok) return failure('invalid-input', { error: parsed.reason });
    stub = parsed.stub;
  }
  const item = await createDraft(context.env.DB, body.contentMd ?? "", kind, stub);
  return created(itemResource(item, await authoredKind(context.env.DB, item)), `${deploymentPaths(context.env.MOUNT).api}/items/${item.id}`);
};

/**
 * The fork action (§2.4): start a new draft from a pinned version, own or
 * imported, and record the lineage permanently. One call does both because
 * they are one act — the content and the claim about where it came from must
 * not be separable, or a draft could be forked and then quietly disowned.
 *
 * Reading the *pinned file* rather than the live item is the point (see
 * fork.ts): a fork descends from bytes that are promised forever, so those are
 * the bytes it starts from.
 */
/** A quoted item's page for a flattened quote's attribution line: ours, an import's own `page`, else its item document. */
async function quotedLink(db: D1Database, quoteOrigin: string, id: string, ourOrigin: string): Promise<string> {
  if (quoteOrigin === ourOrigin) {
    const own = await getItem(db, id);
    if (own) return blygItemUrl(ourOrigin, await authoredKind(db, own), id, null);
  }
  const row = await db
    .prepare("SELECT ii.kind AS kind, ii.page AS page FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id WHERE ii.remote_id = ? AND s.origin = ? AND s.hopper_feed IS NULL")
    .bind(id, quoteOrigin)
    .first<{ kind: string; page: string | null }>();
  return row ? blygItemUrl(quoteOrigin, row.kind, id, row.page) : itemUrl(quoteOrigin, await storedSurface(db, quoteOrigin), id);
}

async function createForkResponse(context: OperationContext, body: { origin: string; id: string; version: number }) {
  const parsed = parseForkedFrom(body);
  if (!parsed.ok) return failure('invalid-input', { error: parsed.reason });
  const settings = await getSettings(context.env.DB);
  const origin = siteOrigin(settings, context.url, normalizeMount(context.env.MOUNT));
  const resolved = await resolveForkSource(context.env.DB, parsed.ref, origin, settings.site_title, mentionFetchFor(context.env), nowIso());
  if (!resolved.ok) return failure('invalid-input', { error: resolved.reason });
  // #57: the fork starts from the pinned document, flattened — baked quotes as
  // plain blockquotes with attribution, generated spans as impyrt.
  const flat = await flattenFork(resolved.source, { origin: parsed.ref.origin, link: (o, id) => quotedLink(context.env.DB, o, id, origin) });
  const item = await createFork(context.env.DB, flat.contentMd, resolved.source.kind, parsed.ref, resolved.source.cite);
  return created(itemResource(item, await authoredKind(context.env.DB, item)), `${deploymentPaths(context.env.MOUNT).api}/items/${item.id}`);
}

const updateItemOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await observedItem(context, input);
  if (!item) return failure('not-found', { error: "not found" });
  const body = (input.body as ItemBody);
  const kind = body.kind ?? await authoredKind(context.env.DB, item);
  if (body.kind !== undefined && item.version !== 0) return failure('conflict', { error: "kind is fixed once an item has been published" });
  const existingStub = parseStoredStub(item.stub_of);
  if (kind === "fragment" && body.stubOf != null) return failure('invalid-input', { error: "only threads can be stubs" });
  if (body.kind === "fragment" && existingStub !== null && !("stubOf" in body && body.stubOf === null)) {
    return failure('conflict', { error: "clear the stub before switching this to a fragment" });
  }
  let stubJson = item.stub_of;
  if ("stubOf" in body) {
    if (body.stubOf === null) stubJson = null;
    else {
      if (kind !== "thread") return failure('invalid-input', { error: "only threads can be stubs" });
      const parsed = parseStubOf(body.stubOf);
      if (!parsed.ok) return failure('invalid-input', { error: parsed.reason });
      stubJson = JSON.stringify(parsed.stub);
    }
  }
  const changesDraft = body.contentMd !== undefined || body.kind !== undefined || "stubOf" in body;
  const assignments: string[] = [], values: (string | number | null)[] = [];
  if (body.contentMd !== undefined) { assignments.push("content_md = ?"); values.push(body.contentMd); }
  // A caller who could not see a hidden working copy wrote this text from the public version, so
  // the copy it replaces takes its mark and provenance with it (Venkat, session 86).
  if (body.contentMd !== undefined && !seesPrivate(context.access)) assignments.push("tk_provenance_json = CASE WHEN private_taint = 1 THEN NULL ELSE tk_provenance_json END", "private_taint = 0");
  if (body.kind !== undefined) { assignments.push("kind = ?"); values.push(body.kind); }
  if ("stubOf" in body) { assignments.push("stub_of = ?"); values.push(stubJson); }
  if (body.responses !== undefined) { assignments.push("responses_override = ?"); values.push(body.responses === "default" ? null : Number(body.responses === "show")); }
  if (body.highlight !== undefined) { assignments.push("highlight_override = ?"); values.push(body.highlight === "default" ? null : Number(body.highlight === "show")); }
  const onlyComments = body.contentMd !== undefined && body.kind === undefined && !("stubOf" in body) && await keepsPublishedWords(context.env.DB, item, body.contentMd);
  if (changesDraft) { assignments.push(onlyComments ? "dirty = 0" : "dirty = 1", "updated = CASE WHEN version = 0 THEN ? ELSE updated END"); values.push(nowIso()); }
  if (!assignments.length) return success(itemResource(item, await authoredKind(context.env.DB, item)));
  // Write only requested fields. Guard the state used for validation, so a
  // concurrent publication or citation edit cannot invalidate that check.
  assignments.push("revision = revision + 1");
  const fresh = await context.env.DB.prepare(`UPDATE items SET ${assignments.join(", ")} WHERE id = ? AND revision = ? RETURNING *`)
    .bind(...values, item.id, item.revision).first<ItemRow>();
  if (!fresh) throw new ItemRevisionConflict(item.id, item.revision);
  const shown = seesPrivate(context.access) ? fresh : (await getItemAs(context.env.DB, item.id, context.access))!;
  return success(itemResource(shown, await authoredKind(context.env.DB, shown)));
};

/**
 * Queue (and immediately attempt) the mentions a version owes, then get out
 * of the way. Delivery is fire-and-forget from the author's point of view
 * (§2.3.3): publish has already succeeded by the time this runs, nothing here
 * can fail it, and the cron retries whatever this attempt doesn't land.
 */
async function sendMentionsFor(
  context: OperationContext,
  itemId: string,
  version: number,
  opts: { force?: boolean } = {},
): Promise<void> {
  const row = await getVersion(context.env.DB, itemId, version);
  if (!row) return;
  const settings = await getSettings(context.env.DB);
  const origin = siteOrigin(settings, context.url, normalizeMount(context.env.MOUNT));
  // The same bounded fetch reads an unsubscribed target origin's manifest
  // (once per origin) for its `item` template, so the target is its item
  // document wherever that lives (§15.2, decision #85).
  const fetchFn = mentionFetchFor(context.env);
  const refs = await enqueueForVersion(context.env.DB, itemId, version, row, origin, { ...opts, fetchFn });
  if (!refs.length) return;
  // Fire-and-forget in the strong sense: a delivery error is a row status,
  // never an uncaught rejection in the worker that just published.
  context.defer(drainOutbound(context.env.DB, fetchFn, { origin }).catch(() => {}));
}

/**
 * Parts this thread minted (`tangled_from`) that its previous version quoted or
 * linked and this one does not (tangling plan §2.4): deleting a directive
 * leaves the part published and quoted by nothing, so the publish says which.
 */
async function droppedPartsNote(db: D1Database, threadId: string, version: number): Promise<string | undefined> {
  if (version < 2) return undefined;
  const rows = (await db.prepare("SELECT version, transclusions AS transclusions_json, links_json FROM versions WHERE item_id = ? AND version IN (?, ?)")
    .bind(threadId, version - 1, version).all<{ version: number; transclusions_json: string | null; links_json: string | null }>()).results;
  const named = (version: number) => {
    const row = rows.find((r) => r.version === version);
    const ids = new Set<string>();
    for (const json of [row?.transclusions_json, row?.links_json]) {
      try { for (const e of JSON.parse(json ?? "[]") as { id?: unknown; origin?: unknown }[]) if (typeof e?.id === "string" && !e.origin) ids.add(e.id); } catch { /* unreadable: names nothing */ }
    }
    return ids;
  };
  const before = named(version - 1), now = named(version);
  const gone = [...before].filter((id) => !now.has(id));
  if (!gone.length) return undefined;
  const parts = (await db.prepare("SELECT id, content_md FROM items WHERE tangled_from = ? AND id IN (SELECT value FROM json_each(?))")
    .bind(threadId, JSON.stringify(gone)).all<{ id: string; content_md: string }>()).results;
  if (!parts.length) return undefined;
  const names = parts.map((p) => `"${tangleLabel(withoutComments(p.content_md)) || p.id}"`).join(", ");
  return `This version no longer quotes or links ${parts.length === 1 ? "a part" : `${parts.length} parts`} it made: ${names}. ${parts.length === 1 ? "It stays" : "They stay"} published on ${parts.length === 1 ? "its" : "their"} own; withdraw from ${parts.length === 1 ? "its page" : "each page"} if ${parts.length === 1 ? "it" : "they"} should go.`;
}

/**
 * Publish an item and send what it owes — the one path both `publish` and
 * `refresh` take, so a refresh gets exactly a publish's checks and error
 * mapping. Returns the response to send.
 */
async function publishAndNotify(context: OperationContext, item: ItemRow, note: string | null, extra: Record<string, unknown> = {}, noteGenerated = false, settle?: (version: number) => Promise<void>) {
  const origin = siteOrigin(await getSettings(context.env.DB), context.url, normalizeMount(context.env.MOUNT));
  // §2.4's publish-time check. It lives here rather than inside publish()
  // deliberately: publish() is network-free by design (#26 — quoting follows
  // reading, and a publish must never depend on someone else's host being up),
  // and this is the one lineage claim that has to be re-tested against a
  // promise somebody else made. checkForkTarget only *fails* on evidence; an
  // unreachable origin is inconclusive and does not block the author.
  const fork = parseStoredFork(item.forked_from);
  let lineageNote: string | undefined;
  if (fork) {
    const check = await checkForkTarget(context.env.DB, fork, origin, mentionFetchFor(context.env));
    if (!check.ok) return failure('invalid-input', { error: check.reason });
    lineageNote = check.skipped;
  }
  // Decision #60: an own-line `![[id]]` left in generated output is a real
  // quote at publish. Warn when the instruction never named it — the usual
  // cause is a model echoing a directive — since it also notifies that origin.
  const echoed = unrequestedOutputDirectives(withoutComments(item.content_md));
  const echoNote = echoed.length
    ? `Generated text contains ${echoed.map((id) => `![[${id}]]`).join(", ")} on its own line, which the instruction did not ask for. It was published as a quote and its author notified. Edit the output and republish if that was not intended.`
    : undefined;
  const warning = [lineageNote, echoNote].filter(Boolean).join(" ") || undefined;
  // Literal prose on the wire, never an error; every client hears (tn-6 section 5.2).
  const { unresolved: unresolvedHandles } = await consumeHandles(context.env.DB, withoutComments(item.content_md));
  try {
    const version = await publish(context.env.DB, item, note, origin, noteGenerated, { restricted: !seesPrivate(context.access) });
    // Studio-private bookkeeping must never fail a publish that has happened.
    if (settle) await settle(version).catch((e) => console.error("change class not settled", e));
    // After the category settles: an own version's Background reasons (4a).
    await settleOwnBackground(context.env.DB, item.id, version).catch((e) => console.error("background reasons not settled", e));
    await sendMentionsFor(context, item.id, version);
    const dropped = await droppedPartsNote(context.env.DB, item.id, version).catch(() => undefined);
    const said = [warning, dropped].filter(Boolean).join(" ") || undefined;
    return success({ ok: true, version, revision: item.revision + 1, ...extra, ...(said ? { warning: said } : {}), ...(unresolvedHandles.length ? { unresolvedHandles } : {}) });
  } catch (e) {
    return publishFailure(e);
  }
}

/** The response for a publish that threw: a refusal the author can act on, or a rethrow. */
function publishFailure(e: unknown, prefix = "") {
  if (e instanceof TransclusionResolveError) {
    // Both bracket forms report here: `![[id]]` directives and `[[id]]`
    // links share the resolver, so they share the failure channel. The
    // message names both rather than only the one that predates the other —
    // each entry's `directive` shows the author which they wrote.
    return failure('invalid-input', { error: `${prefix}one or more references do not resolve`, errors: e.errors });
  }
  if (e instanceof CommentPublishError) {
    return failure('invalid-input', { error: prefix + e.issues.map((issue) => issue.reason).join("; "), errors: e.issues });
  }
  if (e instanceof TkPublishError) {
    return failure('invalid-input', { error: `${prefix}one or more TK scopes are not publish-ready`, errors: e.issues });
  }
  if (e instanceof MathPublishError) {
    return failure('invalid-input', { error: `${prefix}a formula does not parse: ${e.errors.map((m) => `${m.formula} (${m.reason})`).join("; ")}`, errors: e.errors });
  }
  if (e instanceof FragmentTooLongError) {
    return failure('invalid-input', { error: `${prefix}fragment exceeds ${e.max} characters` });
  }
  throw e;
}

const publishItemOperation = async (context: OperationContext, input: OperationInput) => {
  // Also the republish path for withdrawn items: vN+1 restores 'public'/authored kind.
  // Studio-side fragment cap (§2.7) is enforced inside publish() against the
  // TK-stripped (published) length, not the raw working copy — see FragmentTooLongError.
  let item = await observedItem(context, input);
  if (!item) return failure('not-found', { error: "not found" });
  // A caller who cannot see a hidden working copy publishes the version it sees: the hidden copy
  // is discarded first, as restore would discard it, and its mark with it (Venkat, session 86).
  if (await workingCopyHidden(context.env.DB, context.access, item.id)) {
    await restoreVersion(context.env.DB, (await getItem(context.env.DB, item.id))!, item.version);
    item = (await getItem(context.env.DB, item.id))!;
  }
  const body = (input.body as { note?: string; noteGenerated?: boolean; changeCategory?: ChangeCategory | null; tangle?: boolean; visibility?: "public" | "private" });
  // note_generated is the studio's own assertion that the note is the drafted
  // text, unedited (#40) — self-asserted, like every provenance member.
  // change_category is studio-private (migration 0030): settled after the
  // version exists, and never part of what publish() writes to the wire.
  const requested = "changeCategory" in body ? body.changeCategory ?? null : undefined;
  const note = body.note?.trim() || null;
  // A private version reaches no wire (decision #94), so none of a public
  // publish's checks, mentions or tangled parts apply to it. A publish that
  // names no visibility follows the blyg's default while the item was never
  // public; a public item has no other way to go (Venkat, 2026-11-22).
  const settings = await getSettings(context.env.DB);
  const visibility = body.visibility ?? (item.version === 0 ? settings.default_visibility : "public");
  if (visibility === "private") {
    if (item.version > 0) return failure('conflict', { error: "a published item can't be made private; withdraw it instead" });
    // The default can make a publish private without the body saying so; the
    // token must still hold the scope that would let it see the result.
    if (!seesPrivate(context.access)) return failure('forbidden', { error: 'insufficient scope' }, ['owner:publish', PRIVATE_SCOPE]);
    const privateVersion = await publishPrivately(context.env.DB, item, note, siteOrigin(settings, context.url, normalizeMount(context.env.MOUNT)));
    return success({ ok: true, version: 0, privateVersion, revision: item.revision + 1 });
  }
  const settle = (version: number) => settleChangeClass(context.env.DB, item.id, version, requested);
  const { spans, issues } = parseTangles(item.content_md);
  if (spans.length || issues.length) {
    if ((await authoredKind(context.env.DB, item)) === "fragment") {
      return failure('invalid-input', { error: "tangling makes a thread; switch this draft to a thread" });
    }
    if (issues.length) return failure('invalid-input', { error: issues.map((i) => i.reason).join("; "), errors: issues });
    return publishTangled(context, item, spans, note, body.noteGenerated === true, settle, body.tangle === true);
  }
  // A tangle that stopped after minting (tangling-plan §2.3) is finished here:
  // the parts this thread names are published first, then the thread.
  const parts = await publishPendingParts(context, item);
  if (!parts.ok) return parts.failed;
  return publishAndNotify(context, item, note, parts.published.length ? { parts: parts.published } : {}, body.noteGenerated === true, settle);
};

// ── Tangling (blygger-spec docs/tangling-plan.md §2; decisions #78, #100) ──
//
// A `![[+ text]]` span in a thread's working copy publishes as a new item the
// thread quotes, and an inline `[[+ text]]` as a new item it links (a
// placeholder, its text as a heading). Either is a "part", which is always a thread (#100: kind is fixed once published, and
// the client must not declare a leaf for the author). The sequence is
// pre-flight (nothing written), the count gate, one batch that mints the parts
// as drafts and rewrites the thread, then each part, then the thread last
// (§7). After the batch the thread holds no spans, so a retry can never mint
// twice: a crash partway is repaired by publishing the thread again.

/** A part as publish() would see it, for the pre-flight's dry run. Never stored. */
function draftPart(thread: ItemRow, text: string): ItemRow {
  return { ...thread, id: newId(), revision: 1, kind: "thread", status: "draft", version: 0, content_md: text, dirty: 1, tk_provenance_json: null, stub_of: null, forked_from: null, fork_cite: null, tangled_from: thread.id };
}

/** The drafts this thread minted and still names, by quote or by link, in the order it names them. */
async function pendingParts(db: D1Database, thread: ItemRow): Promise<ItemRow[]> {
  const { results } = await db.prepare("SELECT * FROM items WHERE tangled_from = ? AND version = 0").bind(thread.id).all<ItemRow>();
  if (!results.length) return [];
  const md = thread.content_md;
  const named = [...new Set([...md.matchAll(directiveOwnLine()), ...md.matchAll(linkInline())].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((m) => m[1]))];
  return named.flatMap((id) => results.filter((row) => row.id === id));
}

async function publishPendingParts(context: OperationContext, thread: ItemRow) {
  const published: { id: string; version: number }[] = [];
  for (const part of await pendingParts(context.env.DB, thread)) {
    const result = await publishAndNotify(context, part, null);
    if (!result.ok) return { ok: false as const, failed: result };
    published.push({ id: part.id, version: (result.value as { version: number }).version });
  }
  return { ok: true as const, published };
}

async function publishTangled(
  context: OperationContext,
  item: ItemRow,
  spans: TangleSpan[],
  note: string | null,
  noteGenerated: boolean,
  settle: (version: number) => Promise<void>,
  confirmed: boolean,
) {
  const db = context.env.DB;
  const origin = siteOrigin(await getSettings(db), context.url, normalizeMount(context.env.MOUNT));

  // 1. Pre-flight (§2.1): every error the real publishes would raise, raised
  // now. Each part dry-runs as the thread it will be; the thread dry-runs with
  // its spans taken out (a placeholder's words kept), since the directives and
  // links that replace them name items published first, which always resolve.
  for (const [i, span] of spans.entries()) {
    try {
      await publish(db, draftPart(item, partBody(span, item.id)), null, origin, false, { dryRun: true, restricted: !seesPrivate(context.access) });
    } catch (e) {
      return publishFailure(e, `new item ${i + 1} (${tangleLabel(span)}): `);
    }
  }
  let withoutSpans = "";
  let last = 0;
  for (const span of spans) {
    // A placeholder's words stay in the sentence; a quoted span leaves.
    withoutSpans += item.content_md.slice(last, span.start) + (span.kind === "link" ? span.text : "");
    last = span.end;
  }
  withoutSpans += item.content_md.slice(last);
  try {
    await publish(db, { ...item, content_md: withoutSpans }, note, origin, noteGenerated, { dryRun: true, restricted: !seesPrivate(context.access) });
  } catch (e) {
    return publishFailure(e);
  }
  const fork = parseStoredFork(item.forked_from);
  if (fork) {
    const check = await checkForkTarget(db, fork, origin, mentionFetchFor(context.env));
    if (!check.ok) return failure('invalid-input', { error: check.reason });
  }

  // 2. The count gate (§2.2): every caller sees the count before anything is
  // minted, the studio's dialog and an API or MCP client alike.
  if (!confirmed) {
    return failure('conflict', {
      error: `publishing this thread also publishes ${spans.length} new item${spans.length === 1 ? "" : "s"}; send tangle: true to confirm`,
      code: 'tangle-confirmation-required',
      count: spans.length,
      parts: spans.map((span) => (span.kind === "link" ? `${tangleLabel(span)} (linked)` : tangleLabel(span))),
    });
  }

  // 3. One batch: the parts as drafts, and the thread with each span replaced
  // by a labelled directive. Guarded by the thread's revision, as publish() is.
  const ids = spans.map(() => newId());
  const now = nowIso();
  const guard = "EXISTS (SELECT 1 FROM items WHERE id = ? AND revision = ?)";
  const committed = await db.batch([
    ...spans.map((span, i) =>
      db.prepare(`INSERT INTO items (id, kind, status, created, updated, version, content_md, dirty, tangled_from) SELECT ?, 'thread', 'draft', ?, ?, 0, ?, 1, ? WHERE ${guard}`)
        .bind(ids[i], now, now, partBody(span, item.id), item.id, item.id, item.revision),
    ),
    db.prepare("UPDATE items SET content_md = ?, dirty = 1, updated = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .bind(rewriteTangles(item.content_md, spans, ids), now, item.id, item.revision),
  ]);
  if (!committed[committed.length - 1].meta.changes) throw new ItemRevisionConflict(item.id, item.revision);

  // 4. Each part in source order, then the thread last (§7).
  const thread = (await getItem(db, item.id))!;
  const parts = await publishPendingParts(context, thread);
  if (!parts.ok) return parts.failed;
  return publishAndNotify(context, thread, note, { parts: parts.published }, noteGenerated, settle);
}

/**
 * Classify the change the working copy would publish (session 49). Never
 * publishes; the publish dialog shows the answer as an editable chip. Off (409)
 * until Settings names a decision model; a provider failure is a null category,
 * never an error, so publish proceeds without one.
 */
const classifyChangeOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await observedItem(context, input);
  if (!item) return failure('not-found', { error: "not found" });
  const result = await classifyChange(context.env, item);
  if (!result.ok) return modelFailure({ error: result.error }, result.status);
  return success({ revision: item.revision, version: result.version, category: result.category, model: result.model, probability: result.probability, ...(result.reason ? { reason: result.reason } : {}) });
};

/** Draft a changelog note from the local diff (#40). Never publishes; the author edits and decides. */
const draftNoteOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await observedItem(context, input);
  if (!item) return failure('not-found', { error: "not found" });
  const result = await draftChangeNote(context.env, item, undefined, { history: (input.body as { history?: boolean }).history === true });
  if (!result.ok) return modelFailure({ error: result.error }, result.status);
  await assertCurrentRevision(context.env.DB, item);
  return success({ revision: item.revision, note: result.note, model: result.model, pinnedPrior: result.pinnedPrior });
};

// A changelog summary for the reader (session 61): an own item from its
// versions, an imported one from its origin's changelog, read now.
const summarizeChangelogOperation = async (context: OperationContext, input: OperationInput) => {
  const body = input.body as { itemId?: string; subscriptionId?: string; remoteId?: string };
  let subject: string;
  let version: number;
  let entries: ChangelogEntry[];
  if (body.itemId) {
    const item = await getItem(context.env.DB, body.itemId);
    if (!item || item.version === 0) return failure('not-found', { error: "no published item with that id" });
    if (item.kind === "withdrawn") return failure('conflict', { error: "a withdrawn item's changelog is not summarized" });
    subject = ownSubject(item.id);
    version = item.version;
    entries = await ownChangelog(context.env.DB, item.id);
  } else {
    const sub = await blygSubscription(context.env.DB, body.subscriptionId!);
    if (!sub) return failure('not-found', { error: "not a blyg subscription" });
    const got = await fetchImportedHistory(platformFetchFor(context.env), sub, body.remoteId!);
    if (!got.ok) return modelFailure({ error: got.error }, got.status);
    if (got.value.withdrawn) return failure('conflict', { error: "a withdrawn item's changelog is not summarized" });
    subject = importedSubject(sub.id, body.remoteId!);
    version = got.value.current;
    entries = got.value.changelog;
  }
  const result = await summarizeChangelog(context.env, subject, version, entries);
  if (!result.ok) return modelFailure({ error: result.error }, result.status);
  return success({ summary: result.summary, model: result.model, version: result.version, cached: result.cached });
};

// The catch-up-summary helper (helpers-plan.md §7): catch-up's cards, then a
// summary of them, cached by their versions (src/helpers/catch-up-summary.ts).
const summarizeCatchUpOperation = async (context: OperationContext, input: OperationInput) => {
  const body = input.body as { sub: string; remoteId: string };
  const settings = await getSettings(context.env.DB);
  const laid = await catchUp(context.env.DB, body, siteOrigin(settings, context.url, normalizeMount(context.env.MOUNT)));
  if (!laid) return failure('not-found', { error: "not a published or current entry this reader holds" });
  const result = await summarizeCatchUp(context.env, summarySubject(body.sub, body.remoteId), laid.cards);
  if (!result.ok) return modelFailure({ error: result.error }, result.status);
  const { ok: _ok, ...summary } = result;
  return success(summary);
};

// --- Snapshot freshness (decision #33's direct check; #38: detect always,
// refresh only on a decision, never silently) ---

const listStaleThreadsOperation = async (context: OperationContext, input: OperationInput) => success({ items: await staleThreads(context.env.DB) });

const getItemFreshnessOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await getItem(context.env.DB, input.path.id);
  if (!item) return failure('not-found', { error: "not found" });
  if (item.kind !== "thread" || item.status !== "public") return failure('conflict', { error: "only a published thread has quoted snapshots" });
  const probe = input.query.probe !== "false";
  return success(await threadFreshness(context.env.DB, item, probe ? platformFetchFor(context.env) : undefined));
};

/**
 * Refresh a thread's stale quotes as one authoring act. A refresh **is** a
 * republish (#38): same working copy, new version, a feed entry, and mentions
 * to every origin whose target version changed (§15.2). So it refuses what a
 * republish of *other* words would be — unpublished edits in the working copy —
 * and what would fail anyway, and it refuses to bump a version for nothing.
 * Quotes whose origin is ahead of our import resync that subscription first;
 * the importer's own reconcile does the fetching, so a refreshed snapshot is
 * byte-for-byte what a scheduled poll would have stored.
 */
const refreshItemOperation = async (context: OperationContext, input: OperationInput) => {
  const db = context.env.DB;
  const item = await observedItem(context, input);
  if (!item) return failure('not-found', { error: "not found" });
  if (item.kind !== "thread" || item.status !== "public") return failure('conflict', { error: "only a published thread has quoted snapshots" });
  const body = (input.body as { note?: string });
  let report = await threadFreshness(db, item, platformFetchFor(context.env));
  if (report.dirty) return failure('conflict', { error: "this thread has unpublished edits; publish or discard them before refreshing its quotes" });
  let resynced = 0;
  const behind = new Set(report.quotes.filter((q) => q.status === "behind" && q.origin).map((q) => q.origin!));
  for (const origin of behind) {
    const sub = await db.prepare("SELECT * FROM subscriptions WHERE origin = ? AND kind = 'blyg'").bind(origin).first<SubscriptionRow>();
    if (!sub) continue;
    const result = await reconcileIndex(db, sub);
    if (result.ok) resynced++;
  }
  if (behind.size) report = await threadFreshness(db, item);
  const blocking = report.quotes.filter((q) => BLOCKING.has(q.status));
  if (blocking.length) {
    return failure('conflict', { error: "a republish would fail: edit or remove these quotes first", errors: blocking.map((q) => ({ id: q.id, reason: q.reason ?? q.status })) });
  }
  const refreshed = report.quotes.filter((q) => q.status === "refreshable").map((q) => q.id);
  if (!refreshed.length) {
    return failure('conflict', { error: behind.size ? "the newer versions could not be imported yet; try again after the next poll" : "every quote is already current" });
  }
  await assertCurrentRevision(db, item);
  return publishAndNotify(context, item, body.note?.trim() || null, { refreshed, resynced });
};

/**
 * TK generation (tk-core-plan.md §5): resolve scope `n`'s sources exactly
 * like transclusion targets, call the provider, splice the output into the
 * working copy, and record provenance for the next publish to pick up.
 * Errors are surfaced verbatim (no retry loop, per §5/§6 task 4). Logic
 * lives in tk-generate.ts's runGenerateScope so tests can inject a fixture
 * provider fetch (same DI pattern as importer/schedule.ts's runScheduledPoll).
 */
const generateItemOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await observedItem(context, input);
  if (!item) return failure('not-found', { error: "not found" });
  const body = (input.body as { scope: number; proceed?: boolean });

  const origin = siteOrigin(await getSettings(context.env.DB), context.url, normalizeMount(context.env.MOUNT));
  const result = await runGenerateScope(context.env, item, body.scope, undefined, origin, { proceed: body.proceed === true, privateSources: seesPrivate(context.access) });
  // Links that could not be read are the author's call, not an error (decision #117): nothing was generated or saved.
  if (!result.ok && result.checkpoint) return success({ checkpoint: result.checkpoint });
  if (!result.ok) return modelFailure(result.body, result.status as 400 | 404 | 502);
  return success({ text: result.text, model: result.model, contentMd: result.content_md, revision: result.revision });
};

const withdrawItemOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await observedItem(context, input);
  if (!item) return failure('not-found', { error: "not found" });
  if (item.status === "withdrawn") return failure('conflict', { error: "already withdrawn" });
  if (item.status !== "public") return failure('conflict', { error: "not published" });
  const body = (input.body as { note?: string });
  const note = body.note?.trim() || null;
  const version = await withdraw(context.env.DB, item, note);
  // §2.3.6: a withdrawn stub re-sends its mention once, from the last real
  // version's references — the endcap has none — so the receiver re-verifies,
  // finds a withdrawn document, and marks the row gone. That is the
  // W3C-blessed way to say "this is no longer there".
  //
  // `force`, because §15.2's re-send test compares the *target's* version and a
  // withdrawal changes nothing about the target. This is the one notification
  // that must go out precisely when the reference has not changed, so it is the
  // one caller allowed to override the test (migration 0011).
  await sendMentionsFor(context, item.id, item.version, { force: true });
  return success({ ok: true, version, revision: item.revision + 1 });
};

// §16.14 syndication (decision #98): see src/syndication.ts for the rules.
const getSyndicationOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await getItem(context.env.DB, input.path.id);
  if (!item) return failure('not-found', { error: "not found" });
  return success({ entries: await listSyndication(context.env.DB, item.id), revision: item.revision });
};
const putSyndicationOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await observedItem(context, input);
  if (!item) return failure('not-found', { error: "not found" });
  const body = input.body as { entries: SyndicationEntry[]; expectedRevision: number };
  const refusal = refuseSyndication(item, body.entries);
  if (refusal) {
    // A malformed URL is the caller's input; a draft or withdrawn item, or a
    // version not yet published, is the item's state.
    return body.entries.some(entry => !httpsUrl(entry.url))
      ? failure('invalid-input', { error: refusal.refused })
      : failure('conflict', { error: refusal.refused });
  }
  return success(await replaceSyndication(context.env.DB, item, body.entries, body.expectedRevision));
};

const pinItemOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await observedItem(context, input);
  if (!item) return failure('not-found', { error: "not found" });
  const version = Number(input.path.version);
  const row = await getVersion(context.env.DB, item.id, version);
  if (!row) return failure('not-found', { error: "version not found" });
  // Endcap (withdrawal) versions have no content to cite (§2.8).
  if (versionState(row) === "withdrawn") return failure('conflict', { error: "cannot pin an endcap version" });
  const already = row.pinned === 1;
  const revision = already ? item.revision : await pinVersion(context.env.DB, item.id, version, item.revision);
  return success({ ok: true, version: version, already, revision });
};

/**
 * Restore a past version into the working copy (studio furniture). Nothing is
 * published here and no version number moves: the author reviews the restored
 * draft and publishes it as the next version, forward-only. See
 * model.restoreVersion().
 */
const restoreItemOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await observedItem(context, input);
  if (!item) return failure('not-found', { error: "not found" });
  const body = (input.body as { version: number });
  try {
    await restoreVersion(context.env.DB, item, body.version);
  } catch (err) {
    if (err instanceof RestoreVersionError) return failure('conflict', { error: err.message });
    throw err;
  }
  return success({ ok: true, restored: body.version, publishesAs: item.version + 1, revision: item.revision + 1 });
};

const deleteItemOperation = async (context: OperationContext, input: OperationInput) => {
  // Drafts only. Published items leave the public stream via withdraw — no delete exists.
  const item = await observedItem(context, input);
  if (!item) return failure('not-found', { error: "not found" });
  if (item.version > 0) return failure('conflict', { error: "published items are withdrawn, not deleted" });
  if (!await discardDraft(context.env.DB, item)) throw new ItemRevisionConflict(item.id, item.revision);
  return success({ ok: true, outcome: "discarded" });
};

const uploadMediaOperation = async (context: OperationContext, input: OperationInput) => {
  const media = input.media;
  const file = media?.file;
  if (!file) return failure('invalid-input', { error: "file field required (multipart)" });
  const ext = MEDIA_TYPES[file.mime];
  if (!ext) return failure('unsupported-media', { error: `unsupported type ${file.mime || "(none)"}; allowed: png/jpg/gif/webp/svg` });
  if (file.bytes.byteLength > MEDIA_MAX_BYTES) return failure('too-large', { error: "file exceeds 5 MB" });
  const itemId = media?.itemId;
  // A private item is an unknown one to an access without owner:private (studio#178 R10).
  const item = itemId && !(await privateItemHidden(context.env.DB, context.access, itemId)) ? await getItem(context.env.DB, itemId) : null;
  if (itemId && !item) return failure('not-found', { error: "itemId not found" });
  if (item) {
    if (media.expectedRevision === undefined) return failure('invalid-input', { error: 'expectedRevision required when attaching media' });
    assertItemRevision(item, media.expectedRevision);
  }
  const bytes = file.bytes;
  // The studio sends inline=true for an upload it places in the text
  // (studio#24): shown only where its line is, never appended.
  const inline = media?.inline === true ? 1 : 0;
  // The same file (bytes and type) uploaded to the same item in the same
  // placement is the same attachment (studio#7): return the row already
  // there, store nothing.
  const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const existing = itemId ? await findDuplicateMedia(context.env.DB, itemId as string, sha256, file.mime, inline) : null;
  if (existing) return success({ id: existing.id, url: mediaUrl(existing.r2_key, deploymentUrls(context.url, context.env).publicBase), mime: existing.mime, duplicate: true, ...(item ? { revision: item.revision } : {}) });
  const id = newMediaId();
  const r2Key = `media/${id}/${sha256}.${ext}`;
  await context.env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: file.mime } });
  const alt = media?.alt;
  let row;
  try {
    row = await insertMedia(context.env.DB, {
      id, item_id: item?.id ?? null, r2_key: r2Key, mime: file.mime,
      alt: typeof alt === "string" ? alt : null, inline,
    }, context.access !== null && !context.access.scope.includes('owner:publish'), sha256, item?.revision);
  } catch (error) {
    await context.env.MEDIA.delete(r2Key);
    throw error;
  }
  if (!row) {
    await context.env.MEDIA.delete(r2Key);
    return failure('forbidden', { error: 'owner:publish required to attach media to a published item' }, ['owner:draft', 'owner:publish']);
  }
  return created({ id: row.id, url: mediaUrl(row.r2_key, deploymentUrls(context.url, context.env).publicBase), mime: row.mime, ...(item ? { revision: item.revision + 1 } : {}) }, `${deploymentPaths(context.env.MOUNT).publicBase}/${row.r2_key}`);
};

/**
 * Remove an attachment from its item (studio#24, #7). A media URL is a promise
 * to serve the same bytes (§5.4), so bytes any published version still shows
 * are kept and the row is only detached: it leaves the working copy, so the
 * next version goes without it, while the versions that listed it keep it
 * (migration 0031). Bytes nothing published references are deleted outright.
 * The avatar is not an attachment and is refused.
 */
const deleteMediaOperation = async (context: OperationContext, input: OperationInput) => {
  const db = context.env.DB;
  const row = await getMedia(db, input.path.id);
  if (!row || (row.item_id && await privateItemHidden(db, context.access, row.item_id))) return failure('not-found', { error: "not found" });
  if ((await getSettings(db)).avatar_media_id === row.id) return failure('conflict', { error: "this is the avatar; change it in Settings" });
  const item = row.item_id ? await getItem(db, row.item_id) : null;
  const expectedRevision = (input.body as { expectedRevision?: number }).expectedRevision;
  if (!item && expectedRevision !== undefined) return failure('conflict', { error: 'attachment changed; reload and try again', code: 'revision-conflict', expectedRevision, mediaId: row.id });
  if (item) {
    if (expectedRevision === undefined) return failure('invalid-input', { error: 'expectedRevision required when removing an attachment' });
    assertItemRevision(item, expectedRevision);
  }
  const guard = "id = ? AND item_id IS ? AND (? IS NULL OR EXISTS (SELECT 1 FROM items WHERE id = ? AND revision = ?)) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'avatar_media_id' AND value = ?)";
  const args = [row.id, row.item_id, row.item_id, row.item_id, item?.revision ?? 0, row.id];
  const committed = await db.batch([
    db.prepare(`DELETE FROM media WHERE ${guard} AND NOT (${retainedMediaSql})`).bind(...args),
    db.prepare(`UPDATE media SET item_id = NULL WHERE ${guard} AND (${retainedMediaSql})`).bind(...args),
    db.prepare("UPDATE items SET dirty = CASE WHEN version > 0 THEN 1 ELSE dirty END, revision = revision + 1 WHERE id = ? AND revision = ? AND NOT EXISTS (SELECT 1 FROM media WHERE id = ? AND item_id = ?) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'avatar_media_id' AND value = ?)")
      .bind(item?.id ?? null, item?.revision ?? 0, row.id, row.item_id, row.id),
  ]);
  if (!committed[0].meta.changes && !committed[1].meta.changes) {
    if (item) throw new ItemRevisionConflict(item.id, item.revision);
    return failure('conflict', { error: 'media changed; reload and try again' });
  }
  const outcome = committed[0].meta.changes ? 'deleted' : 'detached';
  if (outcome === 'deleted') await context.env.MEDIA.delete(row.r2_key);
  return success({ ok: true, outcome, ...(item ? { revision: item.revision + 1 } : {}) });
};

const SETTINGS_KEYS = [
  "site_title",
  "theme",
  "studio_theme",
  "font",
  "custom_theme_name",
  "author_name",
  "author_url",
  "author_bio",
  "site_url",
  "avatar_media_id",
  "update_feed_url",
  "timezone",
  "ai_model_tk",
  "ai_model_changelog",
  "ai_model_feed",
  "ai_model_helpers",
  "ai_model_classify",
  "bg_instruction",
  "feed_prompt",
  "ai_style_prompt",
  "changelog_display",
  "reader_changelog_display",
  "reader_order",
  "reader_mark_read",
  "agentic_driver",
  "agentic_title",
  "changelog_summary_prompt",
  "picker_typing",
  "default_visibility",
  "feed_order",
  "front_page",
  "posts_path",
  "links_position",
  "setup",
  "discover_seen_at",
  "setup_seen_version",
] as const;

const updateSettingsOperation = async (context: OperationContext, input: OperationInput) => {
  const body = settingsInput(input.body as Record<string, unknown>);
  const patch: Record<string, string> = {};
  // The pre-0.26 single model: sets the two functions it used to drive,
  // unless the same request names them itself.
  if (typeof body.ai_model === "string") {
    patch.ai_model_tk = body.ai_model;
    patch.ai_model_changelog = body.ai_model;
  }
  for (const key of SETTINGS_KEYS) {
    if (typeof body[key] === "string") patch[key] = body[key] as string;
  }
  for (const key of ["accept_mentions", "update_check", "show_responses_default", "highlight_generated_default", "auto_change_notes", "change_category_in_note", "update_notice_ack", "links_collections", "links_opml", "links_blygger_org", "links_blygger_com", "hopper_feeds", "bg_model_imported", "bg_flag_disagreement"] as const) {
    if (typeof body[key] === "boolean") patch[key] = body[key] ? "on" : "off";
  }
  // Decision models answer questions and write no text (src/ai/models.ts): the
  // classifier takes only a decision model, and no text function takes one.
  if (patch.ai_model_classify?.trim() && !isDecisionModel(patch.ai_model_classify.trim())) return failure('invalid-input', { error: `aiModelClassify must be a decision model (Clef, Jev), not "${patch.ai_model_classify}"` });
  for (const [field, key] of [["aiModelTk", "ai_model_tk"], ["aiModelChangelog", "ai_model_changelog"], ["aiModelFeed", "ai_model_feed"], ["aiModelHelpers", "ai_model_helpers"]] as const) {
    if (patch[key]?.trim() && isDecisionModel(patch[key].trim())) return failure('invalid-input', { error: `${field} cannot be a decision model ("${patch[key]}"): decision models write no text` });
  }
  if (typeof patch.picker_typing === "string" && !["auto", "editor", "panel"].includes(patch.picker_typing)) return failure('invalid-input', { error: "pickerTyping must be auto, editor or panel" });
  if (typeof patch.default_visibility === "string" && !["public", "private"].includes(patch.default_visibility)) return failure('invalid-input', { error: "defaultVisibility must be public or private" });
  if (typeof patch.agentic_driver === "string" && !["off", "resident"].includes(patch.agentic_driver)) return failure('invalid-input', { error: "agenticDriver must be off or resident" });
  for (const [field, key] of [["changelogDisplay", "changelog_display"], ["readerChangelogDisplay", "reader_changelog_display"]] as const) {
    if (typeof patch[key] === "string" && !(CHANGELOG_DISPLAYS as readonly string[]).includes(patch[key])) return failure('invalid-input', { error: `${field} must be latest, history or summary` });
  }
  if (typeof patch.agentic_title === "string" && patch.agentic_title.trim().length > 40) return failure('invalid-input', { error: "agenticTitle is at most 40 characters" });
  if (typeof patch.bg_instruction === "string" && patch.bg_instruction.trim().length > INSTRUCTION_MAX_CHARS) return failure('invalid-input', { error: `bgInstruction is at most ${INSTRUCTION_MAX_CHARS} characters` });
  if (typeof patch.reader_order === "string" && !(READER_ORDERS as readonly string[]).includes(patch.reader_order)) return failure('invalid-input', { error: `readerOrder must be ${READER_ORDERS.join(" or ")}` });
  if (typeof patch.reader_mark_read === "string" && !["seen", "opened", "never"].includes(patch.reader_mark_read)) return failure('invalid-input', { error: "readerMarkRead must be seen, opened or never" });
  if (typeof patch.timezone === "string" && !isValidTimeZone(patch.timezone)) return failure('invalid-input', { error: `unknown timezone: ${patch.timezone}` });
  // The avatar publishes its bytes, so it must be a medium that exists and that the caller may see:
  // a private item's medium is an unknown one to a restricted caller (plan §1 0f law 8; Venkat, session 85).
  if (patch.avatar_media_id) {
    const media = await context.env.DB.prepare("SELECT item_id FROM media WHERE id = ?").bind(patch.avatar_media_id).first<{ item_id: string | null }>();
    if (!media || (media.item_id && await privateItemHidden(context.env.DB, context.access, media.item_id))) return failure('invalid-input', { error: "avatarMediaId names no such media" });
  }
  if (patch.author_url && !(URL.canParse(patch.author_url) && ["http:", "https:"].includes(new URL(patch.author_url).protocol))) return failure('invalid-input', { error: "authorUrl must be an absolute http(s) URL" });
  if (patch.site_url && !(URL.canParse(patch.site_url) && ["http:", "https:"].includes(new URL(patch.site_url).protocol))) return failure('invalid-input', { error: "siteUrl must be an absolute http(s) URL" });
  if (Array.isArray(body.author_links)) {
    const links = body.author_links as { label?: unknown; url?: unknown }[];
    if (!links.every((l) => typeof l?.label === "string" && typeof l?.url === "string" && isFollowableUrl(l.url))) return failure('invalid-input', { error: "authorLinks need a label and an absolute http(s) or mailto url" });
    patch.author_links = JSON.stringify(links);
  }
  if (Array.isArray(body.extensions)) {
    // Only an extension this build carries can be turned on (docs/extensions.md).
    const names = body.extensions as unknown[];
    const unknown = names.filter((name) => typeof name !== "string" || !compiledExtensionNames.includes(name));
    if (unknown.length) return failure('invalid-input', { error: `not an extension compiled into this build: ${unknown.map(String).join(", ")}` });
    patch.extensions = JSON.stringify([...new Set(names as string[])].sort());
  }
  if (patch.discover_seen_at && Number.isNaN(Date.parse(patch.discover_seen_at))) return failure('invalid-input', { error: "discoverSeenAt must be an ISO date, or empty" });
  if (patch.setup_seen_version && !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(patch.setup_seen_version)) return failure('invalid-input', { error: "setupSeenVersion must be a version like 0.72.0, or empty" });
  if (body.bg_rules !== undefined) {
    // Merged into what is stored, so turning one rule off leaves the others.
    const rules = body.bg_rules as Record<string, unknown>;
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) return failure('invalid-input', { error: "backgroundRules must be an object of rule names to booleans" });
    const unknown = Object.entries(rules).filter(([rule, on]) => !(BACKGROUND_RULES as readonly string[]).includes(rule) || typeof on !== "boolean");
    if (unknown.length) return failure('invalid-input', { error: `backgroundRules takes ${BACKGROUND_RULES.join(", ")}, each true or false` });
    patch.bg_rules = JSON.stringify({ ...(await getSettings(context.env.DB)).bg_rules, ...rules });
  }
  if (typeof patch.setup === "string" && !["pending", "notice", "done"].includes(patch.setup)) return failure('invalid-input', { error: "setup must be pending, notice or done" });
  if (typeof patch.feed_order === "string") {
    // Against the extensions as they will be after this patch.
    const enabled = patch.extensions ? (JSON.parse(patch.extensions) as string[]) : (await getSettings(context.env.DB)).extensions;
    const ids = availableFeedAlgorithms(enabled).map((a) => a.id);
    if (!ids.includes(patch.feed_order)) return failure('invalid-input', { error: `feedOrder must be one of ${ids.join(", ")}` });
  }
  // The settings form sends every field, so a value already stored passes even
  // if its thread has since been withdrawn; the public pages skip it themselves.
  const stored = patch.front_page || Array.isArray(body.links_threads) ? await getSettings(context.env.DB) : null;
  if (patch.front_page && patch.front_page !== stored?.front_page && !canBeFrontPage(await getItem(context.env.DB, patch.front_page))) return failure('invalid-input', { error: "frontPage must be a published thread" });
  if (typeof patch.links_position === "string" && !["bottom", "left", "right"].includes(patch.links_position)) return failure('invalid-input', { error: "linksPosition must be bottom, left or right" });
  if (Array.isArray(body.links_threads)) {
    const ids = [...new Set(body.links_threads as unknown[])];
    if (ids.length > MAX_LINKS) return failure('invalid-input', { error: `linksThreads takes at most ${MAX_LINKS} threads` });
    const kept: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string") return failure('invalid-input', { error: "linksThreads must list published threads" });
      if (canBeFrontPage(await getItem(context.env.DB, id))) kept.push(id);
      // One listed before and withdrawn since is dropped, not refused.
      else if (!stored?.links_threads.includes(id)) return failure('invalid-input', { error: "linksThreads must list published threads" });
    }
    patch.links_threads = JSON.stringify(kept);
  }
  if (Array.isArray(body.links_external)) {
    const links = body.links_external as { label?: unknown; url?: unknown }[];
    if (links.length > MAX_LINKS) return failure('invalid-input', { error: `linksExternal takes at most ${MAX_LINKS} links` });
    if (!links.every((l) => typeof l?.label === "string" && l.label.trim() !== "" && typeof l?.url === "string" && isFollowableUrl(l.url))) return failure('invalid-input', { error: "linksExternal need a label and an absolute http(s) or mailto url" });
    patch.links_external = JSON.stringify(links.map((l) => ({ label: (l.label as string).trim(), url: l.url })));
  }
  if (typeof patch.posts_path === "string") {
    const pathError = postsPathError(patch.posts_path);
    if (pathError) return failure('invalid-input', { error: pathError });
  }
  if (typeof patch.font === "string" && !isFont(patch.font)) return failure('invalid-input', { error: `unknown font: ${patch.font}` });
  if (typeof patch.custom_theme_name === "string") {
    patch.custom_theme_name = patch.custom_theme_name.trim();
    const nameError = themeNameError(patch.custom_theme_name);
    if (nameError) return failure('invalid-input', { error: nameError });
  }
  // Custom theme and its optional dark companion: null clears; an object is
  // validated (and lowercased) before it is stored, so nothing but #rrggbb
  // ever reaches the stylesheet. The checks below run on the settings as they
  // would be after this patch, so a request can't leave them incoherent.
  const palettes: Record<"custom_theme" | "custom_theme_dark", CustomTheme | null | undefined> = {
    custom_theme: undefined,
    custom_theme_dark: undefined,
  };
  for (const [field, key] of [["customTheme", "custom_theme"], ["customThemeDark", "custom_theme_dark"]] as const) {
    if (body[key] === null) {
      patch[key] = "";
      palettes[key] = null;
    } else if (body[key] !== undefined) {
      const checked = validateCustomTheme(body[key]);
      if ("error" in checked) return failure('invalid-input', { error: `${field}: ${checked.error}` });
      patch[key] = JSON.stringify(checked.theme);
      palettes[key] = checked.theme;
    }
  }
  if (patch.theme !== undefined || patch.custom_theme !== undefined || patch.custom_theme_dark !== undefined) {
    const current = await getSettings(context.env.DB);
    const theme = patch.theme ?? current.theme;
    const light = palettes.custom_theme !== undefined ? palettes.custom_theme : current.custom_theme;
    const dark = palettes.custom_theme_dark !== undefined ? palettes.custom_theme_dark : current.custom_theme_dark;
    if (theme === CUSTOM_THEME_ID && !light) return failure('invalid-input', { error: "theme is custom but no customTheme is set" });
    if (current.studio_theme === CUSTOM_THEME_ID && patch.studio_theme === undefined && !light) return failure('invalid-input', { error: "studioTheme is custom: keep a customTheme, or change studioTheme first" });
    const incoherent = pairError(light, dark);
    if (incoherent) return failure('invalid-input', { error: incoherent });
  }
  if (patch.studio_theme !== undefined && patch.studio_theme !== "") {
    const name = patch.studio_theme;
    const known = name === "auto" || name === CUSTOM_THEME_ID || Object.prototype.hasOwnProperty.call(THEMES, name);
    if (!known) return failure('invalid-input', { error: `studioTheme must be empty, auto, custom or one of ${Object.keys(THEMES).join(", ")}` });
    const light = palettes.custom_theme !== undefined ? palettes.custom_theme : (await getSettings(context.env.DB)).custom_theme;
    if (name === CUSTOM_THEME_ID && !light) return failure('invalid-input', { error: "studioTheme is custom but no customTheme is set" });
  }
  await putSettings(context.env.DB, patch);
  const saved = await getSettings(context.env.DB);
  // Turning the built-in digest on writes an edition now, not at the next quarter hour.
  if (patch.agentic_driver === "resident") context.defer(writeResidentDigest(context.env.DB, Date.now(), siteOrigin(saved, context.url, normalizeMount(context.env.MOUNT))));
  return success(settingsResource(saved));
};

const contactInput = (body: { handle?: string; url?: string }) => {
  if (body.handle !== undefined && !HANDLE.test(body.handle)) return "a handle is letters, digits, - and _, starting with a letter or digit, at most 39 characters";
  if (body.url !== undefined) {
    try {
      if (new URL(body.url).protocol !== "https:") return "a contact's url must be https";
    } catch {
      return "a contact's url must be an absolute https URL";
    }
  }
  return null;
};
type ContactBody = { handle?: string; name?: string; url?: string; ids?: string[] };
const listContactsOperation = async (context: OperationContext) =>
  success({ contacts: (await listContacts(context.env.DB)).map(contactResource) });
const createContactOperation = async (context: OperationContext, input: OperationInput) => {
  const body = input.body as Required<Pick<ContactBody, "handle" | "name" | "url">> & ContactBody;
  const bad = contactInput(body);
  if (bad) return failure('invalid-input', { error: bad });
  if (await handleTaken(context.env.DB, body.handle)) return failure('conflict', { error: `@${body.handle} is already in the book` });
  return created(contactResource(await createContact(context.env.DB, body)));
};
const updateContactOperation = async (context: OperationContext, input: OperationInput) => {
  const row = await getContact(context.env.DB, input.path.id);
  if (!row) return failure('not-found', { error: "not found" });
  const body = input.body as ContactBody;
  const bad = contactInput(body);
  if (bad) return failure('invalid-input', { error: bad });
  if (body.handle && await handleTaken(context.env.DB, body.handle, row.id)) return failure('conflict', { error: `@${body.handle} is already in the book` });
  return success(contactResource(await updateContact(context.env.DB, row, body)));
};
const resolveContactOperation = async (context: OperationContext, input: OperationInput) => {
  const row = await getContact(context.env.DB, input.path.id);
  if (!row) return failure('not-found', { error: "not found" });
  try {
    return success(contactResource(await resolveContact(context.env.DB, platformFetchFor(context.env), row)));
  } catch (e) {
    return failure('bad-gateway', { error: `could not read ${row.url}: ${e instanceof Error ? e.message : String(e)}` });
  }
};
const deleteContactOperation = async (context: OperationContext, input: OperationInput) =>
  await deleteContact(context.env.DB, input.path.id) ? success({ ok: true }) : failure('not-found', { error: "not found" });

// The shelf (#135): see src/shelf.ts for the rules both operations share.
// Without owner:private the notebook's entries are not there (studio#178 R10): reads leave
// them out, a named one is dropped as an unknown one is, and a replace keeps them in place.
const isOwn = (hidden: Set<string>) => (entry: ShelfEntry) => entry.sub === OWN_SUBSCRIPTION && hidden.has(entry.remoteId);
async function shelfAs(context: OperationContext, shelf: Shelf): Promise<Shelf> {
  const hidden = await hiddenOwnIds(context.env.DB, context.access, shelf.entries.filter((e) => e.sub === OWN_SUBSCRIPTION).map((e) => e.remoteId));
  return hidden.size ? { ...shelf, entries: shelf.entries.filter((e) => !isOwn(hidden)(e)) } : shelf;
}
const getShelfOperation = async (context: OperationContext) => success(await shelfAs(context, await readShelf(context.env.DB)));
const putShelfOperation = async (context: OperationContext, input: OperationInput) => {
  const body = input.body as { entries: ShelfEntry[]; expectedRevision: number };
  let entries = body.entries;
  if (!seesPrivate(context.access)) {
    const current = await readShelf(context.env.DB);
    const hidden = await hiddenOwnIds(context.env.DB, context.access, [...current.entries, ...entries].filter((e) => e.sub === OWN_SUBSCRIPTION).map((e) => e.remoteId));
    if (hidden.size) {
      // Repeats go first, so one takes no place from a hidden entry.
      const given = unique(entries).filter((e) => !isOwn(hidden)(e));
      // Each hidden entry keeps its position; the token's list fills the rest, in its order.
      entries = [];
      current.entries.forEach((e, i) => { while (entries.length < i && given.length) entries.push(given.shift()!); if (isOwn(hidden)(e)) entries.push(e); });
      entries.push(...given);
    }
  }
  const stored = await replaceShelf(context.env.DB, entries, body.expectedRevision);
  if (stored) return success(await shelfAs(context, stored));
  // The current list rides in the error so a client can merge and retry.
  return failure('conflict', { error: 'shelf revision conflict; reload and try again', code: 'revision-conflict', current: await shelfAs(context, await readShelf(context.env.DB)) });
};

// The Agentic feeds and their editions: see src/agentic.ts for the rules the operations share.
// The routes need owner:private (src/contract/routes.ts): an edition may name any own item,
// so the runner refuses a restricted token the feed whole (Venkat, session 88).
const listAgenticFeedsOperation = async (context: OperationContext) => success({ feeds: await listFeeds(context.env.DB) });
const getAgenticOperation = async (context: OperationContext, input: OperationInput) => {
  const edition = await readEdition(context.env.DB, input.path.feed);
  return edition ? success(edition) : failure('not-found', { error: "no such agentic feed" });
};
const putAgenticOperation = async (context: OperationContext, input: OperationInput) => {
  const feed = input.path.feed;
  const body = input.body as { edition: AgenticEditionInput; expectedRevision: number };
  if (await replaceEdition(context.env.DB, feed, body.edition, body.expectedRevision, new Date().toISOString())) return success((await readEdition(context.env.DB, feed))!);
  const current = await readEdition(context.env.DB, feed);
  if (!current) return failure('not-found', { error: "no such agentic feed" });
  // The current edition rides in the error so an assistant can rebase and retry.
  return failure('conflict', { error: 'agentic edition revision conflict; reload and try again', code: 'revision-conflict', current });
};

// The dictionary: see src/dictionary.ts for the rules both operations share.
const getDictionaryOperation = async (context: OperationContext) => success(await readDictionary(context.env.DB));
const putDictionarySourceOperation = async (context: OperationContext, input: OperationInput) => {
  const source = String(input.path.source);
  if (!SOURCE_PATTERN.test(source)) return failure('invalid-input', { error: 'a source is lowercase letters, digits and hyphens, at most 48, starting and ending with a letter or digit' });
  const body = input.body as { words: string[]; expectedRevision: number };
  const words = normalizeWords(body.words);
  for (const word of words) {
    const problem = wordProblem(word);
    if (problem) return failure('invalid-input', { error: `the word ${JSON.stringify(word.slice(0, 80))} ${problem}`, word });
  }
  const current = await readDictionary(context.env.DB);
  const others = current.sources.filter((s) => s.source !== source);
  if (words.length && others.length + 1 > SOURCES_MAX) return failure('too-large', { error: `the dictionary holds at most ${SOURCES_MAX} sources` });
  if (others.reduce((n, s) => n + s.words.length, 0) + words.length > TOTAL_WORDS_MAX) return failure('too-large', { error: `the dictionary holds at most ${TOTAL_WORDS_MAX} words in all` });
  const stored = await replaceSource(context.env.DB, source, words, body.expectedRevision);
  if (stored) return success(stored);
  // The current dictionary rides in the error so a client can merge and retry.
  return failure('conflict', { error: 'dictionary revision conflict; reload and try again', code: 'revision-conflict', current: await readDictionary(context.env.DB) });
};


export const itemOperations = {
  listAgenticFeeds: listAgenticFeedsOperation,
  getAgentic: getAgenticOperation,
  putAgentic: putAgenticOperation,
  getDictionary: getDictionaryOperation,
  putDictionarySource: putDictionarySourceOperation,
  getShelf: getShelfOperation,
  putShelf: putShelfOperation,
  listContacts: listContactsOperation,
  createContact: createContactOperation,
  updateContact: updateContactOperation,
  resolveContact: resolveContactOperation,
  deleteContact: deleteContactOperation,
  createItem: createItemOperation,
  updateItem: updateItemOperation,
  publishItem: publishItemOperation,
  classifyChange: classifyChangeOperation,
  draftNote: draftNoteOperation,
  summarizeChangelog: summarizeChangelogOperation,
  summarizeCatchUp: summarizeCatchUpOperation,
  listStaleThreads: listStaleThreadsOperation,
  getItemFreshness: getItemFreshnessOperation,
  refreshItem: refreshItemOperation,
  generateItem: generateItemOperation,
  withdrawItem: withdrawItemOperation,
  pinItem: pinItemOperation,
  getSyndication: getSyndicationOperation,
  putSyndication: putSyndicationOperation,
  restoreItem: restoreItemOperation,
  deleteItem: deleteItemOperation,
  uploadMedia: uploadMediaOperation,
  deleteMedia: deleteMediaOperation,
  updateSettings: updateSettingsOperation,
};
