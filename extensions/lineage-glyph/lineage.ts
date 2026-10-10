// An item's lineage as this node knows it: what it draws on (ancestors) and
// what draws on it (descendants). Studio furniture for the reading view's
// glyph and hex view — nothing here reaches the wire.
//
// The two halves are not equally knowable, and the shapes say so:
//   - Ancestors are exact. They are the item's own references: `stub_of`,
//     `forked_from` and `transclusions[]`, as published (own items) or as the
//     origin served them (imported items, migration 0017).
//   - Descendants are *known here* only: references held in documents we
//     store (our own published items, imported items) plus, for our own
//     items, verified inbound mentions. Another node sees a different set.
//
// One reference per (holder, target): a stub thread both `stub_of`s and
// transcludes its target, which is one act, not two. Relation priority is
// fork > stub > transclusion, and a partial transclusion marks the edge
// partial — "quote a passage" is a stub whose transclusion is partial.

import { normalizeOrigin } from "../../src/stub.ts";
import { previewFromHtml, stripTransclusionQuotes } from "../../src/preview.ts";
import { blygItemUrl } from "../../src/importer/util.ts";
import { isFollowableUrl } from "../../src/util.ts";
import type { SubscriptionRow } from "../../src/types.ts";

export type LineageRelation = "stub" | "transclusion" | "fork";
export type RelationCounts = Record<LineageRelation, number>;
export interface LineageSummary { up: RelationCounts; down: RelationCounts }

export interface LineageNode {
  relation: LineageRelation;
  partial: boolean;
  origin: string | null;
  id: string | null;
  version: number | null;
  /** Where this node is held here: our own item, an imported item, or not at all. */
  held: "own" | "imported" | null;
  sub: string | null;
  kind: "fragment" | "thread" | null;
  title: string | null;
  excerpt: string | null;
  /** The blyg it lives on (subscription title), or its author for a mention-only node. */
  source: string | null;
  url: string | null;
  /** Descendants only: whether we know of it from a stored document or only from a verified mention. */
  via: "reference" | "mention";
}
export interface Lineage {
  node: Omit<LineageNode, "relation" | "partial" | "via">;
  ancestors: LineageNode[];
  descendants: LineageNode[];
}

interface Holder { origin: string; id: string; held: "own" | "imported"; sub: string | null }
interface Edge { from: Holder; to: { origin: string | null; id: string | null; version: number | null; url: string | null; cited: Cited | null }; relation: LineageRelation; partial: boolean }
interface Cited { source?: string; author?: string; excerpt?: string; url?: string }

const RANK: Record<LineageRelation, number> = { fork: 3, stub: 2, transclusion: 1 };
const zero = (): RelationCounts => ({ stub: 0, transclusion: 0, fork: 0 });
const key = (origin: string | null, id: string | null) => `${origin ?? ""}|${id ?? ""}`;

function parse(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function cited(value: unknown): Cited | null {
  return value && typeof value === "object" ? (value as Cited) : null;
}

/** The references one document makes, deduped per target. `own` is the origin a bare transclusion means. */
function referencesOf(from: Holder, stubOf: unknown, forkedFrom: unknown, transclusions: unknown): Edge[] {
  const out = new Map<string, Edge>();
  const add = (edge: Edge) => {
    const k = edge.to.url ? `url|${edge.to.url}` : key(edge.to.origin, edge.to.id);
    const prior = out.get(k);
    if (!prior) return void out.set(k, edge);
    const partial = prior.partial || edge.partial;
    out.set(k, RANK[edge.relation] > RANK[prior.relation] ? { ...edge, partial } : { ...prior, partial });
  };
  const ref = (value: unknown, fallbackOrigin: string | null) => {
    if (!value || typeof value !== "object") return null;
    const v = value as { origin?: unknown; id?: unknown; version?: unknown; url?: unknown; cited?: unknown };
    if (typeof v.id === "string") {
      return { origin: normalizeOrigin(v.origin) ?? fallbackOrigin, id: v.id, version: typeof v.version === "number" ? v.version : null, url: null, cited: cited(v.cited) };
    }
    if (typeof v.url === "string") return { origin: null, id: null, version: null, url: v.url, cited: cited(v.cited) };
    return null;
  };
  const stub = ref(stubOf, null);
  if (stub) add({ from, to: stub, relation: "stub", partial: false });
  const fork = ref(forkedFrom, null);
  if (fork && fork.id) add({ from, to: fork, relation: "fork", partial: false });
  if (Array.isArray(transclusions)) {
    for (const t of transclusions) {
      const to = ref(t, from.origin);
      if (to && to.id) add({ from, to, relation: "transclusion", partial: !!(t as { selector?: unknown }).selector });
    }
  }
  return [...out.values()];
}

/**
 * Every reference held here, in three queries: imported documents that carry
 * any, our own published items, and verified inbound mentions of our items.
 */
async function loadGraph(db: D1Database, ourOrigin: string) {
  const [imported, own, mentions, subs] = await Promise.all([
    db.prepare(`SELECT ii.subscription_id, ii.remote_id, ii.stub_of_json, ii.forked_from_json, ii.transclusions_json, s.origin
      FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id
      WHERE ii.l0 = 0 AND (ii.stub_of_json IS NOT NULL OR ii.forked_from_json IS NOT NULL
        OR (ii.transclusions_json IS NOT NULL AND ii.transclusions_json NOT IN ('', '[]')))`)
      .all<{ subscription_id: string; remote_id: string; stub_of_json: string | null; forked_from_json: string | null; transclusions_json: string | null; origin: string }>(),
    db.prepare(`SELECT i.id, i.forked_from, v.stub_of, v.transclusions FROM items i
      JOIN versions v ON v.item_id = i.id AND v.version = i.version
      WHERE i.status = 'public' AND (i.forked_from IS NOT NULL OR v.stub_of IS NOT NULL OR v.transclusions NOT IN ('', '[]'))`)
      .all<{ id: string; forked_from: string | null; stub_of: string | null; transclusions: string | null }>(),
    db.prepare(`SELECT target_item_id, relation, source_origin, source_id, source_kind, source_version, source_author_json, source_page
      FROM mentions_in WHERE status = 'verified' AND relation IS NOT NULL AND source_id IS NOT NULL`)
      .all<{ target_item_id: string; relation: LineageRelation; source_origin: string | null; source_id: string; source_kind: string | null; source_version: number | null; source_author_json: string | null; source_page: string | null }>(),
    db.prepare("SELECT * FROM subscriptions").all<SubscriptionRow>(),
  ]);
  const edges: Edge[] = [];
  for (const r of imported.results) {
    const origin = normalizeOrigin(r.origin);
    if (!origin) continue;
    edges.push(...referencesOf({ origin, id: r.remote_id, held: "imported", sub: r.subscription_id }, parse(r.stub_of_json), parse(r.forked_from_json), parse(r.transclusions_json)));
  }
  for (const r of own.results) {
    edges.push(...referencesOf({ origin: ourOrigin, id: r.id, held: "own", sub: null }, parse(r.stub_of), parse(r.forked_from), parse(r.transclusions)));
  }
  return { edges, mentions: mentions.results, subs: subs.results };
}
type Graph = Awaited<ReturnType<typeof loadGraph>>;

/** Distinct descendants of one node: held references first, then mention-only sources. */
function descendantsOf(graph: Graph, ourOrigin: string, origin: string, id: string) {
  const found = new Map<string, { relation: LineageRelation; partial: boolean; from: Holder | null; mention: Graph["mentions"][number] | null }>();
  for (const e of graph.edges) {
    if (e.to.id !== id || e.to.origin !== origin) continue;
    const k = key(e.from.origin, e.from.id);
    if (!found.has(k)) found.set(k, { relation: e.relation, partial: e.partial, from: e.from, mention: null });
  }
  if (origin === ourOrigin) {
    for (const m of graph.mentions) {
      if (m.target_item_id !== id) continue;
      const k = key(normalizeOrigin(m.source_origin), m.source_id);
      if (!found.has(k)) found.set(k, { relation: m.relation, partial: false, from: null, mention: m });
    }
  }
  return [...found.values()];
}

/** Glyph counts for a page of reading entries. `sub` null means our own item. */
export async function lineageSummaries(db: D1Database, ourOrigin: string, nodes: { sub: string | null; id: string }[]): Promise<LineageSummary[]> {
  if (!nodes.length) return [];
  const graph = await loadGraph(db, ourOrigin);
  const originOf = new Map(graph.subs.map((s) => [s.id, normalizeOrigin(s.origin) ?? s.origin]));
  return nodes.map(({ sub, id }) => {
    const o = sub === null ? ourOrigin : originOf.get(sub) ?? "";
    const up = zero(), down = zero();
    for (const e of graph.edges) if (e.from.id === id && e.from.origin === o) up[e.relation]++;
    for (const d of descendantsOf(graph, ourOrigin, o, id)) down[d.relation]++;
    return { up, down };
  });
}

/**
 * A node's url becomes an href in the studio. Remote documents, their `cited`
 * and stored mention source pages are untrusted, so only http(s)/mailto URLs
 * survive; anything else (javascript:, data:, …) is no link at all.
 */
function followable(url: string | null | undefined): string | null {
  return url && isFollowableUrl(url) ? url : null;
}

/** The full one-hop lineage of a node, each neighbour described as well as this node can. */
export async function lineageOf(db: D1Database, ourOrigin: string, rawOrigin: string, id: string): Promise<Lineage> {
  const origin = normalizeOrigin(rawOrigin) ?? rawOrigin;
  const graph = await loadGraph(db, ourOrigin);
  const subsByOrigin = new Map(graph.subs.map((s) => [normalizeOrigin(s.origin) ?? s.origin, s]));
  const describe = async (o: string | null, i: string | null) => {
    const blank = { origin: o, id: i, version: null as number | null, held: null as LineageNode["held"], sub: null as string | null, kind: null as LineageNode["kind"], title: null as string | null, excerpt: null as string | null, source: null as string | null, url: null as string | null };
    if (!o || !i) return blank;
    if (o === ourOrigin) {
      const row = await db.prepare(`SELECT i.id, i.kind, i.version, v.content_html, v.transclusions FROM items i
        LEFT JOIN versions v ON v.item_id = i.id AND v.version = i.version WHERE i.id = ? AND i.status IN ('public','withdrawn')`).bind(i)
        .first<{ id: string; kind: string; version: number; content_html: string | null; transclusions: string | null }>();
      if (!row) return blank;
      const kind = row.kind === "thread" || row.transclusions !== null ? "thread" : "fragment";
      const p = previewFromHtml(stripTransclusionQuotes(row.content_html ?? ""), 140);
      return { ...blank, version: row.version, held: "own" as const, kind: kind as LineageNode["kind"], title: p.title, excerpt: p.body || null, source: "you", url: row.kind === "withdrawn" ? null : `${ourOrigin}${kind === "thread" ? "t" : "f"}/${row.id}/` };
    }
    const sub = subsByOrigin.get(o);
    if (!sub) return blank;
    const row = await db.prepare("SELECT remote_id, kind, version, content_html, page, l0 FROM imported_items WHERE subscription_id = ? AND remote_id = ?").bind(sub.id, i)
      .first<{ remote_id: string; kind: "fragment" | "thread"; version: number; content_html: string; page: string | null; l0: number }>();
    if (!row) return { ...blank, source: sub.title || null };
    const p = previewFromHtml(stripTransclusionQuotes(row.content_html), 140);
    return { ...blank, version: row.version, held: "imported" as const, sub: sub.id, kind: row.kind, title: p.title, excerpt: p.body || null, source: sub.title || null, url: followable(blygItemUrl(o, row.kind, row.remote_id, row.page)) };
  };

  const ancestors: LineageNode[] = [];
  for (const e of graph.edges.filter((e) => e.from.id === id && e.from.origin === origin)) {
    const d = await describe(e.to.origin, e.to.id);
    ancestors.push({
      ...d,
      version: e.to.version ?? d.version,
      // A target we do not hold still has a frozen human half (§16.1 `cited`).
      excerpt: d.excerpt ?? e.to.cited?.excerpt ?? null,
      source: d.source ?? e.to.cited?.source ?? e.to.cited?.author ?? null,
      url: d.url ?? followable(e.to.cited?.url) ?? followable(e.to.url),
      relation: e.relation, partial: e.partial, via: "reference",
    });
  }
  const descendants: LineageNode[] = [];
  for (const f of descendantsOf(graph, ourOrigin, origin, id)) {
    if (f.from) {
      descendants.push({ ...(await describe(f.from.origin, f.from.id)), relation: f.relation, partial: f.partial, via: "reference" });
      continue;
    }
    const m = f.mention!;
    const author = cited(parse(m.source_author_json)) as { name?: string } | null;
    const held = await describe(normalizeOrigin(m.source_origin), m.source_id);
    descendants.push({
      ...held,
      kind: held.kind ?? (m.source_kind === "thread" || m.source_kind === "fragment" ? m.source_kind : null),
      version: held.version ?? m.source_version,
      source: held.source ?? author?.name ?? null,
      url: held.url ?? followable(m.source_page),
      relation: f.relation, partial: false, via: "mention",
    });
  }
  return { node: await describe(origin, id), ancestors, descendants };
}
