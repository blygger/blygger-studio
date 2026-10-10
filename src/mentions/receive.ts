// Inbound Webmention + structural verification — v0.3-plan §2.3.5,
// decision #28. The endpoint accepts a *claim*; verification decides whether
// the claim is true, by reading the source's own item document rather than
// scanning its page for our URL. Link-presence is the trackback-era check
// that spam defeated; a structural check asks a harder question: does the
// document that claims this origin actually reference us, in a field whose
// meaning is defined?
//
// No content of theirs is ever stored. A verified mention is a pointer.

import { fetchSurface, itemUrl } from "../surface.ts";
import type { FetchLike } from "../importer/http.ts";
import { normalizeOrigin } from "../stub.ts";
import type { MentionRelation, Transclusion } from "../types.ts";
import { boundedText } from "./http.ts";
import {
  hostOf,
  INBOUND_DOMAIN_HOURLY_LIMIT,
  INBOUND_GLOBAL_HOURLY_LIMIT,
  INBOUND_PAIR_COOLDOWN_MS,
  INBOUND_PENDING_LIMIT,
  INBOUND_PENDING_WINDOW_MS,
  INBOUND_HOURLY_LIMIT,
  markInboundUnverified,
  markInboundVerified,
  pairLastSeen,
  pendingInboundCount,
  recentInboundSources,
  registrableDomain,
  upsertInbound,
} from "./store.ts";

export type ReceiveOutcome =
  | { status: 202; mentionId: string; source: string; target: string }
  | { status: 400; error: string }
  | { status: 429; error: string; retryAfter: number };

/** Absolute http(s) only — a relative or non-web URL is a syntactic failure (§2.3.5 step 1). */
function absoluteWebUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Which of our items a target URL names — by the `page` shape we publish
 * (`f/{id}/`, `t/{id}/`) or by the item document itself (`items/{id}.json`).
 * Returns null when the URL is ours but names nothing published; the caller
 * answers 400, not 404: the endpoint exists, the claim is bad.
 */
export async function targetItemId(db: D1Database, target: URL, ourOrigin: string): Promise<string | null> {
  const origin = new URL(ourOrigin);
  if (target.origin !== origin.origin) return null;
  const base = origin.pathname.replace(/\/$/, "");
  let path = target.pathname;
  // §15.3 step 1 (revision of 2026-10-06, decision #61): the target lies
  // within our full origin, path included. On a path-mounted blyg, a URL on
  // the same host but outside the mount names something else.
  if (base) {
    if (!path.startsWith(`${base}/`)) return null;
    path = path.slice(base.length);
  }
  const m = /^\/(?:([ft])\/([^/]+)\/?|items\/([^/]+)\.json)$/.exec(path);
  const id = m?.[2] ?? m?.[3];
  if (!id) return null;
  const row = await db
    .prepare("SELECT id FROM items WHERE id = ? AND status IN ('public','withdrawn')")
    .bind(id)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * The endpoint's synchronous half: validate, rate-limit, record the claim.
 * Verification is asynchronous (the caller hands it to waitUntil), which is
 * why the honest answer is 202 rather than the 200 W3C also permits — we
 * have accepted the claim, not yet believed it.
 */
export async function receiveMention(
  db: D1Database,
  form: { source?: string; target?: string },
  ourOrigin: string,
  now: number = Date.now(),
): Promise<ReceiveOutcome> {
  const source = absoluteWebUrl(form.source);
  const target = absoluteWebUrl(form.target);
  if (!source || !target) return { status: 400, error: "source and target must be absolute http(s) URLs" };
  if (source.toString() === target.toString()) return { status: 400, error: "source and target must differ" };

  const itemId = await targetItemId(db, target, ourOrigin);
  if (!itemId) return { status: 400, error: "target is not a published item on this blyg" };

  // The same pair again, soon: nothing new is learned and verification would
  // cost two fetches and un-verify a verified row. Refuse, saying when.
  const seen = await pairLastSeen(db, source.toString(), target.toString());
  if (seen !== null && now - seen < INBOUND_PAIR_COOLDOWN_MS) {
    return { status: 429, error: "this mention was claimed moments ago", retryAfter: Math.ceil((INBOUND_PAIR_COOLDOWN_MS - (now - seen)) / 1000) };
  }

  // Three caps over one read of the last hour (§2.3.5 step 2 + §9.1 gaps 1–2),
  // checked narrowest first so that the refusal a sender reads is the true
  // reason: a single flooding host trips all three, and only the first is
  // about them.
  const recent = await recentInboundSources(db, now);
  const host = hostOf(source.toString());
  if (host && recent.filter((s) => hostOf(s) === host).length >= INBOUND_HOURLY_LIMIT) {
    return { status: 429, error: "too many mentions from this host in the last hour", retryAfter: 3600 };
  }
  const domain = registrableDomain(source.toString());
  if (domain && recent.filter((s) => registrableDomain(s) === domain).length >= INBOUND_DOMAIN_HOURLY_LIMIT) {
    return { status: 429, error: "too many mentions from this domain in the last hour", retryAfter: 3600 };
  }
  if (recent.length >= INBOUND_GLOBAL_HOURLY_LIMIT) {
    return { status: 429, error: "this endpoint is at its hourly limit for new claims", retryAfter: 3600 };
  }

  if ((await pendingInboundCount(db, now)) >= INBOUND_PENDING_LIMIT) {
    return { status: 429, error: "too many mentions are awaiting verification", retryAfter: Math.ceil(INBOUND_PENDING_WINDOW_MS / 1000 / 2) };
  }

  const row = await upsertInbound(db, source.toString(), target.toString(), itemId, new Date(now).toISOString());
  return { status: 202, mentionId: row.id, source: source.toString(), target: target.toString() };
}

type Doc = Record<string, unknown>;

function asItemDoc(body: string | null): Doc | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return "blyg" in (parsed as Doc) ? (parsed as Doc) : null;
  } catch {
    return null;
  }
}

/** The `<link rel="alternate" type="application/json">` hook decision #29 added for exactly this. */
export function alternateJsonHref(html: string, base: string): string | null {
  const tag = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)["']?/i.exec(m[0]);
    if (!rel || !rel[1].toLowerCase().split(/\s+/).includes("alternate")) continue;
    // The media type exactly, parameters aside: WordPress pages also carry an
    // oEmbed alternate typed `application/json+oembed`, often first.
    const type = /\btype\s*=\s*["']([^"']*)["']|\btype\s*=\s*([^\s>]+)/i.exec(m[0]);
    const media = (type?.[1] ?? type?.[2] ?? "").split(";")[0].trim().toLowerCase();
    if (media !== "application/json") continue;
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(m[0]);
    if (!href) continue;
    try {
      return new URL(href[1], base).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * How the source document references us, read out of its structure (§2.3.5).
 * `stub_of` outranks a transclusion: a stub is the stronger claim, and an
 * item that both stubs and quotes us is a stub.
 */
export function relationTo(doc: Doc, ourOrigin: string, targetId: string): MentionRelation | null {
  const stub = doc.stub_of as unknown;
  if (stub && typeof stub === "object") {
    const s = stub as Record<string, unknown>;
    // The {url} shape names no item, so it can never name *this* item.
    if (normalizeOrigin(s.origin) === ourOrigin && s.id === targetId) return "stub";
  }
  const transclusions = Array.isArray(doc.transclusions) ? (doc.transclusions as Transclusion[]) : [];
  if (transclusions.some((t) => t && normalizeOrigin(t.origin) === ourOrigin && t.id === targetId)) return "transclusion";
  if (forkedVersion(doc, ourOrigin, targetId) !== null) return "fork";
  // 0.4 (§16.3, decision #44): a model at the source's origin was fed this
  // item. Read from the reference alone, like the other three; the weakest
  // claim, so it ranks last.
  const generated = Array.isArray(doc.generated) ? (doc.generated as unknown[]) : [];
  for (const g of generated) {
    const sources = g && typeof g === "object" && Array.isArray((g as { sources?: unknown }).sources) ? ((g as { sources: unknown[] }).sources) : [];
    if (sources.some((s) => s && typeof s === "object" && normalizeOrigin((s as { origin?: unknown }).origin) === ourOrigin && (s as { id?: unknown }).id === targetId)) return "source";
  }
  return null;
}

/**
 * The version a source document's `forked_from` claims to descend from, when
 * it names this item on this origin — else null (§2.3.5, §2.4).
 *
 * Returned rather than folded into relationTo's verdict because the spec's
 * relation is "`forked_from` naming a **pinned** version of the target", and
 * only the target — us — knows which of our versions are pinned. That second
 * half is checked by the caller, which has the database; here we read the
 * claim, there we test it. Zero extra fetches: a claim about our own pins is
 * the one claim we never have to take anyone's word for.
 */
export function forkedVersion(doc: Doc, ourOrigin: string, targetId: string): number | null {
  const fork = doc.forked_from as unknown;
  if (!fork || typeof fork !== "object") return null;
  const f = fork as Record<string, unknown>;
  if (normalizeOrigin(f.origin) !== ourOrigin || f.id !== targetId) return null;
  return typeof f.version === "number" && Number.isInteger(f.version) && f.version > 0 ? f.version : null;
}

export interface VerifyResult {
  status: "verified" | "failed" | "gone";
  reason?: string;
  relation?: MentionRelation;
}

/**
 * Fetch the source, find its item document, and decide. Bounded to two
 * fetches (§2.3.5): the page, and the document its `rel="alternate"` names —
 * or one, when the source URL *is* the document. A third, the sender's own
 * manifest, only when the document was served from outside the default path
 * (a templated blyg, §16.6e, whose bounds are raised to three).
 *
 * The identity rule is the load-bearing one: the item document must have been
 * fetched from exactly `{origin}items/{id}.json` for its own asserted `origin`
 * and `id` (§15.4 step 2, revision of 2026-10-06, decision #61). That is §12.2
 * applied inbound with the full origin, path included — so neither a mirror,
 * nor another blyg path-mounted on the same host, can speak in a real blyg's
 * name — and because a pinned file's URL is never the live document's, a
 * pin that still carries `stub_of` stops verifying once the live document is
 * a withdrawal endcap.
 */
export async function verifyMention(
  db: D1Database,
  mentionId: string,
  source: string,
  targetItemId: string,
  ourOrigin: string,
  fetchFn: FetchLike,
): Promise<VerifyResult> {
  const fail = async (reason: string, status: "failed" | "gone" = "failed"): Promise<VerifyResult> => {
    await markInboundUnverified(db, mentionId, status, reason);
    return { status, reason };
  };

  let res;
  try {
    res = await fetchFn(source);
  } catch (e) {
    return fail(`source fetch failed: ${(e as Error).message}`);
  }
  if (!res.ok) return fail(`source fetch returned ${res.status}`);
  const body = await boundedText(res);
  if (body === null) return fail("source response too large");

  let finalUrl = res.url;
  let doc = asItemDoc(body);
  if (!doc) {
    const href = alternateJsonHref(body, res.url);
    if (!href) return fail("not a blyg item: source page declares no JSON alternate");
    let docRes;
    try {
      docRes = await fetchFn(href);
    } catch (e) {
      return fail(`item document fetch failed: ${(e as Error).message}`);
    }
    if (!docRes.ok) return fail(`item document fetch returned ${docRes.status}`);
    const docBody = await boundedText(docRes);
    doc = asItemDoc(docBody);
    if (!doc) return fail("not a blyg item: the JSON alternate is not an item document");
    finalUrl = docRes.url;
  }

  const asserted = normalizeOrigin(doc.origin);
  if (!asserted) return fail("item document declares no origin");
  if (typeof doc.id !== "string" || !doc.id) return fail("item document declares no id");
  const expected = new URL(`items/${encodeURIComponent(doc.id)}.json`, asserted);
  const served = new URL(finalUrl);
  served.hash = "";
  if (served.href !== expected.href) {
    // §16.6e: a templated blyg serves item documents where its manifest's
    // `item` template says, possibly outside the identity origin. Read the
    // asserted origin's own manifest (the third fetch) and accept only an
    // exact match with its template; a missing manifest fails the claim.
    const surface = await fetchSurface(asserted, fetchFn);
    const templated = surface?.item ? new URL(itemUrl(asserted, surface, doc.id)) : null;
    if (templated) templated.hash = "";
    if (!templated || served.href !== templated.href) {
      return fail(`origin mismatch: document claims ${expected.href}${templated ? ` or ${templated.href}` : ""} but was served from ${served.href}`);
    }
  }
  if (doc.kind === "withdrawn") return fail("source item is withdrawn", "gone");

  const relation = relationTo(doc, ourOrigin, targetItemId);
  if (!relation) return fail("source document does not reference this item");
  // A fork claims descent from a pinned version of ours (§2.3.5). We are the
  // only party who can say whether that version is in fact pinned, so we do —
  // a lineage pointer at an unpinned version names bytes this origin never
  // promised to keep serving, and verifying it would vouch for a claim we
  // know to be unsupported.
  if (relation === "fork") {
    const version = forkedVersion(doc, ourOrigin, targetItemId)!;
    const row = await db
      .prepare("SELECT pinned FROM versions WHERE item_id = ? AND version = ?")
      .bind(targetItemId, version)
      .first<{ pinned: number }>();
    if (!row) return fail(`forked_from names v${version}, which does not exist here`);
    if (row.pinned !== 1) return fail(`forked_from names v${version}, which is not pinned`);
  }

  await markInboundVerified(db, mentionId, {
    relation,
    sourceOrigin: asserted,
    sourceId: typeof doc.id === "string" ? doc.id : "",
    sourceKind: typeof doc.kind === "string" ? doc.kind : "",
    sourceVersion: typeof doc.version === "number" ? doc.version : 0,
    authorJson: doc.author ? JSON.stringify(doc.author) : null,
    sourcePage: source,
  });
  return { status: "verified", relation };
}
