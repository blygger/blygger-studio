import { success, created, failure, modelFailure, type OperationContext, type OperationInput } from './operation-types.ts';
import { itemResource, versionResource, mediaResource, subscriptionResource, hopperResource, importedResource, mentionResource } from "./contract/resources.ts";
import { settingsResource } from "./settings-resource.ts";
import { fetchOnSurface, itemUrl } from "./surface.ts";
import { annotateTkPreview, scopeSummariesWithSources } from "./authoring.ts";
import { getItem, getSettings, getSettingsMap, getVersion, listVersions } from "./model.ts";
import { getHopper, getImportedItem, listSubscriptions, getSubscription } from "./importer/store.ts";
import { sanitizeHtml } from "./importer/sanitize.ts";
import { renderMarkdown, plainTextFromHtml } from "./markdown.ts";
import { clampText } from "./preview.ts";
import { applyInternalLinks, previewInternalLinks, previewTransclusions, resolveBlockLinks } from "./transclusion.ts";
import { siteOrigin } from "./protocol.ts";
import { MODELS, bindingName, configuredProviders, isDecisionModel } from "./ai/models.ts";
import { changeClassesFor } from "./change-class.ts";
import { INTERACTION_KINDS, listInteractions, listThumbs, type InteractionKind } from "./interactions.ts";
import { normalizeMount } from "./util.ts";
import type { SignalRow, ImportedItemRow, ItemRow, SubscriptionRow, HopperRow, MentionInRow, MentionOutRow } from "./types.ts";
import { itemDetail } from "./item-data.ts";
import { readingData } from "./reading-data.ts";
import { IMPORTED_READING_DEFAULT, importedReading } from "./imported-reading.ts";
import { getInbound } from "./mentions/store.ts";
import { maybeCheckForUpdate } from "./update-check.ts";
import { normalizeOrigin } from "./stub.ts";
import { mentionFetchFor } from "./mentions/http.ts";
import { platformFetchFor } from "./importer/http.ts";
import { listBrowse, recordBrowse, clearBrowse, type BrowseVia } from "./browse-log.ts";
import { classifyLinks, peekItem } from "./peek.ts";
import { fetchImportedHistory, fetchPublicVersion } from "./imported-history.ts";
import { readChanges } from './changes.ts';
import { linkLabel } from "./link-label.ts";
import { versionState } from './version-state.ts';
import { operationAvailability } from './operation-availability.ts';
import { API_CONTRACT_VERSION } from './operation-policy.ts';
import { authLocations } from './oauth.ts';

const getCapabilitiesOperation = async (context: OperationContext, input: OperationInput) => {
  const { base, api, issuer, mcp } = authLocations(context.url, context.env);
  const publicBase = new URL(context.url).origin + normalizeMount(context.env.MOUNT);
  return success({ contractVersion: API_CONTRACT_VERSION, endpoints: { publicBase, studio: base, api, issuer, mcp, media: publicBase + '/media' },
    ...await operationAvailability(context.env.DB, context.access, context.extensions) });
};
const getChangesOperation = async (context: OperationContext, input: OperationInput) => success(await readChanges(context.env.DB));
async function collection<T>(db: D1Database, query: Record<string, string>, sql: string, countSql: string) {
  const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 100);
  const [rows, count] = await Promise.all([
    db.prepare(`${sql} LIMIT ? OFFSET ?`).bind(limit, offset).all<T>(),
    db.prepare(countSql).first<{ total: number }>(),
  ]);
  return { items: rows.results, total: count?.total ?? 0, offset, limit };
}

const listItemsOperation = async (context: OperationContext, input: OperationInput) => {
  const offset = Number(input.query.offset ?? 0), limit = Number(input.query.limit ?? 100);
  const [rows, count] = await Promise.all([
    context.env.DB.prepare("SELECT * FROM items ORDER BY updated DESC, rowid DESC LIMIT ? OFFSET ?").bind(limit, offset).all<ItemRow>(),
    context.env.DB.prepare("SELECT COUNT(*) AS total FROM items").first<{ total: number }>(),
  ]);
  // Return frozen version links without loading history bodies into the index.
  const pins = rows.results.length ? (await context.env.DB.prepare(`SELECT item_id, version, CASE WHEN kind IN ('fragment','thread') THEN kind WHEN transclusions IS NULL THEN 'fragment' ELSE 'thread' END AS kind FROM versions WHERE pinned = 1 AND item_id IN (${rows.results.map(() => '?').join(',')}) ORDER BY version`).bind(...rows.results.map(row => row.id)).all<{ item_id: string; version: number; kind: 'fragment' | 'thread' }>()).results : [];
  return success({ items: rows.results.map(row => ({ ...itemResource(row), pins: pins.filter(pin => pin.item_id === row.id).map(({ version, kind }) => ({ version, kind })) })), total: count?.total ?? 0, offset, limit });
};
// Owner DTOs feed HTML previews. Sanitize copies, not immutable version rows or
// public protocol snapshots, so legacy bakes cannot regain browser authority.
async function presentVersion(row: Parameters<typeof versionResource>[0]) {
  return versionResource({ ...row, content_html: await sanitizeHtml(row.content_html) });
}
const getItemOperation = async (context: OperationContext, input: OperationInput) => {
  const detail = await itemDetail(context.env.DB, input.path.id);
  if (!detail) return failure('not-found', { error: "not found" });
  // The change classifier's studio-private record rides on the owner's view of
  // each version (migration 0030); protocol.ts never reads it.
  const classes = await changeClassesFor(context.env.DB, detail.item.id, detail.item.version);
  const withClass = async (row: Parameters<typeof versionResource>[0]) => {
    const cls = classes.get(row.version);
    return { ...(await presentVersion(row)), change_class: cls ? { category: cls.category, model: cls.model, probability: cls.probability, classified_at: cls.classified_at, overridden: cls.overridden === 1 } : null };
  };
  return success({ ...itemResource(detail.item), authored_kind: detail.kind, media: detail.media.map(mediaResource), published_media: detail.publishedMedia.map(mediaResource), versions: await Promise.all(detail.versions.map(withClass)), published: detail.published ? await withClass(detail.published) : null });
};
const getSettingsOperation = async (context: OperationContext, input: OperationInput) => success(settingsResource(await getSettings(context.env.DB)));
const listSubscriptionsOperation = async (context: OperationContext, input: OperationInput) => {
  const page = await collection<SubscriptionRow>(context.env.DB, input.query, "SELECT * FROM subscriptions ORDER BY created ASC, id ASC", "SELECT COUNT(*) AS total FROM subscriptions");
  return success({ ...page, items: page.items.map(subscriptionResource) });
};
const getSubscriptionOperation = async (context: OperationContext, input: OperationInput) => {
  const sub = await getSubscription(context.env.DB, input.path.id);
  return sub ? success(subscriptionResource(sub)) : failure('not-found', { error: "not found" });
};
const listHoppersOperation = async (context: OperationContext, input: OperationInput) => {
  const page = await collection<HopperRow>(context.env.DB, input.query, "SELECT * FROM hoppers ORDER BY created ASC, id ASC", "SELECT COUNT(*) AS total FROM hoppers");
  return success({ ...page, items: page.items.map(hopperResource) });
};
const getHopperOperation = async (context: OperationContext, input: OperationInput) => {
  const hopper = await getHopper(context.env.DB, input.path.id);
  if (!hopper) return failure('not-found', { error: "not found" });
  const preview = input.query.preview === "true";
  const limit = preview ? " LIMIT 3" : "";
  const memberships = (await context.env.DB.prepare(`SELECT * FROM hopper_items WHERE hopper_id = ? ORDER BY added_at DESC, subscription_id, remote_id${limit}`).bind(hopper.id).all<import("./types.ts").HopperItemRow>()).results;
  const counts = await context.env.DB.prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT CASE WHEN subscription_id <> '~own' THEN subscription_id END) AS source_count FROM hopper_items WHERE hopper_id = ?").bind(hopper.id).first<{ total: number; source_count: number }>();
  const rows = await context.env.DB.prepare(`SELECT ii.* FROM hopper_items hi JOIN imported_items ii
    ON ii.subscription_id = hi.subscription_id AND ii.remote_id = hi.remote_id
    WHERE hi.hopper_id = ? ORDER BY hi.added_at DESC, hi.subscription_id, hi.remote_id${limit}`).bind(hopper.id).all<ImportedItemRow>();
  const items = await Promise.all(rows.results.map(async (r) => importedResource({ ...r, content_html: await sanitizeHtml(r.content_html) })));
  return success({ hopper: hopperResource(hopper), memberships, items, total: counts?.total ?? 0, source_count: counts?.source_count ?? 0 });
};
const listSignalsOperation = async (context: OperationContext, input: OperationInput) => success(await collection<SignalRow>(context.env.DB, input.query, "SELECT * FROM signals ORDER BY at DESC, subscription_id, remote_id", "SELECT COUNT(*) AS total FROM signals"));
const listMentionsOperation = async (context: OperationContext, input: OperationInput) => {
  const direction = input.query.direction ?? "inbound";
  const where = "WHERE status IN ('verified','gone')";
  if (direction === "outbound") return success({ ...await collection<MentionOutRow>(context.env.DB, input.query, "SELECT * FROM mentions_out ORDER BY created DESC, id ASC", "SELECT COUNT(*) AS total FROM mentions_out"), direction });
  const page = await collection<MentionInRow>(context.env.DB, input.query, `SELECT * FROM mentions_in ${where} ORDER BY verified_at DESC, last_seen DESC, id ASC`, `SELECT COUNT(*) AS total FROM mentions_in ${where}`);
  return success({ ...page, items: page.items.map(mentionResource), direction });
};
const listInteractionsOperation = async (context: OperationContext, input: OperationInput) => {
  const offset = Math.max(0, Number(input.query.offset ?? 0) || 0);
  const limit = Math.min(100, Math.max(1, Number(input.query.limit ?? 50) || 50));
  const raw = input.query.kind;
  const kind = INTERACTION_KINDS.includes(raw as InteractionKind) ? (raw as InteractionKind) : undefined;
  return success({ ...(await listInteractions(context.env.DB, offset, limit, kind)), offset, limit });
};
const getAiModelsOperation = async (context: OperationContext, input: OperationInput) => {
  const configured = configuredProviders(context.env);
  return success({
    // Names only: never a key's value, a base_url (it may be a private
    // endpoint) or request params.
    providers: Object.entries(MODELS.providers).map(([id, p]) => ({
      id,
      label: p.label,
      ...(p.key_secret ? { key_secret: p.key_secret } : {}),
      ...(p.api === "workers-ai" ? { binding: bindingName(p) } : {}),
      configured: configured[id] ?? false,
    })),
    // A decision model is marked so Settings lists it only for the classifier.
    models: MODELS.models.map(({ id, provider, label, note }) => ({ id, provider, label, ...(note ? { note } : {}), ...(isDecisionModel(id) ? { kind: "decision" as const } : {}) })),
    local: MODELS.local,
  });
};
const listThumbsOperation = async (context: OperationContext, input: OperationInput) => success({ items: await listThumbs(context.env.DB) });
// `read_state: true` advertises that imported entries carry the owner's
// readVersion, so a client can tell "unread" from "this server keeps none".
const listReadingOperation = async (context: OperationContext, input: OperationInput) => success({ ...await readingData(context.env.DB, Number(input.query.offset ?? 0), Number(input.query.limit ?? 25), input.query.sub, readingKind(input.query.kind), input.query.background === "true"), read_state: true as const, read_state_clear: true as const });
// Imported items only, keyset-paged, for clients that author from what they read (studio#11).
const listImportedReadingOperation = async (context: OperationContext, input: OperationInput) => {
  return success(await importedReading(context.env.DB, input.query.cursor, Number(input.query.limit ?? IMPORTED_READING_DEFAULT)));
};
function readingKind(raw: string | undefined): "thread" | "fragment" | undefined {
  return raw === "thread" || raw === "fragment" ? raw : undefined;
}
const getImportedItemOperation = async (context: OperationContext, input: OperationInput) => {
  const row = await getImportedItem(context.env.DB, input.path.sub, input.path.id);
  return row ? success(importedResource({ ...row, content_html: await sanitizeHtml(row.content_html) })) : failure('not-found', { error: "not found" });
};
// History of an imported item (#40), read from its origin on demand. Blyg
// subscriptions only: an L0 feed has no item documents and no versions.
async function blygSubscription(db: D1Database, id: string) {
  const sub = await getSubscription(db, id);
  return sub && sub.kind === "blyg" ? sub : null;
}
const getImportedHistoryOperation = async (context: OperationContext, input: OperationInput) => {
  const sub = await blygSubscription(context.env.DB, input.path.sub);
  if (!sub) return failure('not-found', { error: "not a blyg subscription" });
  const got = await fetchImportedHistory(platformFetchFor(context.env), sub, input.path.id);
  return got.ok ? success(got.value) : modelFailure({ error: got.error }, got.status);
};
const getImportedVersionOperation = async (context: OperationContext, input: OperationInput) => {
  const sub = await blygSubscription(context.env.DB, input.path.sub);
  if (!sub) return failure('not-found', { error: "not a blyg subscription" });
  const got = await fetchPublicVersion(platformFetchFor(context.env), sub, input.path.id, Number(input.path.v));
  return got.ok ? success(got.value) : modelFailure({ error: got.error }, got.status);
};
// Following links out of an entry (0.49.0). `peekItem` reads one item from its own blyg
// without subscribing; `classifyLinks` says which of an entry's links name blyg items.
const peekItemOperation = async (context: OperationContext, input: OperationInput) => {
  const got = await peekItem(context.env.DB, platformFetchFor(context.env), input.query.origin ?? "", input.query.id ?? "");
  return got.ok ? success(got.value) : modelFailure({ error: got.error }, got.status);
};
const classifyLinksOperation = async (context: OperationContext, input: OperationInput) => {
  const { urls } = (input.body as { urls: string[] });
  const settings = await getSettings(context.env.DB);
  const ourOrigin = siteOrigin(settings, context.url, normalizeMount(context.env.MOUNT));
  return success({ links: await classifyLinks(context.env.DB, platformFetchFor(context.env), urls, ourOrigin, new Date().toISOString()) });
};
const listBrowseOperation = async (context: OperationContext, input: OperationInput) => {
  const offset = Math.max(0, Number(input.query.offset ?? 0) || 0);
  const limit = Math.min(100, Math.max(1, Number(input.query.limit ?? 50) || 50));
  return success({ ...(await listBrowse(context.env.DB, offset, limit, input.query.trail)), offset, limit });
};
const logBrowseOperation = async (context: OperationContext, input: OperationInput) => {
  const b = (input.body as { trail: string; parent_id?: number | null; origin: string; remote_id: string; version?: number | null; via: BrowseVia; title?: string | null });
  const id = await recordBrowse(context.env.DB, { trail: b.trail, parentId: b.parent_id, origin: b.origin, remoteId: b.remote_id, version: b.version, via: b.via, title: b.title, at: new Date().toISOString() });
  return created({ id });
};
const clearBrowseOperation = async (context: OperationContext, input: OperationInput) => {
  await clearBrowse(context.env.DB, input.query.trail);
  return success({ ok: true });
};
const getUpdateStateOperation = async (context: OperationContext, input: OperationInput) => {
  const [settings, map] = await Promise.all([getSettings(context.env.DB), getSettingsMap(context.env.DB)]);
  context.defer(maybeCheckForUpdate(context.env.DB, settings, map, Date.now()).catch(() => {}));
  return success(Object.fromEntries(Object.entries(map).filter(([key]) => key.startsWith("update_"))));
};
const getMentionSourceOperation = async (context: OperationContext, input: OperationInput) => {
  const row = await getInbound(context.env.DB, input.path.id);
  if (!row) return failure('not-found', { error: "not found" });
  const holder = await context.env.DB.prepare("SELECT s.id AS id FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id WHERE ii.remote_id = ? AND s.origin = ? LIMIT 1").bind(row.source_id, row.source_origin).first<{ id: string }>();
  const subscription = (await listSubscriptions(context.env.DB)).find((s) => s.origin === row.source_origin) ?? null;
  return success({ holder: holder?.id ?? null, subscription: subscription ? subscriptionResource(subscription) : null });
};
const getForkOptionsOperation = async (context: OperationContext, input: OperationInput) => {
  const settings = await getSettings(context.env.DB), mount = normalizeMount(context.env.MOUNT);
  const ourOrigin = siteOrigin(settings, context.url, mount);
  const sub = input.query.sub;
  const fromSub = sub ? (await listSubscriptions(context.env.DB)).find((s) => s.id === sub)?.origin : undefined;
  const origin = normalizeOrigin(fromSub ?? input.query.origin) ?? ourOrigin;
  const result = await forkablePins(context.env.DB, origin, input.query.id ?? "", ourOrigin, mentionFetchFor(context.env));
  return success({ ...result, origin, ourOrigin });
};
const previewOperation = async (context: OperationContext, input: OperationInput) => {
  const mount = normalizeMount(context.env.MOUNT);
  const body = (input.body as { content_md?: string });
  if ((body as { kind?: string }).kind === "thread") return threadPreview(context, input);
  const tk = annotateTkPreview(body.content_md ?? "");
  // `[[id]]` resolves in the preview too, so an unresolvable link is visible
  // before publish rejects it — same contract as an unresolvable directive.
  const origin = siteOrigin(await getSettings(context.env.DB), context.url, mount);
  const links = await previewInternalLinks(context.env.DB, tk.text, origin);
  // Links inside generated blocks resolve here too, as at publish (studio#14).
  const blocks = await resolveBlockLinks(tk, (md) => previewInternalLinks(context.env.DB, md, origin));
  const html = [links, ...blocks.docs].reduce((acc, doc) => applyInternalLinks(acc, doc), tk.finish(renderMarkdown(links.text)));
  return success({ html, scopes: await scopeSummariesWithSources(context.env.DB, tk.scopes), link_errors: [...links.errors, ...blocks.errors] });
};

/**
 * Read one past version for the editor's history viewer. Studio-only: the
 * stored `content_html` of any version, pinned or not — unlike the public
 * `items/{id}/vN.json` surface, which serves pinned versions only (§2.8).
 * Reading history locally is not the same act as promising it publicly.
 */
const getVersionOperation = async (context: OperationContext, input: OperationInput) => {
  const item = await getItem(context.env.DB, input.path.id);
  if (!item) return failure('not-found', { error: "not found" });
  const version = Number(input.path.v);
  const row = await getVersion(context.env.DB, item.id, version);
  if (!row) return failure('not-found', { error: "version not found" });
  return success(await presentVersion(row));
};

/**
 * The bracket palette's candidate list (§3.2). Searches everything v0.3 lets a
 * thread transclude: own published items of **either** kind (nesting is legal
 * from this version) and imported blyg items (`current`, non-L0) — which is
 * what makes quoting follow reading. The route keeps its 0.1 name; only its
 * subject widened.
 *
 * One list serves both bracket forms, and that is not a convenience: `[[id]]`
 * resolves through `resolveTarget` too — "by the same order", §10.1 — so the
 * set of ids a link can name *is* the set a directive can name. A second
 * endpoint would be a second copy of that rule, free to drift from it.
 */
const SEARCH_PAGE = 20;

const searchOperation = async (context: OperationContext, input: OperationInput) => {
  const source = input.query.source === "mine" || input.query.source === "imported" ? input.query.source : "all";
  const sub = input.query.sub || undefined;
  const order = input.query.sort === "oldest" ? "ASC" : "DESC";
  // Every word must appear somewhere in the item's text or id, in any order.
  // lower() folds ASCII only; that is the "rudimentary" in rudimentary
  // search, and FTS5 is the upgrade if it ever matters. instr, not LIKE: D1
  // caps LIKE patterns at 50 bytes, so a pasted URL as a search word threw.
  const words = (input.query.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const textMatch = (text: string, id: string) => words.map(() => `(instr(lower(${text}), lower(?)) > 0 OR instr(lower(${id}), lower(?)) > 0)`).join(" AND ");
  const wordBinds = words.flatMap((w) => [w, w]);
  const parts: string[] = [];
  const binds: unknown[] = [];
  if (source !== "imported" && !sub) {
    parts.push(`SELECT 'mine' AS source, i.id AS id, v.content_html AS html, i.version AS version, i.updated AS updated, i.kind AS kind,
        NULL AS subscription_id, NULL AS source_title, NULL AS origin
      FROM items i JOIN versions v ON v.item_id = i.id AND v.version = i.version
      WHERE i.status = 'public' AND i.kind IN ('fragment', 'thread')${words.length ? " AND " + textMatch("v.content_md", "i.id") : ""}`);
    binds.push(...wordBinds);
  }
  if (source !== "mine") {
    // Exactly what resolveTarget will accept at publish, so the picker never
    // offers something the author then can't publish.
    parts.push(`SELECT 'imported' AS source, ii.remote_id AS id, ii.content_html AS html,
        CASE WHEN ii.state = 'current' THEN ii.version ELSE ii.pinned_version_retained END AS version,
        ii.observed_at AS updated, ii.kind AS kind, s.id AS subscription_id, s.title AS source_title, s.origin AS origin
      FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id
      WHERE ii.l0 = 0 AND (ii.state = 'current' OR ii.pinned_version_retained IS NOT NULL)${sub ? " AND s.id = ?" : ""}${words.length ? " AND " + textMatch("ii.content_md", "ii.remote_id") : ""}`);
    if (sub) binds.push(sub);
    binds.push(...wordBinds);
  }
  const offset = Math.max(0, Number(input.query.offset ?? 0) || 0);
  const limit = Math.min(100, Math.max(1, Number(input.query.limit ?? SEARCH_PAGE) || SEARCH_PAGE));
  if (!parts.length) return success({ items: [], total: 0, offset, limit });
  const union = parts.join(" UNION ALL ");
  const [rows, count] = await context.env.DB.batch([
    context.env.DB.prepare(`SELECT * FROM (${union}) ORDER BY updated ${order}, id ${order} LIMIT ? OFFSET ?`).bind(...binds, limit, offset),
    context.env.DB.prepare(`SELECT COUNT(*) AS n FROM (${union})`).bind(...binds),
  ]);
  type Row = { source: "mine" | "imported"; id: string; html: string | null; version: number; updated: string; kind: string; subscription_id: string | null; source_title: string | null; origin: string | null };
  const items = (rows.results as Row[]).map((r) => {
    // From rendered HTML, not markdown source — the picker showed literal
    // "#"/"*" markers otherwise, same bug class as the index rows.
    const excerpt = clampText(plainTextFromHtml(r.html ?? ""), 140);
    const label = linkLabel(r.html ?? "", r.kind);
    const sourceTitle = r.source === "mine" ? null : r.source_title || (r.origin ? new URL(r.origin).host : null);
    return {
      id: r.id,
      excerpt,
      label,
      version: r.version,
      updated: r.updated,
      // Pre-0.29 field, kept for existing clients: the kind for own items, the source for imports.
      badge: r.source === "mine" ? r.kind : (sourceTitle ?? ""),
      source: r.source,
      kind: r.kind === "thread" ? ("thread" as const) : ("fragment" as const),
      subscription_id: r.subscription_id,
      source_title: sourceTitle,
    };
  });
  return success({ items, total: (count.results[0] as { n: number }).n, offset, limit });
};


async function threadPreview(context: OperationContext, input: OperationInput) {
  const body = (input.body as { content_md?: string; item_id?: string });
  const tk = annotateTkPreview(body.content_md ?? "");
  // item_id is the thread being edited — the DAG check needs it, so the
  // preview rejects a circular quote at exactly the point publish would.
  const mount = normalizeMount(context.env.MOUNT);
  const origin = siteOrigin(await getSettings(context.env.DB), context.url, mount);
  const links = await previewInternalLinks(context.env.DB, tk.text, origin);
  const blocks = await resolveBlockLinks(tk, (md) => previewInternalLinks(context.env.DB, md, origin));
  const resolved = await previewTransclusions(context.env.DB, links.text, body.item_id);
  return success({
    html: [links, ...blocks.docs].reduce((acc, doc) => applyInternalLinks(acc, doc), tk.finish(resolved.html)),
    errors: [...resolved.errors, ...links.errors, ...blocks.errors],
    transclusions: resolved.transclusions,
    scopes: await scopeSummariesWithSources(context.env.DB, tk.scopes),
  });
}
async function forkablePins(
  db: D1Database,
  origin: string,
  id: string,
  ourOrigin: string,
  fetchFn: import("./importer/http.ts").FetchLike,
): Promise<{ versions: { version: number; at: string; note: string | null }[]; error?: string }> {
  if (!id) return { versions: [], error: "no item named" };
  if (origin === ourOrigin) {
    const rows = await listVersions(db, id);
    return {
      versions: rows
        .filter((v) => v.pinned === 1 && versionState(v) !== 'withdrawn')
        .map((v) => ({ version: v.version, at: v.published_at, note: v.note })),
    };
  }
  let res, docUrl = itemUrl(origin, null, id);
  try {
    ({ res, url: docUrl } = await fetchOnSurface(db, origin, fetchFn, (s) => itemUrl(origin, s, id)));
  } catch {
    return { versions: [], error: `could not reach ${origin}` };
  }
  if (!res.ok) return { versions: [], error: `${docUrl} returned ${res.status}` };
  try {
    const doc = JSON.parse(await res.text()) as { changelog?: { version: number; at: string; note: string | null; pinned?: boolean }[] };
    const log = Array.isArray(doc.changelog) ? doc.changelog : [];
    return { versions: log.filter((v) => v.pinned === true).map((v) => ({ version: v.version, at: v.at, note: v.note ?? null })) };
  } catch {
    return { versions: [], error: "that origin's item document could not be parsed" };
  }
}

export const readOperations = {
  getCapabilities: getCapabilitiesOperation,
  getChanges: getChangesOperation,
  listItems: listItemsOperation,
  getItem: getItemOperation,
  getSettings: getSettingsOperation,
  listSubscriptions: listSubscriptionsOperation,
  getSubscription: getSubscriptionOperation,
  listHoppers: listHoppersOperation,
  getHopper: getHopperOperation,
  listSignals: listSignalsOperation,
  listMentions: listMentionsOperation,
  listInteractions: listInteractionsOperation,
  getAiModels: getAiModelsOperation,
  listThumbs: listThumbsOperation,
  listReading: listReadingOperation,
  listImportedReading: listImportedReadingOperation,
  getImportedItem: getImportedItemOperation,
  getImportedHistory: getImportedHistoryOperation,
  getImportedVersion: getImportedVersionOperation,
  peekItem: peekItemOperation,
  classifyLinks: classifyLinksOperation,
  listBrowse: listBrowseOperation,
  logBrowse: logBrowseOperation,
  clearBrowse: clearBrowseOperation,
  getUpdateState: getUpdateStateOperation,
  getMentionSource: getMentionSourceOperation,
  getForkOptions: getForkOptionsOperation,
  preview: previewOperation,
  getVersion: getVersionOperation,
  search: searchOperation,
};
