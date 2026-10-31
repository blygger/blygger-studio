import { success, created, failure, modelFailure, type OperationContext, type OperationInput } from './operation-types.ts';
import { versionState } from './version-state.ts';
import { isFont } from "./fonts.ts";
import { availableFeedAlgorithms } from "./feeds/available.ts";
import { settingsResource } from "./settings-resource.ts";
import { CUSTOM_THEME_ID, pairError, themeNameError, validateCustomTheme, type CustomTheme } from "./themes.ts";
import { itemResource } from "./contract/resources.ts";
import { itemUrl, storedSurface } from "./surface.ts";
import { z } from "@hono/zod-openapi";
import { createResponseDraft } from "./item-create.ts";
import { ItemCreateSchema, ItemEditSchema } from "./contract/routes.ts";
import { compiledExtensionNames } from "../build/extensions.names.ts";
// Owner API (cookie auth, JSON) — v0.1-plan §3.3.

import { canBeFrontPage, MAX_LINKS, postsPathError } from "./front-page.ts";
import {
  authoredKind,
  createDraft,
  createFork,
  discardDraft,
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
  TkPublishError,
  TransclusionResolveError,
  withdraw,
} from "./model.ts";
import { mentionFetchFor } from "./mentions/http.ts";
import { drainOutbound, enqueueForVersion } from "./mentions/send.ts";
import { checkForkTarget, resolveForkSource } from "./fork.ts";
import { flattenFork } from "./fork-flatten.ts";
import { blygItemUrl } from "./importer/util.ts";
import { siteOrigin } from "./protocol.ts";
import { parseForkedFrom, parseStoredFork, parseStoredStub, parseStubOf } from "./stub.ts";
import { parseScopes, unrequestedOutputDirectives } from './tk.ts';
import { runGenerateScope } from "./tk-generate.ts";
import type { ItemRow, SubscriptionRow } from "./types.ts";
import { BLOCKING, staleThreads, threadFreshness } from "./freshness.ts";
import { draftChangeNote } from "./change-note.ts";
import { classifyChange, settleChangeClass } from "./change-class.ts";
import type { ChangeCategory } from "./change-category.ts";
import { isDecisionModel } from "./ai/models.ts";
import { platformFetchFor } from "./importer/http.ts";
import { reconcileIndex } from "./importer/poll.ts";
import { hex, isFollowableUrl, isValidTimeZone, newMediaId, normalizeMount, nowIso } from "./util.ts";

const MEDIA_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};
const MEDIA_MAX_BYTES = 5 * 1024 * 1024;


type ItemBody = z.infer<typeof ItemEditSchema>;

const createItemOperation = async (context: OperationContext, input: OperationInput) => {
  const body = (input.body as z.infer<typeof ItemCreateSchema>);
  if (body.mode === "fork") return createForkResponse(context, body.source);
  if (body.mode === "response") {
    const item = await createResponseDraft(context, { ...body.source, selection: body.selection });
    return created(itemResource(item), `/api/items/${item.id}`);
  }
  const kind = body.kind === "thread" ? "thread" : "fragment";
  // A stub is a thread declaring one target (§2.2) — the stub action creates
  // the draft and its citation in one call.
  let stub = null;
  if (body.stub_of != null) {
    if (kind !== "thread") return failure('invalid-input', { error: "only threads can be stubs" });
    const parsed = parseStubOf(body.stub_of);
    if (!parsed.ok) return failure('invalid-input', { error: parsed.reason });
    stub = parsed.stub;
  }
  if (body.provenance !== undefined) {
    const parsed = parseScopes(body.content_md ?? '');
    if (parsed.errors.length || parsed.scopes.length !== body.provenance.length) return failure('invalid-input', { error: 'provenance must have one entry per TK scope' });
  }
  const item = await createDraft(context.env.DB, body.content_md ?? "", kind, stub, body.provenance);
  return created(itemResource(item), `/api/items/${item.id}`);
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
    .prepare("SELECT ii.kind AS kind, ii.page AS page FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id WHERE ii.remote_id = ? AND s.origin = ?")
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
  return created(itemResource(item), `/api/items/${item.id}`);
}

const updateItemOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await getItem(context.env.DB, input.path.id);
  if (!item) return failure('not-found', { error: "not found" });
  const body = (input.body as ItemBody);
  const kind = body.kind ?? await authoredKind(context.env.DB, item);
  if (body.kind !== undefined && item.version !== 0) return failure('conflict', { error: "kind is fixed once an item has been published" });
  const existingStub = parseStoredStub(item.stub_of);
  if (kind === "fragment" && body.stub_of != null) return failure('invalid-input', { error: "only threads can be stubs" });
  if (body.kind === "fragment" && existingStub !== null && !("stub_of" in body && body.stub_of === null)) {
    return failure('conflict', { error: "clear the stub before switching this to a fragment" });
  }
  let stubJson = item.stub_of;
  if ("stub_of" in body) {
    if (body.stub_of === null) stubJson = null;
    else {
      if (kind !== "thread") return failure('invalid-input', { error: "only threads can be stubs" });
      const parsed = parseStubOf(body.stub_of);
      if (!parsed.ok) return failure('invalid-input', { error: parsed.reason });
      stubJson = JSON.stringify(parsed.stub);
    }
  }
  if (body.provenance !== undefined) {
    const parsed = parseScopes(body.content_md ?? item.content_md);
    if (parsed.errors.length || parsed.scopes.length !== body.provenance.length) return failure('invalid-input', { error: 'provenance must have one entry per TK scope' });
  }
  const changesDraft = body.provenance !== undefined || body.content_md !== undefined || body.kind !== undefined || "stub_of" in body;
  const assignments: string[] = [], values: (string | number | null)[] = [];
  if (body.provenance !== undefined) { assignments.push("tk_provenance_json = ?"); values.push(JSON.stringify(body.provenance)); }
  if (body.content_md !== undefined) { assignments.push("content_md = ?"); values.push(body.content_md); }
  if (body.kind !== undefined) { assignments.push("kind = ?"); values.push(body.kind); }
  if ("stub_of" in body) { assignments.push("stub_of = ?"); values.push(stubJson); }
  if (body.responses !== undefined) { assignments.push("responses_override = ?"); values.push(body.responses === "default" ? null : Number(body.responses === "show")); }
  if (body.highlight !== undefined) { assignments.push("highlight_override = ?"); values.push(body.highlight === "default" ? null : Number(body.highlight === "show")); }
  if (changesDraft) { assignments.push("dirty = 1", "updated = CASE WHEN version = 0 THEN ? ELSE updated END"); values.push(nowIso()); }
  if (!assignments.length) return success(itemResource(item));
  // Write only requested fields. Guard the state used for validation, so a
  // concurrent publication or citation edit cannot invalidate that check.
  // A provenance-only patch also validated the stored text. When text is
  // supplied, the provenance check used that replacement instead.
  const checkedStoredText = body.provenance !== undefined && body.content_md === undefined;
  const fresh = await context.env.DB.prepare(`UPDATE items SET ${assignments.join(", ")} WHERE id = ? AND version = ? AND kind = ? AND stub_of IS ? AND tk_provenance_json IS ?${checkedStoredText ? " AND content_md = ?" : ""} RETURNING *`)
    .bind(...values, item.id, item.version, item.kind, item.stub_of, item.tk_provenance_json, ...(checkedStoredText ? [item.content_md] : [])).first<ItemRow>();
  if (!fresh) return failure('conflict', { error: "item changed while applying the patch; reload and try again" });
  return success(itemResource(fresh));
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
  const echoed = unrequestedOutputDirectives(item.content_md);
  const echoNote = echoed.length
    ? `Generated text contains ${echoed.map((id) => `![[${id}]]`).join(", ")} on its own line, which the instruction did not ask for. It was published as a quote and its author notified. Edit the output and republish if that was not intended.`
    : undefined;
  const warning = [lineageNote, echoNote].filter(Boolean).join(" ") || undefined;
  try {
    const version = await publish(context.env.DB, item, note, origin, noteGenerated);
    // Studio-private bookkeeping must never fail a publish that has happened.
    if (settle) await settle(version).catch((e) => console.error("change class not settled", e));
    await sendMentionsFor(context, item.id, version);
    return success({ ok: true, version, ...extra, ...(warning ? { warning } : {}) });
  } catch (e) {
    if (e instanceof TransclusionResolveError) {
      // Both bracket forms report here: `![[id]]` directives and `[[id]]`
      // links share the resolver, so they share the failure channel. The
      // message names both rather than only the one that predates the other —
      // each entry's `directive` shows the author which they wrote.
      return failure('invalid-input', { error: "one or more references do not resolve", errors: e.errors });
    }
    if (e instanceof TkPublishError) {
      return failure('invalid-input', { error: "one or more TK scopes are not publish-ready", errors: e.issues });
    }
    if (e instanceof FragmentTooLongError) {
      return failure('invalid-input', { error: `fragment exceeds ${e.max} characters` });
    }
    throw e;
  }
}

const publishItemOperation = async (context: OperationContext, input: OperationInput) => {
  // Also the republish path for withdrawn items: vN+1 restores 'public'/authored kind.
  // Studio-side fragment cap (§2.7) is enforced inside publish() against the
  // TK-stripped (published) length, not the raw working copy — see FragmentTooLongError.
  const item = await getItem(context.env.DB, input.path.id);
  if (!item) return failure('not-found', { error: "not found" });
  const body = (input.body as { note?: string; note_generated?: boolean; change_category?: ChangeCategory | null });
  // note_generated is the studio's own assertion that the note is the drafted
  // text, unedited (#40) — self-asserted, like every provenance member.
  // change_category is studio-private (migration 0030): settled after the
  // version exists, and never part of what publish() writes to the wire.
  const requested = "change_category" in body ? body.change_category ?? null : undefined;
  return publishAndNotify(context, item, body.note?.trim() || null, {}, body.note_generated === true, (version) => settleChangeClass(context.env.DB, item.id, version, requested));
};

/**
 * Classify the change the working copy would publish (session 49). Never
 * publishes; the publish dialog shows the answer as an editable chip. Off (409)
 * until Settings names a decision model; a provider failure is a null category,
 * never an error, so publish proceeds without one.
 */
const classifyChangeOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await getItem(context.env.DB, input.path.id);
  if (!item) return failure('not-found', { error: "not found" });
  const result = await classifyChange(context.env, item);
  if (!result.ok) return modelFailure({ error: result.error }, result.status);
  return success({ version: result.version, category: result.category, model: result.model, probability: result.probability, ...(result.reason ? { reason: result.reason } : {}) });
};

/** Draft a changelog note from the local diff (#40). Never publishes; the author edits and decides. */
const draftNoteOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await getItem(context.env.DB, input.path.id);
  if (!item) return failure('not-found', { error: "not found" });
  const result = await draftChangeNote(context.env, item);
  if (!result.ok) return modelFailure({ error: result.error }, result.status);
  return success({ note: result.note, model: result.model, pinned_prior: result.pinnedPrior });
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
  let item = await getItem(db, input.path.id);
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
  item = (await getItem(db, item.id))!;
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
  const item = await getItem(context.env.DB, input.path.id);
  if (!item) return failure('not-found', { error: "not found" });
  const body = (input.body as { scope: number });

  const origin = siteOrigin(await getSettings(context.env.DB), context.url, normalizeMount(context.env.MOUNT));
  const result = await runGenerateScope(context.env, item, body.scope, undefined, origin);
  if (!result.ok) return modelFailure(result.body, result.status as 400 | 404 | 502);
  return success({ text: result.text, model: result.model, content_md: result.content_md });
};

const withdrawItemOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await getItem(context.env.DB, input.path.id);
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
  return success({ ok: true, version });
};

const pinItemOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await getItem(context.env.DB, input.path.id);
  if (!item) return failure('not-found', { error: "not found" });
  const version = Number(input.path.version);
  const row = await getVersion(context.env.DB, item.id, version);
  if (!row) return failure('not-found', { error: "version not found" });
  // Endcap (withdrawal) versions have no content to cite (§2.8).
  if (versionState(row) === "withdrawn") return failure('conflict', { error: "cannot pin an endcap version" });
  const already = row.pinned === 1;
  if (!already) await pinVersion(context.env.DB, item.id, version);
  return success({ ok: true, version: version, already });
};

/**
 * Restore a past version into the working copy (studio furniture). Nothing is
 * published here and no version number moves: the author reviews the restored
 * draft and publishes it as the next version, forward-only. See
 * model.restoreVersion().
 */
const restoreItemOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await getItem(context.env.DB, input.path.id);
  if (!item) return failure('not-found', { error: "not found" });
  const body = (input.body as { version: number });
  try {
    await restoreVersion(context.env.DB, item, body.version);
  } catch (err) {
    if (err instanceof RestoreVersionError) return failure('conflict', { error: err.message });
    throw err;
  }
  return success({ ok: true, restored: body.version, publishesAs: item.version + 1 });
};

const deleteItemOperation = async (context: OperationContext, input: OperationInput) => {
  // Drafts only. Published items leave the public stream via withdraw — no delete exists.
  const item = await getItem(context.env.DB, input.path.id);
  if (!item) return failure('not-found', { error: "not found" });
  if (item.version > 0) return failure('conflict', { error: "published items are withdrawn, not deleted" });
  if (!await discardDraft(context.env.DB, item)) return failure('conflict', { error: "item changed while discarding; reload and try again" });
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
  if (typeof itemId === "string" && itemId && !(await getItem(context.env.DB, itemId))) {
    return failure('not-found', { error: "item_id not found" });
  }
  const bytes = file.bytes;
  // The studio sends inline=true for an upload it places in the text
  // (studio#24): shown only where its line is, never appended.
  const inline = media?.inline === true ? 1 : 0;
  // The same file (bytes and type) uploaded to the same item in the same
  // placement is the same attachment (studio#7): return the row already
  // there, store nothing.
  const sha256 = typeof itemId === "string" && itemId ? hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) : null;
  const existing = sha256 ? await findDuplicateMedia(context.env.DB, itemId as string, sha256, file.mime, inline) : null;
  if (existing) return success({ id: existing.id, url: existing.r2_key, mime: existing.mime, duplicate: true });
  const id = newMediaId();
  const r2Key = `media/${id}.${ext}`;
  await context.env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: file.mime } });
  const alt = media?.alt;
  const row = await insertMedia(context.env.DB, {
    id,
    item_id: typeof itemId === "string" && itemId ? itemId : null,
    r2_key: r2Key,
    mime: file.mime,
    alt: typeof alt === "string" ? alt : null,
    inline,
  }, context.access !== null && !context.access.scope.includes('owner:publish'), sha256);
  if (!row) {
    await context.env.MEDIA.delete(r2Key);
    return failure('forbidden', { error: 'owner:publish required to attach media to a published item' }, ['owner:draft', 'owner:publish']);
  }
  // A published item lists it from its next version on (migration 0031).
  if (row.item_id) await context.env.DB.prepare("UPDATE items SET dirty = 1 WHERE id = ? AND status = 'public'").bind(row.item_id).run();
  return created({ id: row.id, url: row.r2_key, mime: row.mime }, `/${normalizeMount(context.env.MOUNT).replace(/^\//, "")}/${row.r2_key}`.replace(/^\/\//, "/"));
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
  if (!row) return failure('not-found', { error: "not found" });
  if ((await getSettings(db)).avatar_media_id === row.id) return failure('conflict', { error: "this is the avatar; change it in Settings" });
  // An appended attachment is in no version's text, only in its list.
  const published = await db.prepare("SELECT 1 WHERE EXISTS (SELECT 1 FROM version_media WHERE media_id = ?) OR EXISTS (SELECT 1 FROM versions WHERE instr(content_html, ?) > 0)").bind(row.id, row.r2_key).first();
  if (published) {
    // The working copy now differs from the live version, which still lists it.
    await db.batch([
      db.prepare("UPDATE items SET dirty = 1 WHERE id = ? AND status = 'public' AND EXISTS (SELECT 1 FROM version_media WHERE item_id = ? AND version = items.version AND media_id = ?)").bind(row.item_id, row.item_id, row.id),
      db.prepare("UPDATE media SET item_id = NULL WHERE id = ?").bind(row.id),
    ]);
    return success({ ok: true, outcome: "detached" as const });
  }
  await context.env.MEDIA.delete(row.r2_key);
  await db.prepare("DELETE FROM media WHERE id = ?").bind(row.id).run();
  return success({ ok: true, outcome: "deleted" as const });
};

const SETTINGS_KEYS = [
  "site_title",
  "theme",
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
  "ai_model_classify",
  "feed_prompt",
  "ai_style_prompt",
  "picker_typing",
  "feed_order",
  "front_page",
  "posts_path",
  "links_position",
  "setup",
] as const;

const updateSettingsOperation = async (context: OperationContext, input: OperationInput) => {
  const body = (input.body as Record<string, unknown>);
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
  for (const key of ["accept_mentions", "update_check", "show_responses_default", "highlight_generated_default", "auto_change_notes", "change_category_in_note", "update_notice_ack", "links_collections", "links_opml", "links_blygger_org", "links_blygger_com"] as const) {
    if (typeof body[key] === "boolean") patch[key] = body[key] ? "on" : "off";
  }
  // Decision models answer questions and write no text (src/ai/models.ts): the
  // classifier takes only a decision model, and no text function takes one.
  if (patch.ai_model_classify?.trim() && !isDecisionModel(patch.ai_model_classify.trim())) return failure('invalid-input', { error: `ai_model_classify must be a decision model (Clef, Jev), not "${patch.ai_model_classify}"` });
  for (const key of ["ai_model_tk", "ai_model_changelog", "ai_model_feed"] as const) {
    if (patch[key]?.trim() && isDecisionModel(patch[key].trim())) return failure('invalid-input', { error: `${key} cannot be a decision model ("${patch[key]}"): decision models write no text` });
  }
  if (typeof patch.picker_typing === "string" && !["auto", "editor", "panel"].includes(patch.picker_typing)) return failure('invalid-input', { error: "picker_typing must be auto, editor or panel" });
  if (typeof patch.timezone === "string" && !isValidTimeZone(patch.timezone)) return failure('invalid-input', { error: `unknown timezone: ${patch.timezone}` });
  if (patch.author_url && !(URL.canParse(patch.author_url) && ["http:", "https:"].includes(new URL(patch.author_url).protocol))) return failure('invalid-input', { error: "author_url must be an absolute http(s) URL" });
  if (patch.site_url && !(URL.canParse(patch.site_url) && ["http:", "https:"].includes(new URL(patch.site_url).protocol))) return failure('invalid-input', { error: "site_url must be an absolute http(s) URL" });
  if (Array.isArray(body.author_links)) {
    const links = body.author_links as { label?: unknown; url?: unknown }[];
    if (!links.every((l) => typeof l?.label === "string" && typeof l?.url === "string" && isFollowableUrl(l.url))) return failure('invalid-input', { error: "author_links need a label and an absolute http(s) or mailto url" });
    patch.author_links = JSON.stringify(links);
  }
  if (Array.isArray(body.extensions)) {
    // Only an extension this build carries can be turned on (docs/extensions.md).
    const names = body.extensions as unknown[];
    const unknown = names.filter((name) => typeof name !== "string" || !compiledExtensionNames.includes(name));
    if (unknown.length) return failure('invalid-input', { error: `not an extension compiled into this build: ${unknown.map(String).join(", ")}` });
    patch.extensions = JSON.stringify([...new Set(names as string[])].sort());
  }
  if (typeof patch.setup === "string" && !["pending", "notice", "done"].includes(patch.setup)) return failure('invalid-input', { error: "setup must be pending, notice or done" });
  if (typeof patch.feed_order === "string") {
    // Against the extensions as they will be after this patch.
    const enabled = patch.extensions ? (JSON.parse(patch.extensions) as string[]) : (await getSettings(context.env.DB)).extensions;
    const ids = availableFeedAlgorithms(enabled).map((a) => a.id);
    if (!ids.includes(patch.feed_order)) return failure('invalid-input', { error: `feed_order must be one of ${ids.join(", ")}` });
  }
  // The settings form sends every field, so a value already stored passes even
  // if its thread has since been withdrawn; the public pages skip it themselves.
  const stored = patch.front_page || Array.isArray(body.links_threads) ? await getSettings(context.env.DB) : null;
  if (patch.front_page && patch.front_page !== stored?.front_page && !canBeFrontPage(await getItem(context.env.DB, patch.front_page))) return failure('invalid-input', { error: "front_page must be a published thread" });
  if (typeof patch.links_position === "string" && !["bottom", "left", "right"].includes(patch.links_position)) return failure('invalid-input', { error: "links_position must be bottom, left or right" });
  if (Array.isArray(body.links_threads)) {
    const ids = [...new Set(body.links_threads as unknown[])];
    if (ids.length > MAX_LINKS) return failure('invalid-input', { error: `links_threads takes at most ${MAX_LINKS} threads` });
    const kept: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string") return failure('invalid-input', { error: "links_threads must list published threads" });
      if (canBeFrontPage(await getItem(context.env.DB, id))) kept.push(id);
      // One listed before and withdrawn since is dropped, not refused.
      else if (!stored?.links_threads.includes(id)) return failure('invalid-input', { error: "links_threads must list published threads" });
    }
    patch.links_threads = JSON.stringify(kept);
  }
  if (Array.isArray(body.links_external)) {
    const links = body.links_external as { label?: unknown; url?: unknown }[];
    if (links.length > MAX_LINKS) return failure('invalid-input', { error: `links_external takes at most ${MAX_LINKS} links` });
    if (!links.every((l) => typeof l?.label === "string" && l.label.trim() !== "" && typeof l?.url === "string" && isFollowableUrl(l.url))) return failure('invalid-input', { error: "links_external need a label and an absolute http(s) or mailto url" });
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
  for (const key of ["custom_theme", "custom_theme_dark"] as const) {
    if (body[key] === null) {
      patch[key] = "";
      palettes[key] = null;
    } else if (body[key] !== undefined) {
      const checked = validateCustomTheme(body[key]);
      if ("error" in checked) return failure('invalid-input', { error: `${key}: ${checked.error}` });
      patch[key] = JSON.stringify(checked.theme);
      palettes[key] = checked.theme;
    }
  }
  if (patch.theme !== undefined || patch.custom_theme !== undefined || patch.custom_theme_dark !== undefined) {
    const current = await getSettings(context.env.DB);
    const theme = patch.theme ?? current.theme;
    const light = palettes.custom_theme !== undefined ? palettes.custom_theme : current.custom_theme;
    const dark = palettes.custom_theme_dark !== undefined ? palettes.custom_theme_dark : current.custom_theme_dark;
    if (theme === CUSTOM_THEME_ID && !light) return failure('invalid-input', { error: "theme is custom but no custom_theme is set" });
    const incoherent = pairError(light, dark);
    if (incoherent) return failure('invalid-input', { error: incoherent });
  }
  await putSettings(context.env.DB, patch);
  return success(settingsResource(await getSettings(context.env.DB)));
};

export const itemOperations = {
  createItem: createItemOperation,
  updateItem: updateItemOperation,
  publishItem: publishItemOperation,
  classifyChange: classifyChangeOperation,
  draftNote: draftNoteOperation,
  listStaleThreads: listStaleThreadsOperation,
  getItemFreshness: getItemFreshnessOperation,
  refreshItem: refreshItemOperation,
  generateItem: generateItemOperation,
  withdrawItem: withdrawItemOperation,
  pinItem: pinItemOperation,
  restoreItem: restoreItemOperation,
  deleteItem: deleteItemOperation,
  uploadMedia: uploadMediaOperation,
  deleteMedia: deleteMediaOperation,
  updateSettings: updateSettingsOperation,
};
