// The owner's interaction log (migration 0019, 0.25.0): a private, append-only
// record of what the owner did with other people's items — thumbs, hopper
// membership, and the publishes that reference them (stubs, forks, quotes).
//
// Why it exists: the smart feed (reading lens, not built yet) will rank new
// items by a prompt the owner writes, and "items I have interacted with or
// liked" is the strongest input it can have. This is the record that makes the
// thumbs signal load-bearing. The ranking agent itself is deliberately not
// designed yet; the log is the scaffolding it will read.
//
// Constraints any reader of this log must keep:
//  - It is private. Nothing here is emitted on the wire or rendered on a
//    public page (decisions #11/#12: AI, identity and editorial convenience
//    are never in the protocol).
//  - An act is logged when it becomes real on the server — a vote stored, a
//    membership added, a version published — never on a click that may be
//    abandoned.
//  - Targets are keyed by origin + id (§13.1 rule 7), not by subscription, so
//    the history outlives an unsubscribe.

import { excerptFromHtml } from "./markdown.ts";
import type { Transclusion } from "./types.ts";

export const INTERACTION_KINDS = ["thumb_up", "thumb_down", "thumb_clear", "hopper_add", "hopper_remove", "stub", "fork", "quote"] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export interface InteractionRow {
  id: number;
  at: string;
  kind: InteractionKind;
  origin: string;
  remote_id: string;
  version: number | null;
  own_item_id: string | null;
  own_version: number | null;
  hopper_id: string | null;
  hopper_name: string | null;
  backfilled: number;
}

interface Entry {
  kind: InteractionKind;
  origin: string;
  remoteId: string;
  at: string;
  version?: number | null;
  ownItemId?: string | null;
  ownVersion?: number | null;
  hopperId?: string | null;
  hopperName?: string | null;
}

export function insertInteraction(db: D1Database, e: Entry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO interactions (at, kind, origin, remote_id, version, own_item_id, own_version, hopper_id, hopper_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(e.at, e.kind, e.origin, e.remoteId, e.version ?? null, e.ownItemId ?? null, e.ownVersion ?? null, e.hopperId ?? null, e.hopperName ?? null);
}

export async function recordInteraction(db: D1Database, e: Entry): Promise<void> {
  await insertInteraction(db, e).run();
}

const sameOrigin = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

type Ref = { origin: string; id: string; version: number | null };

function parse<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function remoteQuotes(json: string | null): Ref[] {
  const list = parse<Transclusion[]>(json) ?? [];
  return list.filter((t) => !!t.origin).map((t) => ({ origin: t.origin!, id: t.id, version: t.version }));
}

function remoteStub(json: string | null): Ref | null {
  const stub = parse<{ origin?: string; id?: string; version?: number }>(json);
  return stub?.origin && stub.id ? { origin: stub.origin, id: stub.id, version: stub.version ?? null } : null;
}

/**
 * Log what a just-published version newly references on other blygs. "Newly"
 * is by target, not version: a refresh that re-bakes a newer version of a
 * quote already present is maintenance, not a fresh interaction, so it logs
 * nothing. A fork is logged at its first version.
 */
export async function recordPublishInteractions(db: D1Database, itemId: string, version: number, ourOrigin: string): Promise<void> {
  const rows = await db
    .prepare("SELECT version, transclusions, stub_of, published_at FROM versions WHERE item_id = ? AND version IN (?, ?)")
    .bind(itemId, version, version - 1)
    .all<{ version: number; transclusions: string | null; stub_of: string | null; published_at: string }>();
  const now = rows.results.find((r) => r.version === version);
  if (!now) return;
  const before = rows.results.find((r) => r.version === version - 1);
  const external = (r: Ref) => !ourOrigin || !sameOrigin(r.origin, ourOrigin);
  const key = (r: Ref) => JSON.stringify([r.origin.replace(/\/+$/, ""), r.id]);
  const out: D1PreparedStatement[] = [];
  const own = { ownItemId: itemId, ownVersion: version, at: now.published_at };

  const had = new Set(remoteQuotes(before?.transclusions ?? null).map(key));
  const seen = new Set<string>();
  for (const q of remoteQuotes(now.transclusions)) {
    if (!external(q) || had.has(key(q)) || seen.has(key(q))) continue;
    seen.add(key(q));
    out.push(insertInteraction(db, { kind: "quote", origin: q.origin, remoteId: q.id, version: q.version, ...own }));
  }
  const stub = remoteStub(now.stub_of);
  const prevStub = remoteStub(before?.stub_of ?? null);
  if (stub && external(stub) && !(prevStub && key(prevStub) === key(stub))) {
    out.push(insertInteraction(db, { kind: "stub", origin: stub.origin, remoteId: stub.id, version: stub.version, ...own }));
  }
  if (version === 1) {
    const item = await db.prepare("SELECT forked_from FROM items WHERE id = ?").bind(itemId).first<{ forked_from: string | null }>();
    const fork = remoteStub(item?.forked_from ?? null);
    if (fork && external(fork)) out.push(insertInteraction(db, { kind: "fork", origin: fork.origin, remoteId: fork.id, version: fork.version, ...own }));
  }
  if (out.length) await db.batch(out);
}

/** A row for the signals page: the log entry plus what we hold of its target, if anything. */
export interface InteractionView extends InteractionRow {
  subscription_id: string | null;
  label: string | null;
}

/** Labels from the local import of each target, when we still hold one. */
async function withLabels<T extends { origin: string; remote_id: string }>(db: D1Database, rows: T[]): Promise<(T & { subscription_id: string | null; label: string | null })[]> {
  if (!rows.length) return [];
  const pairs = JSON.stringify([...new Map(rows.map((r) => [JSON.stringify([r.origin, r.remote_id]), { origin: r.origin, id: r.remote_id }])).values()]);
  const held = await db
    .prepare(
      `SELECT s.origin, ii.remote_id, ii.subscription_id, ii.content_html FROM json_each(?) p
       JOIN subscriptions s ON rtrim(s.origin, '/') = rtrim(json_extract(p.value, '$.origin'), '/') AND s.hopper_feed IS NULL
       JOIN imported_items ii ON ii.subscription_id = s.id AND ii.remote_id = json_extract(p.value, '$.id')`,
    )
    .bind(pairs)
    .all<{ origin: string; remote_id: string; subscription_id: string; content_html: string }>();
  const byKey = new Map(held.results.map((h) => [JSON.stringify([h.origin.replace(/\/+$/, ""), h.remote_id]), h]));
  return rows.map((r) => {
    const h = byKey.get(JSON.stringify([r.origin.replace(/\/+$/, ""), r.remote_id]));
    return { ...r, subscription_id: h?.subscription_id ?? null, label: h ? excerptFromHtml(h.content_html, 100) || null : null };
  });
}

export async function listInteractions(db: D1Database, offset: number, limit: number, kind?: InteractionKind): Promise<{ items: InteractionView[]; total: number }> {
  const where = kind ? "WHERE kind = ?" : "";
  const binds = kind ? [kind] : [];
  const [rows, count] = await db.batch([
    db.prepare(`SELECT * FROM interactions ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset),
    db.prepare(`SELECT COUNT(*) AS total FROM interactions ${where}`).bind(...binds),
  ]);
  return {
    items: await withLabels(db, rows.results as unknown as InteractionRow[]),
    total: (count.results[0] as { total: number } | undefined)?.total ?? 0,
  };
}

/** Current thumbs, newest first, with labels: the liked / disliked view. */
export async function listThumbs(db: D1Database): Promise<{ thumb: 1 | -1; at: string; origin: string; remote_id: string; subscription_id: string | null; label: string | null }[]> {
  const rows = await db
    .prepare(
      `SELECT sig.thumb, sig.at, sub.origin, sig.remote_id FROM signals sig
       JOIN subscriptions sub ON sub.id = sig.subscription_id ORDER BY sig.at DESC`,
    )
    .all<{ thumb: 1 | -1; at: string; origin: string; remote_id: string }>();
  return withLabels(db, rows.results);
}
