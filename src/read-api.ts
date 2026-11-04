import { success, created, failure, modelFailure, type OperationContext, type OperationInput } from './operation-types.ts';
import { itemResource, versionResource, mediaResource, subscriptionResource, hopperResource, importedResource, mentionResource, membershipResource, signalResource, outboundMentionResource, interactionResource, thumbResource, browseResource } from "./contract/resources.ts";
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
import type { ChangeClassRow } from "./change-class.ts";
import { withLabels, type InteractionRow } from "./interactions.ts";
import { normalizeMount } from "./util.ts";
import type { SignalRow, ImportedItemRow, ItemRow, SubscriptionRow, HopperRow, HopperItemRow, VersionRow, MentionInRow, MentionOutRow } from "./types.ts";
import { itemDetail } from "./item-data.ts";
import { readingData, readingSummary } from "./reading-data.ts";
import { IMPORTED_READING_DEFAULT, importedReading } from "./imported-reading.ts";
import { getInbound } from "./mentions/store.ts";
import { maybeCheckForUpdate } from "./update-check.ts";
import { normalizeOrigin } from "./stub.ts";
import { mentionFetchFor } from "./mentions/http.ts";
import { platformFetchFor } from "./importer/http.ts";
import { recordBrowse, clearBrowse, type BrowseVia, type BrowseRow } from "./browse-log.ts";
import { classifyLinks, peekItem } from "./peek.ts";
import { fetchImportedHistory, fetchPublicVersion } from "./imported-history.ts";
import { readChanges } from './changes.ts';
import { linkLabel } from "./link-label.ts";
import { authoredItemKindSql } from './version-state.ts';
import { versionState } from './version-state.ts';
import { operationAvailability } from './operation-availability.ts';
import { API_CONTRACT_VERSION } from './operation-policy.ts';
import { deploymentUrls } from './deployment-urls.ts';
import { cursorPage } from './cursor-page.ts';
import { mentionGroups, mentionSummary } from './mention-groups.ts';

const getCapabilitiesOperation = async (context: OperationContext, input: OperationInput) => {
  return success({ contractVersion: API_CONTRACT_VERSION, endpoints: deploymentUrls(context.url, context.env),
    ...await operationAvailability(context.env.DB, context.access, context.extensions) });
};
const getChangesOperation = async (context: OperationContext, input: OperationInput) => success(await readChanges(context.env.DB));
// Pin history retains the legacy nullness rule for unresolved version kinds.
const pinKindSql = `CASE WHEN kind IN ('fragment','thread') THEN kind WHEN transclusions IS NULL THEN 'fragment' ELSE 'thread' END`;
const listItemsOperation = async (context: OperationContext, input: OperationInput) => {
  const filters = [input.query.status ?? null, input.query.dirty ?? null, input.query.version ?? null, input.query.id ?? null, input.query.updated ?? null];
  const where: string[] = [], binds: (string | number)[] = [];
  if (input.query.status) { where.push('i.status = ?'); binds.push(input.query.status); }
  if (input.query.dirty) { where.push('i.dirty = ?'); binds.push(input.query.dirty === 'true' ? 1 : 0); }
  if (input.query.id) { where.push('i.id = ?'); binds.push(input.query.id); }
  if (input.query.updated) { where.push('i.updated = ?'); binds.push(input.query.updated); }
  if (input.query.version) { where.push('i.version = ?'); binds.push(Number(input.query.version)); }
  return success(await cursorPage<ItemRow & { authored_kind: 'fragment' | 'thread' }, ReturnType<typeof itemResource> & { pins: { version: number; kind: 'fragment' | 'thread' }[] }>(context.env.DB, input.query, {
    name: 'items', filters, domains: ['items'], binds,
    sql: `SELECT i.*, ${authoredItemKindSql('p')} AS authored_kind FROM items i LEFT JOIN versions p ON p.item_id=i.id AND p.version=i.version-1${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
    order: [{ column: 'updated', direction: 'desc' }, { column: 'id', direction: 'desc' }],
    project: async rows => {
      // Frozen links, without history bodies. The projection is inside the generation guard.
      const pins = rows.length ? (await context.env.DB.prepare(`SELECT item_id, version, ${pinKindSql} AS kind FROM versions WHERE pinned = 1 AND item_id IN (${rows.map(() => '?').join(',')}) ORDER BY version`).bind(...rows.map(row => row.id)).all<{ item_id: string; version: number; kind: 'fragment' | 'thread' }>()).results : [];
      return rows.map(row => ({ ...itemResource(row, row.authored_kind), pins: pins.filter(pin => pin.item_id === row.id).map(({ version, kind }) => ({ version, kind })) }));
    },
  }));
};
// Owner DTOs feed HTML previews. Sanitize copies, not immutable version rows or
// public protocol snapshots, so legacy bakes cannot regain browser authority.
async function presentVersion(row: Parameters<typeof versionResource>[0]) {
  return versionResource({ ...row, content_html: await sanitizeHtml(row.content_html) });
}
async function presentVersions(db: D1Database, rows: VersionRow[]) {
  const classes = rows.length ? (await db.prepare('SELECT * FROM change_class WHERE item_id = ? AND version IN (SELECT value FROM json_each(?))').bind(rows[0].item_id, JSON.stringify(rows.map(row => row.version))).all<ChangeClassRow>()).results : [];
  return Promise.all(rows.map(async row => {
    const cls = classes.find(value => value.version === row.version);
    return { ...await presentVersion(row), changeClass: cls ? { category: cls.category, model: cls.model, probability: cls.probability, classifiedAt: cls.classified_at, overridden: cls.overridden === 1 } : null };
  }));
}
const getItemSummaryOperation = async (context: OperationContext) => success(await context.env.DB.prepare(`SELECT COUNT(*) AS 'all', COALESCE(SUM(version=0),0) AS drafts, COALESCE(SUM(dirty=1 AND status='public'),0) AS changes, COALESCE(SUM(status='public'),0) AS public, COALESCE(SUM(status='withdrawn'),0) AS withdrawn FROM items`).first());
const getItemOperation = async (context: OperationContext, input: OperationInput) => {
  const detail = await itemDetail(context.env.DB, input.path.id);
  if (!detail) return failure('not-found', { error: 'not found' });
  const publicBase = deploymentUrls(context.url, context.env).publicBase;
  const pins = (await context.env.DB.prepare(`SELECT version, ${pinKindSql} AS kind FROM versions WHERE item_id = ? AND pinned = 1 ORDER BY version`).bind(detail.item.id).all<{ version: number; kind: 'fragment' | 'thread' }>()).results;
  return success({
    ...itemResource(detail.item, detail.kind), pins,
    media: detail.media.map(row => mediaResource(row, publicBase)),
    publishedMedia: detail.publishedMedia.map(row => mediaResource(row, publicBase)),
    published: detail.published ? (await presentVersions(context.env.DB, [detail.published]))[0] : null,
  });
};
const listItemVersionsOperation = async (context: OperationContext, input: OperationInput) => {
  if (!await getItem(context.env.DB, input.path.id)) return failure('not-found', { error: 'not found' });
  return success(await cursorPage<VersionRow, Awaited<ReturnType<typeof presentVersions>>[number]>(context.env.DB, input.query, {
    name: 'item-versions', filters: [input.path.id, input.query.version ?? null], domains: ['items'],
    sql: `SELECT * FROM versions WHERE item_id = ?${input.query.version ? ' AND version = ?' : ''}`, binds: [input.path.id, ...(input.query.version ? [Number(input.query.version)] : [])],
    order: [{ column: 'version', direction: 'desc' }], project: rows => presentVersions(context.env.DB, rows),
  }));
};
const getSettingsOperation = async (context: OperationContext, input: OperationInput) => success(settingsResource(await getSettings(context.env.DB)));
const listSubscriptionsOperation = async (context: OperationContext, input: OperationInput) => success(await cursorPage<SubscriptionRow, ReturnType<typeof subscriptionResource>>(context.env.DB, input.query, {
  name: 'subscriptions', domains: ['subscriptions'], sql: 'SELECT * FROM subscriptions',
  order: [{ column: 'created', direction: 'asc' }, { column: 'id', direction: 'asc' }], project: rows => rows.map(subscriptionResource),
}));
const getSubscriptionOperation = async (context: OperationContext, input: OperationInput) => {
  const sub = await getSubscription(context.env.DB, input.path.id);
  return sub ? success(subscriptionResource(sub)) : failure('not-found', { error: "not found" });
};
const listHoppersOperation = async (context: OperationContext, input: OperationInput) => success(await cursorPage<HopperRow, ReturnType<typeof hopperResource>>(context.env.DB, input.query, {
  name: 'hoppers', domains: ['hoppers'], sql: 'SELECT * FROM hoppers',
  order: [{ column: 'created', direction: 'asc' }, { column: 'id', direction: 'asc' }], project: rows => rows.map(hopperResource),
}));
const getHopperOperation = async (context: OperationContext, input: OperationInput) => {
  const hopper = await getHopper(context.env.DB, input.path.id);
  if (!hopper) return failure('not-found', { error: 'not found' });
  const counts = await context.env.DB.prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT CASE WHEN subscription_id <> '~own' THEN subscription_id END) AS source_count FROM hopper_items WHERE hopper_id = ?").bind(hopper.id).first<{ total: number; source_count: number }>();
  return success({ hopper: hopperResource(hopper), total: counts?.total ?? 0, sourceCount: counts?.source_count ?? 0 });
};
const listHopperMembershipsOperation = async (context: OperationContext, input: OperationInput) => {
  if (!await getHopper(context.env.DB, input.path.id)) return failure('not-found', { error: 'not found' });
  return success(await cursorPage<HopperItemRow, ReturnType<typeof membershipResource> & { item: ReturnType<typeof importedResource> | null }>(context.env.DB, input.query, {
    name: 'hopper-memberships', filters: [input.path.id], domains: ['hoppers', 'reading', 'subscriptions'],
    sql: 'SELECT * FROM hopper_items WHERE hopper_id = ?', binds: [input.path.id],
    order: [{ column: 'added_at', direction: 'desc' }, { column: 'subscription_id', direction: 'asc' }, { column: 'remote_id', direction: 'asc' }],
    project: async rows => {
      const bodies = rows.length ? (await context.env.DB.prepare(`SELECT * FROM imported_items WHERE (subscription_id, remote_id) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`).bind(JSON.stringify(rows.map(row => [row.subscription_id, row.remote_id]))).all<ImportedItemRow>()).results : [];
      return Promise.all(rows.map(async row => {
        const body = bodies.find(item => item.subscription_id === row.subscription_id && item.remote_id === row.remote_id);
        return { ...membershipResource(row), item: body ? importedResource({ ...body, content_html: await sanitizeHtml(body.content_html) }) : null };
      }));
    },
  }));
};
const listSignalsOperation = async (context: OperationContext, input: OperationInput) => success(await cursorPage<SignalRow, ReturnType<typeof signalResource>>(context.env.DB, input.query, {
  name: 'signals', domains: ['signals'], sql: 'SELECT * FROM signals',
  order: [{ column: 'at', direction: 'desc' }, { column: 'subscription_id', direction: 'asc' }, { column: 'remote_id', direction: 'asc' }], project: rows => rows.map(signalResource),
}));
const listMentionsOperation = async (context: OperationContext, input: OperationInput) => {
  const query = input.query, direction = query.direction ?? 'inbound';
  const inboundOnly = ['targetItemId', 'verifiedAt', 'verifiedAtNull', 'lastSeen'];
  if (direction === 'outbound' && inboundOnly.some(key => query[key] !== undefined) ||
      direction === 'inbound' && query.created !== undefined ||
      query.verifiedAt !== undefined && query.verifiedAtNull !== undefined)
    return failure('invalid-input', { error: 'Mention filters do not match the selected direction or combine verifiedAt with verifiedAtNull' });
  const fields = direction === 'inbound'
    ? [['targetItemId', 'target_item_id'], ['verifiedAt', 'verified_at'], ['verifiedAtNull', 'verified_at'], ['lastSeen', 'last_seen'], ['id', 'id']] as const
    : [['created', 'created'], ['id', 'id']] as const;
  const where: string[] = direction === 'inbound' ? ["status IN ('verified','gone')"] : [];
  const binds: (string | null)[] = [], filters: (string | null)[] = [];
  for (const [key, column] of fields) {
    if (query[key] === undefined) { filters.push(null); continue; }
    const value = key === 'verifiedAtNull' ? null : query[key];
    where.push(`${column} IS ?`); binds.push(value); filters.push(query[key]);
  }
  // Preserve every existing unfiltered v1 cursor identity.
  const identity = fields.some(([key]) => query[key] !== undefined) ? [direction, ...filters] : [direction];
  const sql = `SELECT * FROM ${direction === 'inbound' ? 'mentions_in' : 'mentions_out'}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  const page = direction === 'outbound'
    ? await cursorPage<MentionOutRow, ReturnType<typeof outboundMentionResource>>(context.env.DB, query, {
        name: 'mentions', filters: identity, domains: ['mentions'], sql, binds,
        order: [{ column: 'created', direction: 'desc' }, { column: 'id', direction: 'asc' }], project: rows => rows.map(outboundMentionResource),
      })
    : await cursorPage<MentionInRow, ReturnType<typeof mentionResource>>(context.env.DB, query, {
        name: 'mentions', filters: identity, domains: ['mentions'], sql, binds,
        order: [{ column: 'verified_at', direction: 'desc' }, { column: 'last_seen', direction: 'desc' }, { column: 'id', direction: 'asc' }], project: rows => rows.map(mentionResource),
      });
  return success({ ...page, direction });
};
const listMentionGroupsOperation = async (context: OperationContext, input: OperationInput) => success(await mentionGroups(context.env.DB, input.query));
const getMentionSummaryOperation = async (context: OperationContext) => success(await mentionSummary(context.env.DB));
const listInteractionsOperation = async (context: OperationContext, input: OperationInput) => {
  const query = input.query, where: string[] = [], binds: (string | number)[] = [];
  for (const field of ['kind', 'id', 'at'] as const) if (query[field] !== undefined) { where.push(`${field} = ?`); binds.push(field === 'id' ? Number(query[field]) : query[field]); }
  return success(await cursorPage<InteractionRow, ReturnType<typeof interactionResource>>(context.env.DB, query, {
    name: 'interactions', filters: [query.kind ?? null, query.id ?? null, query.at ?? null], domains: ['interactions', 'reading', 'subscriptions'],
    sql: `SELECT * FROM interactions${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`, binds,
    order: [{ column: 'at', direction: 'desc' }, { column: 'id', direction: 'desc' }],
    project: async rows => (await withLabels(context.env.DB, rows)).map(interactionResource),
  }));
};
const getAiModelsOperation = async (context: OperationContext, input: OperationInput) => {
  const configured = configuredProviders(context.env);
  return success({
    // Names only: never a key's value, a base_url (it may be a private
    // endpoint) or request params.
    providers: Object.entries(MODELS.providers).map(([id, p]) => ({
      id,
      label: p.label,
      ...(p.key_secret ? { keySecret: p.key_secret } : {}),
      ...(p.api === "workers-ai" ? { binding: bindingName(p) } : {}),
      configured: configured[id] ?? false,
    })),
    // A decision model is marked so Settings lists it only for the classifier.
    models: MODELS.models.map(({ id, provider, label, note }) => ({ id, provider, label, ...(note ? { note } : {}), ...(isDecisionModel(id) ? { kind: "decision" as const } : {}) })),
    local: MODELS.local,
  });
};
const getSignalSummaryOperation = async (context: OperationContext) => success(await context.env.DB.prepare(`SELECT COALESCE(SUM(thumb=1),0) AS liked, COALESCE(SUM(thumb=-1),0) AS disliked, (SELECT COUNT(*) FROM interactions) AS activity FROM signals`).first());
const listThumbsOperation = async (context: OperationContext, input: OperationInput) => {
  const query = input.query, where: string[] = [], binds: (string | number)[] = [];
  for (const [field, column] of [['thumb', 'thumb'], ['at', 'at'], ['subscriptionId', 'subscription_id'], ['remoteId', 'remote_id']] as const) if (query[field] !== undefined) { where.push(`sig.${column} = ?`); binds.push(field === 'thumb' ? Number(query[field]) : query[field]); }
  return success(await cursorPage<{ thumb: 1 | -1; at: string; origin: string; remote_id: string; cursor_sub: string }, ReturnType<typeof thumbResource>>(context.env.DB, query, {
    name: 'thumbs', filters: [query.thumb ?? null, query.at ?? null, query.subscriptionId ?? null, query.remoteId ?? null], binds, domains: ['signals', 'reading', 'subscriptions'],
    sql: `SELECT sig.thumb, sig.at, sub.origin, sig.remote_id, sig.subscription_id AS cursor_sub FROM signals sig JOIN subscriptions sub ON sub.id = sig.subscription_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
    order: [{ column: 'at', direction: 'desc' }, { column: 'cursor_sub', direction: 'asc' }, { column: 'remote_id', direction: 'asc' }],
    project: async rows => (await withLabels(context.env.DB, rows)).map(row => thumbResource({ ...row, subscription_id: row.cursor_sub })),
  }));
};
// `read_state: true` advertises that imported entries carry the owner's
// readVersion, so a client can tell "unread" from "this server keeps none".
const listReadingOperation = async (context: OperationContext, input: OperationInput) => success({ ...await readingData(context.env.DB, { ...input.query, limit: input.query.limit ?? 25 }, input.query.sub, readingKind(input.query.kind), input.query.background === 'true', input.query.hopper), readState: true as const, readStateClear: true as const });
const getReadingSummaryOperation = async (context: OperationContext, input: OperationInput) => success(await readingSummary(context.env.DB, input.query.sub, readingKind(input.query.kind), input.query.background === 'true', input.query.hopper));
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
  return got.ok ? success({ version: got.value.version, contentMd: got.value.content_md, note: got.value.note, pinned: got.value.pinned }) : modelFailure({ error: got.error }, got.status);
};
// Following links out of an entry (0.49.0). `peekItem` reads one item from its own blyg
// without subscribing; `classifyLinks` says which of an entry's links name blyg items.
const peekItemOperation = async (context: OperationContext, input: OperationInput) => {
  const got = await peekItem(context.env.DB, platformFetchFor(context.env), input.query.origin ?? "", input.query.id ?? "");
  return got.ok ? success({ origin: got.value.origin, id: got.value.id, kind: got.value.kind, version: got.value.version, contentHtml: got.value.content_html, page: got.value.page, url: got.value.url, stubOf: got.value.stub_of, forkedFrom: got.value.forked_from, subscriptionId: got.value.subscription_id }) : modelFailure({ error: got.error }, got.status);
};
const classifyLinksOperation = async (context: OperationContext, input: OperationInput) => {
  const { urls } = (input.body as { urls: string[] });
  const settings = await getSettings(context.env.DB);
  const ourOrigin = siteOrigin(settings, context.url, normalizeMount(context.env.MOUNT));
  return success({ links: await classifyLinks(context.env.DB, platformFetchFor(context.env), urls, ourOrigin, new Date().toISOString()) });
};
const listBrowseOperation = async (context: OperationContext, input: OperationInput) => {
  const where: string[] = [], binds: (string | number)[] = [];
  if (input.query.trail) { where.push('trail = ?'); binds.push(input.query.trail); }
  if (input.query.id) { where.push('id = ?'); binds.push(Number(input.query.id)); }
  return success(await cursorPage<BrowseRow, ReturnType<typeof browseResource>>(context.env.DB, input.query, {
    name: 'browse', filters: [input.query.trail ?? null, input.query.id ?? null], domains: ['browse'],
    sql: `SELECT * FROM browse_log${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`, binds,
    order: [{ column: 'id', direction: 'desc' }], project: rows => rows.map(browseResource),
  }));
};
const logBrowseOperation = async (context: OperationContext, input: OperationInput) => {
  const b = (input.body as { trail: string; parentId?: number | null; origin: string; remoteId: string; version?: number | null; via: BrowseVia; title?: string | null });
  const id = await recordBrowse(context.env.DB, { trail: b.trail, parentId: b.parentId, origin: b.origin, remoteId: b.remoteId, version: b.version, via: b.via, title: b.title, at: new Date().toISOString() });
  return created({ id });
};
const clearBrowseOperation = async (context: OperationContext, input: OperationInput) => {
  await clearBrowse(context.env.DB, input.query.trail);
  return success({ ok: true });
};
const getUpdateStateOperation = async (context: OperationContext, input: OperationInput) => {
  const [settings, map] = await Promise.all([getSettings(context.env.DB), getSettingsMap(context.env.DB)]);
  context.defer(maybeCheckForUpdate(context.env.DB, settings, map, Date.now()).catch(() => {}));
  return success({ ...(map.update_checked_at ? { updateCheckedAt: map.update_checked_at } : {}), ...(map.update_latest_seen ? { updateLatestSeen: map.update_latest_seen } : {}) });
};
const getMentionSourceOperation = async (context: OperationContext, input: OperationInput) => {
  const row = await getInbound(context.env.DB, input.path.id);
  if (!row) return failure('not-found', { error: "not found" });
  const holder = await context.env.DB.prepare("SELECT s.id AS id FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id WHERE ii.remote_id = ? AND s.origin = ? AND s.hopper_feed IS NULL LIMIT 1").bind(row.source_id, row.source_origin).first<{ id: string }>();
  const subscription = await context.env.DB.prepare("SELECT * FROM subscriptions WHERE origin = ? AND (hopper_feed IS NULL OR hopper_feed = '') ORDER BY created LIMIT 1")
    .bind(row.source_origin).first<SubscriptionRow>();
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
  const body = (input.body as { contentMd?: string });
  if ((body as { kind?: string }).kind === "thread") return threadPreview(context, input);
  const tk = annotateTkPreview(body.contentMd ?? "");
  // `[[id]]` resolves in the preview too, so an unresolvable link is visible
  // before publish rejects it — same contract as an unresolvable directive.
  const origin = siteOrigin(await getSettings(context.env.DB), context.url, mount);
  const links = await previewInternalLinks(context.env.DB, tk.text, origin);
  // Links inside generated blocks resolve here too, as at publish (studio#14).
  const blocks = await resolveBlockLinks(tk, (md) => previewInternalLinks(context.env.DB, md, origin));
  const html = [links, ...blocks.docs].reduce((acc, doc) => applyInternalLinks(acc, doc), tk.finish(renderMarkdown(links.text)));
  return success({ html, scopes: await scopeSummariesWithSources(context.env.DB, tk.scopes), linkErrors: [...links.errors, ...blocks.errors] });
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
  // Opt-in, for the compose page: own drafts and unpublished changes match by
  // their working copy. The default stays exactly what resolveTarget accepts.
  const drafts = input.query.include === "drafts";
  const order = input.query.sort === "oldest" ? "ASC" : "DESC";
  // Every word must appear somewhere in the item's text or id, in any order.
  // lower() folds ASCII only; that is the "rudimentary" in rudimentary
  // search, and FTS5 is the upgrade if it ever matters. instr, not LIKE: D1
  // caps LIKE patterns at 50 bytes, so a pasted URL as a search word threw.
  const words = (input.query.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const textMatch = (text: string, id: string) => words.map(() => `(instr(lower(${text}), lower(?)) > 0 OR instr(lower(${id}), lower(?)) > 0)`).join(" AND ");
  const wordBinds = words.flatMap((w) => [w, w]);
  const parts: string[] = [];
  const binds: string[] = [];
  if (source !== "imported" && !sub && drafts) {
    // A clean published item's working copy is its published text, so one
    // match on i.content_md covers drafts, unpublished changes and the rest.
    parts.push(`SELECT 'mine' AS source, i.id AS id, CASE WHEN i.dirty = 1 OR i.version = 0 THEN NULL ELSE v.content_html END AS html,
        i.version AS version, i.updated AS updated, i.kind AS kind,
        NULL AS subscription_id, NULL AS source_title, NULL AS origin,
        CASE WHEN i.dirty = 1 OR i.version = 0 THEN i.content_md END AS draft_md
      FROM items i LEFT JOIN versions v ON v.item_id = i.id AND v.version = i.version
      WHERE i.status IN ('public', 'draft') AND i.kind IN ('fragment', 'thread')${words.length ? " AND " + textMatch("i.content_md", "i.id") : ""}`);
    binds.push(...wordBinds);
  } else if (source !== "imported" && !sub) {
    parts.push(`SELECT 'mine' AS source, i.id AS id, v.content_html AS html, i.version AS version, i.updated AS updated, i.kind AS kind,
        NULL AS subscription_id, NULL AS source_title, NULL AS origin, NULL AS draft_md
      FROM items i JOIN versions v ON v.item_id = i.id AND v.version = i.version
      WHERE i.status = 'public' AND i.kind IN ('fragment', 'thread')${words.length ? " AND " + textMatch("v.content_md", "i.id") : ""}`);
    binds.push(...wordBinds);
  }
  if (source !== "mine") {
    // Exactly what resolveTarget will accept at publish, so the picker never
    // offers something the author then can't publish.
    parts.push(`SELECT 'imported' AS source, ii.remote_id AS id, ii.content_html AS html,
        CASE WHEN ii.state = 'current' THEN ii.version ELSE ii.pinned_version_retained END AS version,
        ii.observed_at AS updated, ii.kind AS kind, s.id AS subscription_id, s.title AS source_title, s.origin AS origin, NULL AS draft_md
      FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id
      WHERE ii.l0 = 0 AND (ii.state = 'current' OR ii.pinned_version_retained IS NOT NULL)${sub ? " AND s.id = ?" : ""}${words.length ? " AND " + textMatch("ii.content_md", "ii.remote_id") : ""}`);
    if (sub) binds.push(sub);
    binds.push(...wordBinds);
  }
  type Row = { source: 'mine' | 'imported'; id: string; html: string | null; version: number; updated: string; kind: string; subscription_id: string | null; source_title: string | null; origin: string | null; draft_md: string | null };
  return success(await cursorPage(context.env.DB, { ...input.query, limit: input.query.limit ?? SEARCH_PAGE }, {
    name: 'search', filters: [words, source, sub ?? null, order, drafts], domains: ['items', 'reading', 'subscriptions'],
    sql: parts.length ? parts.join(' UNION ALL ') : 'SELECT NULL AS source, NULL AS id, NULL AS updated, NULL AS subscription_id WHERE 0', binds,
    order: ['updated', 'id', 'source', 'subscription_id'].map(column => ({ column, direction: order === 'ASC' ? 'asc' as const : 'desc' as const })),
    project: (rows: Row[]) => rows.map((r) => {
    // From rendered HTML, not markdown source — the picker showed literal
    // "#"/"*" markers otherwise, same bug class as the index rows.
    // A draft has no rendered HTML yet: its excerpt comes from the working copy.
    const html = r.draft_md !== null ? renderMarkdown(r.draft_md) : r.html ?? "";
    const excerpt = clampText(plainTextFromHtml(html), 140);
    const label = linkLabel(html, r.kind);
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
      subscriptionId: r.subscription_id,
      sourceTitle: sourceTitle,
      ...(drafts && r.source === "mine" ? { draft: r.draft_md !== null } : {}),
    };
    }),
  }));
};


async function threadPreview(context: OperationContext, input: OperationInput) {
  const body = (input.body as { contentMd?: string; itemId?: string });
  const tk = annotateTkPreview(body.contentMd ?? "");
  // item_id is the thread being edited — the DAG check needs it, so the
  // preview rejects a circular quote at exactly the point publish would.
  const mount = normalizeMount(context.env.MOUNT);
  const origin = siteOrigin(await getSettings(context.env.DB), context.url, mount);
  const links = await previewInternalLinks(context.env.DB, tk.text, origin);
  const blocks = await resolveBlockLinks(tk, (md) => previewInternalLinks(context.env.DB, md, origin));
  const resolved = await previewTransclusions(context.env.DB, links.text, body.itemId, tk);
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
  getItemSummary: getItemSummaryOperation,
  getItem: getItemOperation,
  listItemVersions: listItemVersionsOperation,
  getSettings: getSettingsOperation,
  listSubscriptions: listSubscriptionsOperation,
  getSubscription: getSubscriptionOperation,
  listHoppers: listHoppersOperation,
  getHopper: getHopperOperation,
  listHopperMemberships: listHopperMembershipsOperation,
  listSignals: listSignalsOperation,
  listMentions: listMentionsOperation,
  listMentionGroups: listMentionGroupsOperation,
  getMentionSummary: getMentionSummaryOperation,
  listInteractions: listInteractionsOperation,
  getAiModels: getAiModelsOperation,
  listThumbs: listThumbsOperation,
  getSignalSummary: getSignalSummaryOperation,
  listReading: listReadingOperation,
  getReadingSummary: getReadingSummaryOperation,
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
