import { itemResource, versionResource, mediaResource, subscriptionResource, hopperResource, importedResource, mentionResource } from "./contract/resources.ts";
import { fetchOnSurface, itemUrl } from "./surface.ts";
import type { Context } from "hono";
import { contractApp, readJson } from "./contract/app.ts";
import { routes } from "./contract/routes.ts";
import { annotateTkPreview, scopeSummaries } from "./authoring.ts";
import { getItem, getSettings, getSettingsMap, getVersion, listVersions } from "./model.ts";
import { getHopper, getImportedItem, listSubscriptions, getSubscription } from "./importer/store.ts";
import { sanitizeHtml } from "./importer/sanitize.ts";
import { renderMarkdown, plainTextFromHtml } from "./markdown.ts";
import { clampText } from "./preview.ts";
import { applyInternalLinks, previewInternalLinks, previewTransclusions, resolveBlockLinks } from "./transclusion.ts";
import { siteOrigin } from "./protocol.ts";
import { MODELS, configuredProviders } from "./ai/models.ts";
import { INTERACTION_KINDS, listInteractions, listThumbs, type InteractionKind } from "./interactions.ts";
import { normalizeMount } from "./util.ts";
import type { Env, SignalRow, ImportedItemRow, ItemRow, SubscriptionRow, HopperRow, MentionInRow, MentionOutRow } from "./types.ts";
import { itemDetail } from "./item-data.ts";
import { readingData } from "./reading-data.ts";
import { IMPORTED_READING_DEFAULT, importedReading } from "./imported-reading.ts";
import { getInbound } from "./mentions/store.ts";
import { maybeCheckForUpdate } from "./update-check.ts";
import { normalizeOrigin } from "./stub.ts";
import { mentionFetchFor } from "./mentions/http.ts";
import { platformFetchFor } from "./importer/http.ts";
import { fetchImportedHistory, fetchPublicVersion } from "./imported-history.ts";
import { readChanges } from './changes.ts';

export const readApi = contractApp();
readApi.openapi(routes.getChanges, async c => c.json(await readChanges(c.env.DB)));
async function collection<T>(db: D1Database, query: Record<string, string>, sql: string, countSql: string) {
  const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 100);
  const [rows, count] = await Promise.all([
    db.prepare(`${sql} LIMIT ? OFFSET ?`).bind(limit, offset).all<T>(),
    db.prepare(countSql).first<{ total: number }>(),
  ]);
  return { items: rows.results, total: count?.total ?? 0, offset, limit };
}

readApi.openapi(routes.listItems, async (c) => {
  const offset = Number(c.req.query("offset") ?? 0), limit = Number(c.req.query("limit") ?? 100);
  const [rows, count] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM items ORDER BY updated DESC, rowid DESC LIMIT ? OFFSET ?").bind(limit, offset).all<ItemRow>(),
    c.env.DB.prepare("SELECT COUNT(*) AS total FROM items").first<{ total: number }>(),
  ]);
  // Return frozen version links without loading history bodies into the index.
  const pins = rows.results.length ? (await c.env.DB.prepare(`SELECT item_id, version, CASE WHEN transclusions IS NULL THEN 'fragment' ELSE 'thread' END AS kind FROM versions WHERE pinned = 1 AND item_id IN (${rows.results.map(() => '?').join(',')}) ORDER BY version`).bind(...rows.results.map(row => row.id)).all<{ item_id: string; version: number; kind: 'fragment' | 'thread' }>()).results : [];
  return c.json({ items: rows.results.map(row => ({ ...itemResource(row), pins: pins.filter(pin => pin.item_id === row.id).map(({ version, kind }) => ({ version, kind })) })), total: count?.total ?? 0, offset, limit });
});
// Owner DTOs feed HTML previews. Sanitize copies, not immutable version rows or
// public protocol snapshots, so legacy bakes cannot regain browser authority.
async function presentVersion(row: Parameters<typeof versionResource>[0]) {
  return versionResource({ ...row, content_html: await sanitizeHtml(row.content_html) });
}
readApi.openapi(routes.getItem, async (c) => {
  const detail = await itemDetail(c.env.DB, c.req.param("id"));
  return detail ? c.json({ ...itemResource(detail.item), authored_kind: detail.kind, media: detail.media.map(mediaResource), versions: await Promise.all(detail.versions.map(presentVersion)), published: detail.published ? await presentVersion(detail.published) : null }) : c.json({ error: "not found" }, 404);
});
readApi.openapi(routes.getSettings, async (c) => c.json(await getSettings(c.env.DB)));
readApi.openapi(routes.listSubscriptions, async (c) => {
  const page = await collection<SubscriptionRow>(c.env.DB, c.req.query(), "SELECT * FROM subscriptions ORDER BY created ASC, id ASC", "SELECT COUNT(*) AS total FROM subscriptions");
  return c.json({ ...page, items: page.items.map(subscriptionResource) });
});
readApi.openapi(routes.getSubscription, async (c) => {
  const sub = await getSubscription(c.env.DB, c.req.param("id"));
  return sub ? c.json(subscriptionResource(sub)) : c.json({ error: "not found" }, 404);
});
readApi.openapi(routes.listHoppers, async (c) => {
  const page = await collection<HopperRow>(c.env.DB, c.req.query(), "SELECT * FROM hoppers ORDER BY created ASC, id ASC", "SELECT COUNT(*) AS total FROM hoppers");
  return c.json({ ...page, items: page.items.map(hopperResource) });
});
readApi.openapi(routes.getHopper, async (c) => {
  const hopper = await getHopper(c.env.DB, c.req.param("id"));
  if (!hopper) return c.json({ error: "not found" }, 404);
  const preview = c.req.query("preview") === "true";
  const limit = preview ? " LIMIT 3" : "";
  const memberships = (await c.env.DB.prepare(`SELECT * FROM hopper_items WHERE hopper_id = ? ORDER BY added_at DESC, subscription_id, remote_id${limit}`).bind(hopper.id).all<import("./types.ts").HopperItemRow>()).results;
  const counts = await c.env.DB.prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT subscription_id) AS source_count FROM hopper_items WHERE hopper_id = ?").bind(hopper.id).first<{ total: number; source_count: number }>();
  const rows = await c.env.DB.prepare(`SELECT ii.* FROM hopper_items hi JOIN imported_items ii
    ON ii.subscription_id = hi.subscription_id AND ii.remote_id = hi.remote_id
    WHERE hi.hopper_id = ? ORDER BY hi.added_at DESC, hi.subscription_id, hi.remote_id${limit}`).bind(hopper.id).all<ImportedItemRow>();
  const items = await Promise.all(rows.results.map(async (r) => importedResource({ ...r, content_html: await sanitizeHtml(r.content_html) })));
  return c.json({ hopper: hopperResource(hopper), memberships, items, total: counts?.total ?? 0, source_count: counts?.source_count ?? 0 });
});
readApi.openapi(routes.listSignals, async (c) => c.json(await collection<SignalRow>(c.env.DB, c.req.query(), "SELECT * FROM signals ORDER BY at DESC, subscription_id, remote_id", "SELECT COUNT(*) AS total FROM signals")));
readApi.openapi(routes.listMentions, async (c) => {
  const direction = c.req.query("direction") ?? "inbound";
  const where = "WHERE status IN ('verified','gone')";
  if (direction === "outbound") return c.json({ ...await collection<MentionOutRow>(c.env.DB, c.req.query(), "SELECT * FROM mentions_out ORDER BY created DESC, id ASC", "SELECT COUNT(*) AS total FROM mentions_out"), direction });
  const page = await collection<MentionInRow>(c.env.DB, c.req.query(), `SELECT * FROM mentions_in ${where} ORDER BY verified_at DESC, last_seen DESC, id ASC`, `SELECT COUNT(*) AS total FROM mentions_in ${where}`);
  return c.json({ ...page, items: page.items.map(mentionResource), direction });
});
readApi.openapi(routes.listInteractions, async (c) => {
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
  const raw = c.req.query("kind");
  const kind = INTERACTION_KINDS.includes(raw as InteractionKind) ? (raw as InteractionKind) : undefined;
  return c.json({ ...(await listInteractions(c.env.DB, offset, limit, kind)), offset, limit });
});
readApi.openapi(routes.getAiModels, async (c) => {
  const configured = configuredProviders(c.env);
  return c.json({
    providers: Object.entries(MODELS.providers).map(([id, p]) => ({ id, label: p.label, key_secret: p.key_secret, configured: configured[id] ?? false })),
    models: MODELS.models,
    local: MODELS.local,
  });
});
readApi.openapi(routes.listThumbs, async (c) => c.json({ items: await listThumbs(c.env.DB) }));
// `read_state: true` advertises that imported entries carry the owner's
// readVersion, so a client can tell "unread" from "this server keeps none".
readApi.openapi(routes.listReading, async (c) => c.json({ ...await readingData(c.env.DB, Number(c.req.query("offset") ?? 0), Number(c.req.query("limit") ?? 25), c.req.query("sub"), readingKind(c.req.query("kind"))), read_state: true as const, read_state_clear: true as const }));
// Imported items only, keyset-paged, for clients that author from what they read (studio#11).
readApi.openapi(routes.listImportedReading, async (c) => {
  return c.json(await importedReading(c.env.DB, c.req.query("cursor"), Number(c.req.query("limit") ?? IMPORTED_READING_DEFAULT)));
});
function readingKind(raw: string | undefined): "thread" | "fragment" | undefined {
  return raw === "thread" || raw === "fragment" ? raw : undefined;
}
readApi.openapi(routes.getImportedItem, async (c) => {
  const row = await getImportedItem(c.env.DB, c.req.param("sub"), c.req.param("id"));
  return row ? c.json(importedResource({ ...row, content_html: await sanitizeHtml(row.content_html) })) : c.json({ error: "not found" }, 404);
});
// History of an imported item (#40), read from its origin on demand. Blyg
// subscriptions only: an L0 feed has no item documents and no versions.
async function blygSubscription(db: D1Database, id: string) {
  const sub = await getSubscription(db, id);
  return sub && sub.kind === "blyg" ? sub : null;
}
readApi.openapi(routes.getImportedHistory, async (c) => {
  const sub = await blygSubscription(c.env.DB, c.req.param("sub"));
  if (!sub) return c.json({ error: "not a blyg subscription" }, 404);
  const got = await fetchImportedHistory(platformFetchFor(c.env), sub, c.req.param("id"));
  return got.ok ? c.json(got.value) : c.json({ error: got.error }, got.status);
});
readApi.openapi(routes.getImportedVersion, async (c) => {
  const sub = await blygSubscription(c.env.DB, c.req.param("sub"));
  if (!sub) return c.json({ error: "not a blyg subscription" }, 404);
  const got = await fetchPublicVersion(platformFetchFor(c.env), sub, c.req.param("id"), Number(c.req.param("v")));
  return got.ok ? c.json(got.value) : c.json({ error: got.error }, got.status);
});
readApi.openapi(routes.getUpdateState, async (c) => {
  const [settings, map] = await Promise.all([getSettings(c.env.DB), getSettingsMap(c.env.DB)]);
  c.executionCtx.waitUntil(maybeCheckForUpdate(c.env.DB, settings, map, Date.now()).catch(() => {}));
  return c.json(Object.fromEntries(Object.entries(map).filter(([key]) => key.startsWith("update_"))));
});
readApi.openapi(routes.getMentionSource, async (c) => {
  const row = await getInbound(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  const holder = await c.env.DB.prepare("SELECT s.id AS id FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id WHERE ii.remote_id = ? AND s.origin = ? LIMIT 1").bind(row.source_id, row.source_origin).first<{ id: string }>();
  const subscription = (await listSubscriptions(c.env.DB)).find((s) => s.origin === row.source_origin) ?? null;
  return c.json({ holder: holder?.id ?? null, subscription: subscription ? subscriptionResource(subscription) : null });
});
readApi.openapi(routes.getForkOptions, async (c) => {
  const settings = await getSettings(c.env.DB), mount = normalizeMount(c.env.MOUNT);
  const ourOrigin = siteOrigin(settings, c.req.url, mount);
  const sub = c.req.query("sub");
  const fromSub = sub ? (await listSubscriptions(c.env.DB)).find((s) => s.id === sub)?.origin : undefined;
  const origin = normalizeOrigin(fromSub ?? c.req.query("origin")) ?? ourOrigin;
  const result = await forkablePins(c.env.DB, origin, c.req.query("id") ?? "", ourOrigin, mentionFetchFor(c.env));
  return c.json({ ...result, origin, ourOrigin });
});
readApi.openapi(routes.preview, async (c) => {
  const mount = normalizeMount(c.env.MOUNT);
  const body = await readJson<{ content_md?: string }>(c);
  if ((body as { kind?: string }).kind === "thread") return threadPreview(c);
  const tk = annotateTkPreview(body.content_md ?? "");
  // `[[id]]` resolves in the preview too, so an unresolvable link is visible
  // before publish rejects it — same contract as an unresolvable directive.
  const origin = siteOrigin(await getSettings(c.env.DB), c.req.url, mount);
  const links = await previewInternalLinks(c.env.DB, tk.text, origin);
  // Links inside generated blocks resolve here too, as at publish (studio#14).
  const blocks = await resolveBlockLinks(tk.blocks, (html) => previewInternalLinks(c.env.DB, html, origin, true));
  const html = [links, ...blocks.docs].reduce((acc, doc) => applyInternalLinks(acc, doc), tk.finish(renderMarkdown(links.text)));
  return c.json({ html, scopes: scopeSummaries(tk.scopes), link_errors: [...links.errors, ...blocks.errors] });
});

/**
 * Read one past version for the editor's history viewer. Studio-only: the
 * stored `content_html` of any version, pinned or not — unlike the public
 * `items/{id}/vN.json` surface, which serves pinned versions only (§2.8).
 * Reading history locally is not the same act as promising it publicly.
 */
readApi.openapi(routes.getVersion, async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const version = Number(c.req.param("v"));
  const row = await getVersion(c.env.DB, item.id, version);
  if (!row) return c.json({ error: "version not found" }, 404);
  return c.json(await presentVersion(row));
});

/**
 * The bracket palette's candidate list (§3.2). Searches everything v0.3 lets a
 * thread transclude: own published items of **either** kind (nesting is legal
 * from this version) and imported blyg items (`current`, non-L0) — which is
 * what makes quoting follow reading. The route keeps its 0.1 name; only its
 * subject widened.
 *
 * One list serves both bracket forms, and that is not a convenience: `[[id]]`
 * resolves through `resolveTarget` too — "by the same order", §16.2 — so the
 * set of ids a link can name *is* the set a directive can name. A second
 * endpoint would be a second copy of that rule, free to drift from it.
 */
const SEARCH_PAGE = 20;

readApi.openapi(routes.search, async (c) => {
  const source = c.req.query("source") === "mine" || c.req.query("source") === "imported" ? c.req.query("source") : "all";
  const sub = c.req.query("sub") || undefined;
  const order = c.req.query("sort") === "oldest" ? "ASC" : "DESC";
  // Every word must appear somewhere in the item's text or id, in any order.
  // lower() folds ASCII only; that is the "rudimentary" in rudimentary
  // search, and FTS5 is the upgrade if it ever matters. instr, not LIKE: D1
  // caps LIKE patterns at 50 bytes, so a pasted URL as a search word threw.
  const words = (c.req.query("q") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8);
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
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? SEARCH_PAGE) || SEARCH_PAGE));
  if (!parts.length) return c.json({ items: [], total: 0, offset, limit });
  const union = parts.join(" UNION ALL ");
  const [rows, count] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT * FROM (${union}) ORDER BY updated ${order}, id ${order} LIMIT ? OFFSET ?`).bind(...binds, limit, offset),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM (${union})`).bind(...binds),
  ]);
  type Row = { source: "mine" | "imported"; id: string; html: string | null; version: number; updated: string; kind: string; subscription_id: string | null; source_title: string | null; origin: string | null };
  const items = (rows.results as Row[]).map((r) => {
    // From rendered HTML, not markdown source — the picker showed literal
    // "#"/"*" markers otherwise, same bug class as the index rows.
    const excerpt = clampText(plainTextFromHtml(r.html ?? ""), 140);
    const sourceTitle = r.source === "mine" ? null : r.source_title || (r.origin ? new URL(r.origin).host : null);
    return {
      id: r.id,
      excerpt,
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
  return c.json({ items, total: (count.results[0] as { n: number }).n, offset, limit });
});


async function threadPreview(c: Context<{ Bindings: Env }>) {
  const body = await readJson<{ content_md?: string; item_id?: string }>(c);
  const tk = annotateTkPreview(body.content_md ?? "");
  // item_id is the thread being edited — the DAG check needs it, so the
  // preview rejects a circular quote at exactly the point publish would.
  const mount = normalizeMount(c.env.MOUNT);
  const origin = siteOrigin(await getSettings(c.env.DB), c.req.url, mount);
  const links = await previewInternalLinks(c.env.DB, tk.text, origin);
  const blocks = await resolveBlockLinks(tk.blocks, (html) => previewInternalLinks(c.env.DB, html, origin, true));
  const resolved = await previewTransclusions(c.env.DB, links.text, body.item_id);
  return c.json({
    html: [links, ...blocks.docs].reduce((acc, doc) => applyInternalLinks(acc, doc), tk.finish(resolved.html)),
    errors: [...resolved.errors, ...links.errors, ...blocks.errors],
    transclusions: resolved.transclusions,
    scopes: scopeSummaries(tk.scopes),
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
        .filter((v) => v.pinned === 1 && v.content_md)
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
