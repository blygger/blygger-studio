/**
 * This oracle owns what the resident assistant's digest shows from outside the
 * blygs the owner follows: mentions from blygs they do not follow, and blygs
 * they have met that are newly active, checked on the edition
 * `GET /agentic/default` lays out. It also owns how any edition's `mention` and
 * `remote` entries resolve. It owns `src/agentic-discovery.ts`,
 * `outsideSections` in `src/agentic-digest.ts`, and the outside resolution in
 * `src/agentic.ts`.
 *
 * ```ts
 * writeResidentDigest(db, now, own) // → Mentions: verified in the window, from an origin not followed, newest first, at most 5
 * writeResidentDigest(db, now, own, { discover: fetch })
 *   // → New blygs: met, not followed, an item created in the last 14 days, most met first, at most 5
 *   // → at most 14 fetches: the directory, then feeds in rank order until five are active
 * writeResidentDigest(db, later, own) // → the last discovery's blygs, less any followed since or gone stale; no fetch
 * PUT /api/agentic/default { entries: [{ mention }, { remote }] } // → only verified receipts and met origins resolve
 * ```
 *
 * Why is a blyg your reading quotes forty times, which posted yesterday, sometimes
 * missing from New blygs? Because the directory said its last post was three
 * weeks ago, so its feed was never read: a listing's own `lastPost` decides
 * whether a listed blyg is worth a fetch, and only a feed read can admit it.
 *
 * Three parts decide the outside sections. The window is the edition's, a day
 * or a week. Meeting: an origin is met when the blygger.com directory lists it,
 * or when the owner's reading points at it (a held item's stub, fork, quote or
 * link that names an origin, or a verified mention's source); how often it is
 * met counts only the reading's references, never the listing. The read
 * queue: the met origins that are neither followed nor the owner's own, less
 * listed ones whose `lastPost` is missing or 14 or more days old, ranked by how
 * often met, then the listing's `lastPost`, newest first (unlisted last), then
 * origin; each is read through one feed fetch (a listed blyg's directory
 * `feed`, else `{origin}feed.xml`), at most 13, stopping when five are active.
 *
 * Mentions. For every edition window, a mention receipt is listed if and only
 * if it is verified, it was verified in the window, and its source origin is
 * neither followed nor the owner's own; hidden receipts are listed too, since
 * the digest is private. Newest first, then by receipt id, at most 5. New
 * blygs. For every discovery, an origin is listed if and only if its feed was
 * read from the queue, answered, and holds an item, not withdrawn, created in
 * the last 14 days; its newest such item (of equals, the smaller id) is the
 * sample. Most met first, then the newest sample, then origin; at most 5. An
 * edition written later without discovery shows the last discovery's blygs,
 * less any followed since or whose sample has aged past 14 days, and fetches
 * nothing. Resolution. For every edition, a `mention` entry resolves if and
 * only if its receipt exists and is verified, showing the receipt as stored,
 * and a `remote` entry if and only if the last discovery met its origin
 * (listed or referenced, active or not), showing its listing; a repeat is shown
 * once, and what does not resolve is left out. The edition law (law 5) holds
 * over these sections too: an empty one is absent, and an edition is
 * rewritten exactly when its sections change.
 * Decision by Venkat Rao (GitHub vgururao), 2026-11-27: blygger-spec
 * docs/agentic-digest-plan.md §8 laws 3 and 4 and §6's resolution rule,
 * approved as written; bounded to one daily discovery of at most 14 fetches,
 * the directory's lastPost deciding which listed feeds are read, with hidden
 * receipts shown, and form B (the met_origins table), the same day.
 *
 * The model reads the plan only: three followed blygs, sixteen other origins,
 * the owner's own origin, held items each pointing at one origin, mention
 * receipts, a directory listing as served (duplicates and a junk row
 * included), a feed for each other origin, an origin followed after the
 * discovery, and how much later the second edition is written. The driver
 * seeds held items through the real importer and receipts as the receiver
 * stores them, serves the network from a fixture fetch that records every
 * request, writes the digest with discovery, follows, writes it again later
 * without discovery, then puts an outside edition through the owner API.
 *
 * Limits: the cron's choice of the 07:00 tick for discovery is not here (the
 * caller passes the fetch); an unlisted blyg whose feed is not at `feed.xml`
 * is not found. Two rules are added to the approved laws, from the probe: the
 * owner's own origin is never a new blyg, and a listing adds no meeting.
 */
import { env } from 'cloudflare:test';
import fc from 'fast-check';
import { differs, oracleProperty, pass, type Observation } from '@tanstack/oracles';
import { applyEffect } from '../src/importer/store.ts';
import { transition } from '../src/importer/transition.ts';
import { markInboundVerified, upsertInbound } from '../src/mentions/store.ts';
import { writeResidentDigest } from '../src/agentic-digest.ts';
import { itemDocBody, makeFixtureFetch, type FixtureResponse } from './importer/fixtures.ts';
import { BASE, apiJson, login } from './helpers.ts';
import { withOracleStorage } from './oracle-storage.ts';

const MENTIONS = 'agentic mentions law';
const NEW_BLYGS = 'agentic new blygs law';
const RESOLUTION = 'agentic outside resolution law';
const LAYOUT = 'agentic edition layout law';
const OWN_ORIGIN = `${BASE}/blyg/`;
const DIRECTORY = 'https://blygger.com/blygs.json';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Targets: 0–15 are other origins, 16 the owner's own, 17 a followed blyg.
const OTHERS = 16;
const OWN = 16;
const FOLLOWED = 17;
const relations = ['stub', 'fork', 'quote', 'link'] as const;
// What a verified receipt records of how its source answers (src/mentions/store.ts).
const receiptRelations = ['stub', 'transclusion', 'fork'] as const;
// The author a receipt stored: none, a name, an empty one, not JSON, a name that is not a string, JSON null, or names with brackets.
const authors = [null, '{"name":"Ann Lee"}', '{"name":""}', 'not json', '{"name":5}', 'null', '{"name":"[Ann]"}', '{"name":"[]"}'] as const;

// form: how the reference names its origin, with a slash, without one, or not at all (its own blyg).
type Ref = { from: number; to: number; relation: (typeof relations)[number]; form: 'slash' | 'bare' | 'none' };
// odd: its source page holds a parenthesis, which a markdown link cannot carry as it is.
type Receipt = { source: number; status: 'verified' | 'pending' | 'failed'; hidden: boolean; age: number; author: number; odd: boolean };
// lastPost: days before the discovery, null when the listing says null, 'none' when it has no activity at all.
type Listing = { target: number; lastPost: number | null | 'none' };
type Feed = { status: 'ok' | 'missing' | 'broken' | 'unreachable'; entries: { created: number; withdrawn: boolean; plain: boolean }[] };
// An outside assistant's entry: a receipt, an origin, or a held item by index; shown in full, and with its own words.
type Outside = { kind: 'mention' | 'remote' | 'held'; target: number; full: boolean; words: boolean };
// The rest of that edition: which optional parts it carries, and its section's kind.
type Meta = { title: boolean; lede: boolean; generatedAt: boolean; model: boolean; note: boolean; kind: 'none' | 'lead' | 'briefs' };
type Plan = { frequency: 'hourly' | 'daily' | 'weekly'; refs: Ref[]; receipts: Receipt[]; directory: { ok: boolean; listed: Listing[] }; feeds: Feed[]; follow: number; later: number; outside: Outside[]; meta: Meta };

const target = fc.integer({ min: 0, max: 17 });
const feed = fc.record({
  status: fc.constantFrom('ok' as const, 'ok' as const, 'missing' as const, 'broken' as const, 'unreachable' as const),
  // Days before the discovery: -1 is a clock ahead of ours, 14 is the edge. Equal days tie.
  entries: fc.array(fc.record({ created: fc.constantFrom(-1, 0, 1, 13, 14, 15, 30), withdrawn: fc.boolean(), plain: fc.boolean() }), { maxLength: 3 }),
});
const arbitrary = fc.record({
  frequency: fc.constantFrom('hourly' as const, 'daily' as const, 'weekly' as const),
  refs: fc.array(fc.record({ from: fc.integer({ min: 0, max: 2 }), to: target, relation: fc.constantFrom(...relations), form: fc.constantFrom('slash' as const, 'bare' as const, 'none' as const) }), { maxLength: 8 }),
  // Hours before the edition: -1 is ahead of our clock; 24 and 168 are window edges. Equal ages tie.
  receipts: fc.array(fc.record({ source: target, status: fc.constantFrom('verified' as const, 'verified' as const, 'pending' as const, 'failed' as const), hidden: fc.boolean(), age: fc.constantFrom(-1, 0, 1, 23, 24, 25, 167, 168), author: fc.integer({ min: 0, max: 7 }), odd: fc.boolean() }), { maxLength: 7 }),
  directory: fc.record({ ok: fc.boolean(), listed: fc.array(fc.record({ target, lastPost: fc.constantFrom(null, 'none' as const, 0, 1, 13, 14, 15, 40) }), { maxLength: 16 }) }),
  feeds: fc.array(feed, { minLength: OTHERS, maxLength: OTHERS }),
  // An other origin followed after the discovery, or none (-1).
  follow: fc.integer({ min: -1, max: 15 }),
  // Hours after the discovery that the second edition is written.
  later: fc.constantFrom(0, 1, 300),
  outside: fc.array(fc.record({ kind: fc.constantFrom('mention' as const, 'remote' as const, 'held' as const), target: fc.integer({ min: 0, max: 17 }), full: fc.boolean(), words: fc.boolean() }), { maxLength: 6 }),
  meta: fc.record({ title: fc.boolean(), lede: fc.boolean(), generatedAt: fc.boolean(), model: fc.boolean(), note: fc.boolean(), kind: fc.constantFrom('none' as const, 'lead' as const, 'briefs' as const) }),
});

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const blyg = (b: number) => ({ sub: `outside-sub-${b}`, origin: `https://b${b}.outside.test/` });
const originOf = (t: number) => (t === OWN ? OWN_ORIGIN : t === FOLLOWED ? blyg(0).origin : `https://o${pad(t)}.outside.test/`);
const other = (t: number) => t < OTHERS;
const verifiedAt = (r: Receipt, now: number) => now - r.age * HOUR;
const createdAt = (e: Feed['entries'][number], now: number) => now - e.created * DAY;
const receiptId = (i: number) => `rc${pad(i, 24)}`;
const sampleId = (t: number, j: number) => `nb${pad(t)}${pad(j, 22)}`;
const feedUrl = (t: number, listed: boolean) => `${originOf(t)}${listed ? 'rss.xml' : 'feed.xml'}`;
const sourcePage = (r: Receipt, i: number) => `${originOf(r.source)}items/ms${pad(i, 24)}${r.odd ? '(copy)' : ''}`;
// The name a receipt's stored author gives: a non-empty string, else none.
const authorName = (r: Receipt) => ({ 1: 'Ann Lee', 6: '[Ann]', 7: '[]' } as Record<number, string>)[r.author] ?? null;
const heldId = (i: number) => `rf${pad(i, 24)}`;
const FEED_TITLE = 'Morning brief';
const GENERATED = '2026-01-15T10:00:00.000Z';
const MODEL = 'test-model';
/** The outside assistant's edition, from the plan alone: what the driver puts and the model expects to read back. */
function outsideEdition(plan: Plan) {
  const entries = plan.outside.map((o, n) => ({
    ...(o.kind === 'mention' ? { mention: plan.receipts[o.target] ? receiptId(o.target) : `nosuchreceipt${o.target}` } : o.kind === 'remote' ? { remote: { origin: originOf(o.target), id: 'x' } } : { sub: blyg(plan.refs[o.target]?.from ?? 0).sub, remoteId: heldId(o.target) }),
    ...(o.full ? { present: 'full' } : {}),
    ...(o.words ? { headline: `Head ${n}`, summary: `Sum ${n}`, reason: `Why ${n}` } : {}),
  }));
  const m = plan.meta;
  return {
    ...(m.title ? { title: 'An edition' } : {}), ...(m.lede ? { lede: 'A lede' } : {}),
    agent: { name: 'outside', ...(m.model ? { model: MODEL } : {}) },
    ...(m.generatedAt ? { generatedAt: GENERATED } : {}),
    sections: [
      { title: 'Outside', ...(m.kind === 'none' ? {} : { kind: m.kind }), ...(m.note ? { note: 'A note' } : {}), entries: entries.length ? entries : [{ sub: '~own', remoteId: 'nosuchitem' }] },
      // A section none of whose entries resolve: it is dropped from the layout and the thread.
      { title: 'Gone', entries: [{ remote: { origin: OWN_ORIGIN, id: 'x' } }] },
    ],
  };
}
// The Studio's date form in the owner's timezone (UTC here): "Nov 27, 2026".
const dateOf = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const hostOf = (url: string) => new URL(url).host;
/** A plain markdown link, or none when the url holds a space, bracket or angle; its text loses brackets and falls back to the host. */
const linkLine = (words: string | null, url: string) => (/^https?:\/\/[^\s()<>]+$/.test(url) ? `[${(words ?? '').replace(/[[\]]/g, '') || hostOf(url)}](${url})` : null);
/** The thread an edition composes (src/agentic-thread.ts's header): headings, quote or link lines, and impyrt spans for the assistant's words. */
function threadOf(heading: string, date: string, layout: { title?: string; lede?: string; model?: string; sections: { title: string; note?: string; entries: { line: string | null; headline?: string; summary?: string; reason?: string }[] }[] }) {
  const span = (w: string) => `[TK]impyrt${layout.model ? ` ${layout.model}` : ''}=${w}[/TK]`;
  const blocks = [`# ${heading}, ${date}`, ...(layout.title ? [span(layout.title)] : []), ...(layout.lede ? [span(layout.lede)] : [])];
  for (const section of layout.sections) {
    blocks.push(`## ${span(section.title)}`, ...(section.note ? [span(section.note)] : []));
    for (const e of section.entries) {
      if (e.line === null) continue;
      blocks.push(...(e.headline ? [span(e.headline)] : []), ...(e.summary ? [span(e.summary)] : []), e.line, ...(e.reason ? [span(e.reason)] : []));
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

/** The directory as served: the first listing of an origin counts; a down directory lists nothing. */
function listings(plan: Plan): Map<number, Listing> {
  const out = new Map<number, Listing>();
  if (plan.directory.ok) for (const l of plan.directory.listed) if (!out.has(l.target)) out.set(l.target, l);
  return out;
}

type Shown = { t: number; sample: number; created: number };
type Discovery = { met: Map<number, number>; listed: Map<number, Listing>; reads: number[]; shown: Shown[] };
function discover(plan: Plan, now: number): Discovery {
  const listed = listings(plan);
  // How often met: references that name an origin, and verified receipts' sources. A listing adds no meeting.
  const met = new Map<number, number>();
  for (const r of plan.refs) if (r.form !== 'none') met.set(r.to, (met.get(r.to) ?? 0) + 1);
  for (const r of plan.receipts) if (r.status === 'verified') met.set(r.source, (met.get(r.source) ?? 0) + 1);
  const fresh = (ms: number) => ms > now - 14 * DAY && ms <= now;
  const lastPost = (t: number) => { const l = listed.get(t)?.lastPost; return typeof l === 'number' ? now - l * DAY : null; };
  const queue = Array.from({ length: OTHERS }, (_, t) => t)
    .filter((t) => (met.get(t) ?? 0) > 0 || listed.has(t))
    .filter((t) => !listed.has(t) || (lastPost(t) !== null && fresh(lastPost(t)!)))
    .sort((a, b) => (met.get(b) ?? 0) - (met.get(a) ?? 0) || (lastPost(b) ?? -Infinity) - (lastPost(a) ?? -Infinity) || a - b);
  const reads: number[] = [];
  const found: Shown[] = [];
  for (const t of queue) {
    if (reads.length >= 13 || found.length >= 5) break;
    reads.push(t);
    const f = plan.feeds[t]!;
    if (f.status !== 'ok') continue;
    // Newest first; of equals, the smaller index, which is the smaller id.
    const active = f.entries.map((e, j) => ({ j, at: createdAt(e, now), e })).filter((x) => !x.e.withdrawn && !x.e.plain && fresh(x.at)).sort((a, b) => b.at - a.at || a.j - b.j);
    if (active.length) found.push({ t, sample: active[0]!.j, created: active[0]!.at });
  }
  const shown = found.sort((a, b) => (met.get(b.t) ?? 0) - (met.get(a.t) ?? 0) || b.created - a.created || a.t - b.t).slice(0, 5);
  return { met, listed, reads, shown };
}

type Section = { title: string; kind: string; entries: string[] };
type Layout = { title: string | null; lede: string | null; agent: { name: string; model?: string }; generatedAt: string | null; sections: { title: string; kind: string; note: string | null; entries: string[] }[] };
type Expected = { first: Section[]; second: Section[]; fetches: string[]; outside: { label: string; detail: string }[]; layout: Layout; firstThread: string; outsideThread: string; revision: number; states: string[] };
const MENTIONS_TITLE = "Mentions from blygs you don't follow";
const NEW_BLYGS_TITLE = 'Newly active blygs';
// One fixed instant per history, so the model's window and the driver's agree.
const NOW = Date.parse('2026-11-27T12:00:00.000Z');

function model(plan: Plan): Expected {
  const hours = plan.frequency === 'weekly' ? 168 : 24;
  const d = discover(plan, NOW);
  const later = NOW + plan.later * HOUR;
  const followedAfter = (t: number) => t === plan.follow;
  // The two outside sections of an edition written at `at`, with `followed` the origins followed then.
  const edition = (at: number, followedNow: (t: number) => boolean): Section[] => {
    const inWindow = (ms: number) => ms > at - hours * HOUR && ms <= at;
    const mentions = plan.receipts.map((r, i) => ({ r, i, at: verifiedAt(r, NOW) }))
      .filter(({ r, at: v }) => r.status === 'verified' && inWindow(v) && other(r.source) && !followedNow(r.source))
      .sort((a, b) => b.at - a.at || a.i - b.i).slice(0, 5).map(({ i }) => `mention-${i}`);
    const blygs = d.shown.filter((s) => !followedNow(s.t) && s.created > at - 14 * DAY && s.created <= at).map((s) => `remote-${s.t}/${s.sample}`);
    return [
      ...(mentions.length ? [{ title: MENTIONS_TITLE, kind: 'briefs', entries: mentions }] : []),
      ...(blygs.length ? [{ title: NEW_BLYGS_TITLE, kind: 'briefs', entries: blygs }] : []),
    ];
  };
  const first = edition(NOW, () => false);
  const second = edition(later, followedAfter);
  const fetches = [DIRECTORY, ...d.reads.map((t) => feedUrl(t, d.listed.has(t)))];
  // Resolution: what the discovery stored, every met other origin, active or not.
  const metOrigin = (t: number) => other(t) && ((d.met.get(t) ?? 0) > 0 || d.listed.has(t));
  const seen = new Set<string>();
  // Each outside entry that resolves, once, with what the layout shows of it and its line in the thread.
  const resolved = plan.outside.flatMap((o, n) => {
    const key = `${o.kind}-${o.target}`;
    const receipt = plan.receipts[o.target];
    const resolves = o.kind === 'mention' ? receipt?.status === 'verified' : o.kind === 'remote' ? metOrigin(o.target) : o.target < plan.refs.length;
    if (seen.has(key) || !resolves) return [];
    seen.add(key);
    const words = o.words ? { headline: `Head ${n}`, summary: `Sum ${n}`, reason: `Why ${n}` } : {};
    if (o.kind === 'mention') {
      const page = sourcePage(receipt!, o.target);
      return [{ label: `mention-${o.target}`, detail: [page, originOf(receipt!.source), `ms${pad(o.target, 24)}`, 'thread', receiptRelations[o.target % 3], authorName(receipt!), new Date(verifiedAt(receipt!, NOW)).toISOString(), `ownitem${o.target}`].join(' | '), line: linkLine(authorName(receipt!), page), ...words }];
    }
    if (o.kind === 'remote') return [{ label: `remote-${o.target}/x`, detail: d.listed.has(o.target) ? `listed | Site ${o.target}` : 'met in reading | ', line: linkLine(d.listed.has(o.target) ? `Site ${o.target}` : null, originOf(o.target)), ...words }];
    return [{ label: `held-${o.target}`, detail: 'held', line: o.full ? `![[${heldId(o.target)}]]` : `[[${heldId(o.target)}]]`, ...words }];
  });
  const outside = resolved.map(({ label, detail }) => ({ label, detail }));
  const m = plan.meta;
  const layout: Layout = {
    title: m.title ? 'An edition' : null, lede: m.lede ? 'A lede' : null, agent: { name: 'outside', ...(m.model ? { model: MODEL } : {}) }, generatedAt: m.generatedAt ? GENERATED : null,
    sections: resolved.length ? [{ title: 'Outside', kind: m.kind === 'none' ? 'section' : m.kind, note: m.note ? 'A note' : null, entries: resolved.map((r) => r.label) }] : [],
  };
  // The outside thread's date is its generatedAt's, else the replace's own time, which the check reads back: {updated} stands for it.
  const outsideThread = threadOf(FEED_TITLE, m.generatedAt ? dateOf(GENERATED) : '{updated}', {
    ...(m.title ? { title: 'An edition' } : {}), ...(m.lede ? { lede: 'A lede' } : {}), ...(m.model ? { model: MODEL } : {}),
    sections: layout.sections.map((s) => ({ title: s.title, ...(m.note ? { note: 'A note' } : {}), entries: resolved })),
  });
  // The resident's first edition as a thread: its sections' titles, and each entry's link.
  const residentLine = (label: string) => {
    if (label.startsWith('mention-')) { const i = Number(label.slice(8)); return linkLine(authorName(plan.receipts[i]!), sourcePage(plan.receipts[i]!, i)); }
    const t = Number(label.slice(7, label.indexOf('/')));
    return linkLine(d.listed.has(t) ? `Site ${t}` : null, originOf(t));
  };
  const firstThread = threadOf(FEED_TITLE, dateOf(new Date(NOW).toISOString()), { sections: first.map((s) => ({ title: s.title, entries: s.entries.map((e) => ({ line: residentLine(e) })) })) });
  const revision = (JSON.stringify(first) !== JSON.stringify(second) ? 2 : 1) + 1;
  const inDay = (r: Receipt) => verifiedAt(r, NOW) > NOW - hours * HOUR && verifiedAt(r, NOW) <= NOW;
  const listedMentions = plan.receipts.filter((r) => r.status === 'verified' && inDay(r) && other(r.source));
  const states = [
    ...(first.some((s) => s.title === MENTIONS_TITLE) ? ['mentions'] : []),
    ...(plan.receipts.some((r) => r.status === 'verified' && inDay(r) && !other(r.source)) ? ['mention from a followed or own origin'] : []),
    ...(plan.receipts.some((r) => r.status !== 'verified' && inDay(r) && other(r.source)) ? ['mention not verified'] : []),
    ...(listedMentions.some((r) => r.hidden) ? ['hidden mention listed'] : []),
    ...(listedMentions.length > 5 ? ['more mentions than shown'] : []),
    ...(new Set(listedMentions.map((r) => r.age)).size < listedMentions.length ? ['mentions tie'] : []),
    ...(plan.receipts.some((r) => r.status === 'verified' && (r.age === hours || r.age < 0)) ? ['mention window edge'] : []),
    ...(first.some((s) => s.title === NEW_BLYGS_TITLE) ? ['new blygs'] : []),
    ...(d.shown.some((s) => d.listed.has(s.t) && !(d.met.get(s.t) ?? 0)) ? ['listed only'] : []),
    ...(d.shown.some((s) => !d.listed.has(s.t)) ? ['met in reading only'] : []),
    ...([...d.listed.keys()].some((t) => other(t) && !d.reads.includes(t) && d.reads.length < 13 && d.shown.length < 5) ? ['stale listing not read'] : []),
    ...(d.reads.length === 13 ? ['read budget spent'] : []),
    ...(d.shown.length === 5 && d.reads.length < 13 ? ['five found early'] : []),
    ...(!plan.directory.ok ? ['directory down'] : []),
    ...(plan.directory.ok && new Set(plan.directory.listed.map((l) => l.target)).size < plan.directory.listed.length ? ['listed twice'] : []),
    ...([...d.listed.keys(), ...plan.refs.filter((r) => r.form !== 'none').map((r) => r.to)].some((t) => t === OWN) ? ['own origin met'] : []),
    ...(plan.refs.some((r) => r.form === 'none') ? ['reference without an origin'] : []),
    ...(d.reads.some((t) => plan.feeds[t]!.status === 'ok' && plan.feeds[t]!.entries.length && !d.shown.some((s) => s.t === t)) ? ['inactive feed read'] : []),
    ...(d.reads.some((t) => plan.feeds[t]!.status !== 'ok' && plan.feeds[t]!.entries.some((e) => !e.withdrawn && !e.plain && e.created >= 0 && e.created < 14)) ? ['active feed refused'] : []),
    ...(d.shown.some((s) => plan.feeds[s.t]!.entries.some((e, j) => j !== s.sample && createdAt(e, NOW) === s.created && !e.withdrawn && !e.plain)) ? ['samples tie'] : []),
    ...(d.shown.some((s) => plan.feeds[s.t]!.entries.some((e) => (e.withdrawn || e.plain) && createdAt(e, NOW) > s.created && createdAt(e, NOW) <= NOW)) ? ['newer item not a sample'] : []),
    ...(!first.length ? ['quiet'] : []),
    ...(JSON.stringify(first) !== JSON.stringify(second) ? ['second edition differs'] : []),
    ...(d.shown.some((s) => s.t === plan.follow) ? ['followed since'] : []),
    ...(d.shown.some((s) => s.created <= later - 14 * DAY) ? ['sample aged out'] : []),
    ...(outside.length < plan.outside.length ? ['outside entry dropped'] : []),
    ...(outside.some((o) => o.detail.startsWith('met in reading')) ? ['remote met in reading'] : []),
    ...(outside.some((o) => o.label.startsWith('remote') && !d.shown.some((s) => o.label.startsWith(`remote-${s.t}/`))) ? ['remote met but not shown'] : []),
    ...(outside.some((o) => o.label.startsWith('mention') && plan.receipts[Number(o.label.slice(8))]!.hidden) ? ['hidden receipt resolves'] : []),
    ...(outside.some((o) => o.label.startsWith('mention') && plan.receipts[Number(o.label.slice(8))]!.author === 1) ? ['receipt with an author'] : []),
    ...(resolved.some((r) => r.line === null) ? ['unlinkable page'] : []),
    ...(resolved.some((r) => r.label.startsWith('mention') && /[[\]]/.test(authorName(plan.receipts[Number(r.label.slice(8))]!) ?? '')) ? ['bracketed author'] : []),
    ...(resolved.some((r) => r.label.startsWith('held')) ? ['held entry'] : []),
    ...(plan.outside.some((o) => o.full) && resolved.some((r) => r.label.startsWith('held')) ? ['held in full'] : []),
    ...(m.title && m.lede && m.note && m.model && resolved.some((r) => 'headline' in r) ? ['every word'] : []),
    ...(!m.generatedAt && resolved.length ? ['dated by the replace'] : []),
  ];
  return { first, second, fetches, outside, layout, firstThread, outsideThread, revision, states };
}

async function seed(plan: Plan) {
  const cookie = await login();
  const api = (method: string, path: string, body?: unknown) => apiJson(cookie, method, '/blyg/api' + path, body);
  for (const b of [0, 1, 2]) {
    await env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES(?,'blyg',?,?,?,'2026-01-01')")
      .bind(blyg(b).sub, blyg(b).origin, blyg(b).origin + 'feed.xml', `Blyg ${b}`).run();
  }
  // Held items, old enough to be outside every window, each pointing at one origin, or at an item on its own blyg.
  const old = '2025-01-01T00:00:00.000Z';
  for (const [i, r] of plan.refs.entries()) {
    const id = `rf${pad(i, 24)}`;
    const origin = r.form === 'bare' ? originOf(r.to).replace(/\/$/, '') : originOf(r.to);
    const pointer = { ...(r.form === 'none' ? {} : { origin }), id: `tg${pad(i, 24)}`, version: 1 };
    const doc = JSON.parse(await itemDocBody({ id, kind: r.relation === 'stub' || r.relation === 'quote' ? 'thread' : 'fragment', version: 1, created: old, updated: old, origin: blyg(r.from).origin, content_md: 'a held item', content_html: '<p>a held item</p>' }));
    if (r.relation === 'stub') doc.stub_of = pointer;
    if (r.relation === 'fork') doc.forked_from = pointer;
    if (r.relation === 'quote') doc.transclusions = [pointer];
    if (r.relation === 'link') doc.links = [{ ...(r.form === 'none' ? {} : { origin }), id: pointer.id }];
    await applyEffect(env.DB, blyg(r.from).sub, id, transition({ local: { status: 'absent' }, doc }).effect, old);
  }
  // Receipts as the receiver stores them, with ids in the plan's order so their tie-break is predictable.
  for (const [i, r] of plan.receipts.entries()) {
    const page = sourcePage(r, i);
    const claim = await upsertInbound(env.DB, page, `${OWN_ORIGIN}items/ownitem${i}`, `ownitem${i}`);
    await env.DB.prepare('UPDATE mentions_in SET id = ? WHERE id = ?').bind(receiptId(i), claim.id).run();
    if (r.status === 'verified') await markInboundVerified(env.DB, receiptId(i), { relation: receiptRelations[i % 3]!, sourceOrigin: originOf(r.source), sourceId: `ms${pad(i, 24)}`, sourceKind: 'thread', sourceVersion: 1, authorJson: authors[r.author]!, sourcePage: page }, new Date(verifiedAt(r, NOW)).toISOString());
    if (r.status === 'failed') await env.DB.prepare("UPDATE mentions_in SET status = 'failed' WHERE id = ?").bind(receiptId(i)).run();
    if (r.hidden) await env.DB.prepare('UPDATE mentions_in SET hidden = 1 WHERE id = ?').bind(receiptId(i)).run();
  }
  const set = await api('PATCH', '/settings', { agenticFrequency: plan.frequency, agenticTitle: FEED_TITLE });
  if (set.status !== 200) throw new Error(`agentic outside: could not set the frequency: ${set.status}`);
  return { api };
}

/**
 * The network as the plan states it: the directory as served (a junk row
 * first, duplicates kept; a down directory answers 500 with the same body),
 * and each other origin's feed at the one place its listing, or its absence,
 * puts it, with items out of id order. A missing feed answers 404 with its body.
 */
function network(plan: Plan) {
  const listed = listings(plan);
  const map: Record<string, FixtureResponse> = {};
  const row = (l: Listing) => ({
    origin: originOf(l.target), title: `Site ${l.target}`, home: originOf(l.target), feed: feedUrl(l.target, true), listedAt: '2026-01-01T00:00:00Z',
    ...(l.lastPost === 'none' ? {} : { activity: { level: null, events: 0, lastPost: l.lastPost === null ? null : new Date(NOW - l.lastPost * DAY).toISOString() } }),
    author: null, generator: null,
  });
  const body = JSON.stringify({ version: 1, blygs: [{ origin: 'not a url', title: 'junk', activity: { lastPost: new Date(NOW).toISOString() } }, ...plan.directory.listed.map(row)] });
  map[DIRECTORY] = plan.directory.ok ? { body } : { status: 500, body };
  for (let t = 0; t < OTHERS; t++) {
    const f = plan.feeds[t]!;
    const item = (e: Feed['entries'][number], j: number) => `<item><guid isPermaLink="false">${e.plain ? `plain-${t}-${j}` : `blyg:${sampleId(t, j)}:v1`}</guid><link>${originOf(t)}t/${sampleId(t, j)}/</link><title>Item ${j}</title>${e.plain ? '' : `<blyg:id>${sampleId(t, j)}</blyg:id><blyg:kind>${e.withdrawn ? 'withdrawn' : 'thread'}</blyg:kind><blyg:version>1</blyg:version><blyg:created>${new Date(createdAt(e, NOW)).toISOString()}</blyg:created>`}</item>`;
    // Out of id order: the second item first.
    const items = f.entries.map((e, j) => item(e, j));
    if (items.length > 1) [items[0], items[1]] = [items[1]!, items[0]!];
    const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:blyg="https://blygger.org/ns/0.1"><channel><title>Site ${t}</title><link>${originOf(t)}</link>${items.join('')}</channel></rss>`;
    map[feedUrl(t, listed.has(t))] = f.status === 'broken' ? { body: '<rss><channel><item>' } : f.status === 'missing' ? { status: 404, body: xml } : { body: xml };
  }
  // An unreachable feed's fetch throws, as a network failure does; the request is still recorded.
  const fixture = makeFixtureFetch(map);
  const unreachable = new Set(plan.feeds.flatMap((f, t) => (f.status === 'unreachable' ? [feedUrl(t, listed.has(t))] : [])));
  const fetch: typeof fixture.fetch = async (url, init) => {
    const res = await fixture.fetch(url, init);
    if (unreachable.has(url)) throw new TypeError(`network connection lost: ${url}`);
    return res;
  };
  return { fetch, calls: fixture.calls };
}

type Placed = { mention?: string; remote?: { origin: string; id: string }; receipt?: Record<string, string | null>; site?: { listed: boolean; title: string | null } };
const labelOf = (e: Placed) => {
  if (e.mention) return `mention-${e.mention.startsWith('rc') ? Number(e.mention.slice(2)) : e.mention}`;
  if (e.remote) {
    const t = Array.from({ length: 18 }, (_, n) => n).find((n) => originOf(n) === e.remote!.origin);
    const j = Array.from({ length: 3 }, (_, n) => n).find((n) => t !== undefined && sampleId(t, n) === e.remote!.id);
    return `remote-${t ?? e.remote.origin}/${j ?? e.remote.id}`;
  }
  return `held-${(e as { remoteId?: string }).remoteId?.startsWith('rf') ? Number((e as { remoteId: string }).remoteId.slice(2)) : 'unknown'}`;
};
const sectionsOf = (layout: { sections?: { title: string; kind: string; entries: Placed[] }[] } | null | undefined) =>
  (layout?.sections ?? []).map((s) => ({ title: s.title, kind: s.kind, entries: s.entries.map(labelOf) }));

async function drive(plan: Plan, observe: (checkpoint: string, value: unknown) => void) {
  await withOracleStorage(async () => {
    const { api: owner } = await seed(plan);
    // A response that breaks the published contract is production's error, recorded for the check.
    const api = async (method: string, path: string, body?: unknown) => {
      try { return await owner(method, path, body); } catch (error) { observe('production error', error instanceof Error ? error.message.slice(0, 200) : String(error)); return { status: 0, json: null }; }
    };
    const net = network(plan);
    const write = async (at: number, discover: boolean) => {
      try { await writeResidentDigest(env.DB, at, OWN_ORIGIN, discover ? { discover: net.fetch } : {}); } catch (error) { observe('production error', error instanceof Error ? `${error.name}: ${error.message}` : String(error)); }
    };
    await write(NOW, true);
    observe('fetches', [...net.calls]);
    const first = await api('GET', '/agentic/default');
    observe('edition', sectionsOf(first.json?.layout));
    const draftOf = async (id: string | undefined) => (id ? (await api('GET', `/items/${id}`)).json?.contentMd ?? null : null);
    observe('first thread', await draftOf(first.json?.draft?.id));
    // An origin followed after the discovery, then the edition written again later, without discovery.
    if (plan.follow >= 0) {
      await env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES('outside-followed','blyg',?,?,'Followed','2026-01-01')")
        .bind(originOf(plan.follow), originOf(plan.follow) + 'feed.xml').run();
    }
    const before = net.calls.length;
    await write(NOW + plan.later * HOUR, false);
    observe('fetches again', net.calls.length - before);
    const again = await api('GET', '/agentic/default');
    observe('second edition', sectionsOf(again.json?.layout));
    observe('rewritten', again.json?.revision !== first.json?.revision);
    // An outside assistant's edition naming receipts, origins and held items.
    const edition = outsideEdition(plan);
    const put = await api('PUT', '/agentic/default', { edition, expectedRevision: again.json?.revision ?? 0 });
    if (put.status !== 200) { observe('outside', { status: put.status, body: put.json }); return; }
    const read = await api('GET', '/agentic/default');
    const layout = read.json?.layout;
    observe('outside response', { revision: read.json?.revision, mode: read.json?.mode, edition: read.json?.edition, updatedAt: typeof read.json?.updatedAt === 'string', draftKept: read.json?.draft?.id === first.json?.draft?.id });
    observe('outside layout', layout && { title: layout.title, lede: layout.lede, agent: layout.agent, generatedAt: layout.generatedAt, sections: (layout.sections as { title: string; kind: string; note: string | null; entries: Placed[] }[]).map((s) => ({ title: s.title, kind: s.kind, note: s.note, entries: s.entries.map(labelOf) })) });
    observe('outside thread', (await draftOf(read.json?.draft?.id))?.replace(`, ${dateOf(read.json?.updatedAt ?? NOW)}\n`, ', {updated}\n') ?? null);
    observe('unknown feed', (await api('GET', '/agentic/nosuchfeed')).status);
    const placed = ((put.json.layout?.sections ?? []) as { entries: Placed[] }[]).flatMap((s) => s.entries);
    observe('outside', placed.map((e) => ({
      label: labelOf(e),
      detail: e.receipt ? [e.receipt.sourcePage, e.receipt.sourceOrigin, e.receipt.sourceId, e.receipt.sourceKind, e.receipt.relation, e.receipt.author, e.receipt.verifiedAt, e.receipt.targetItemId].join(' | ')
        : e.site ? `${e.site.listed ? 'listed' : 'met in reading'} | ${e.site.title ?? ''}` : 'held',
    })));
  });
}

const sectionNamed = (trace: readonly Observation[], checkpoint: string, title: string) => ((trace.find((e) => e.checkpoint === checkpoint)?.value ?? []) as Section[]).find((s) => s.title === title) ?? null;
const owed = (sections: Section[], title: string) => sections.find((s) => s.title === title) ?? null;
const valueAt = (trace: readonly Observation[], checkpoint: string) => trace.find((e) => e.checkpoint === checkpoint)?.value;

function checker(law: string, compare: (trace: readonly Observation[], expected: Expected) => ReturnType<typeof differs> | null) {
  return (_plan: Plan, trace: readonly Observation[], expected: Expected) => {
    const errors = trace.filter((e) => e.checkpoint === 'production error').map((e) => e.value);
    if (errors.length) return differs('production error', law, errors, []) ?? pass;
    // The edition law over these sections: an edition is rewritten exactly when they change.
    return compare(trace, expected)
      ?? differs('rewritten', law, valueAt(trace, 'rewritten'), JSON.stringify(expected.first) !== JSON.stringify(expected.second))
      ?? pass;
  };
}
const sectionLaw = (law: string, title: string) => (trace: readonly Observation[], expected: Expected) =>
  differs('edition', law, sectionNamed(trace, 'edition', title), owed(expected.first, title))
  ?? differs('second edition', law, sectionNamed(trace, 'second edition', title), owed(expected.second, title));

const quietFeeds = (): Feed[] => Array.from({ length: OTHERS }, () => ({ status: 'ok' as const, entries: [] }));
const activeFeeds = (): Feed[] => Array.from({ length: OTHERS }, (_, t) => ({ status: 'ok' as const, entries: [{ created: t % 3 ? 1 : 13, withdrawn: false, plain: false }] }));
const entry = (created: number, over: Partial<Feed['entries'][number]> = {}) => ({ created, withdrawn: false, plain: false, ...over });
const plain: Meta = { title: false, lede: false, generatedAt: false, model: false, note: false, kind: 'none' };
const base = (over: Partial<Plan>): Plan => ({ frequency: 'daily', refs: [], receipts: [], directory: { ok: true, listed: [] }, feeds: quietFeeds(), follow: -1, later: 0, outside: [], meta: plain, ...over });
const receipt = (source: number, age: number, over: Partial<Receipt> = {}): Receipt => ({ source, status: 'verified', hidden: false, age, author: 0, odd: false, ...over });
const out = (kind: Outside['kind'], target: number, over: Partial<Outside> = {}): Outside => ({ kind, target, full: false, words: false, ...over });

const histories = {
  arbitrary,
  runs: 15, fixedSeeds: [20261127],
  states: ['mentions', 'mention from a followed or own origin', 'mention not verified', 'hidden mention listed', 'more mentions than shown', 'mentions tie', 'mention window edge', 'new blygs', 'listed only', 'met in reading only', 'stale listing not read', 'read budget spent', 'five found early', 'directory down', 'listed twice', 'own origin met', 'reference without an origin', 'inactive feed read', 'active feed refused', 'samples tie', 'newer item not a sample', 'quiet', 'second edition differs', 'followed since', 'sample aged out', 'outside entry dropped', 'remote met in reading', 'remote met but not shown', 'hidden receipt resolves', 'receipt with an author', 'unlinkable page', 'bracketed author', 'held entry', 'held in full', 'every word', 'dated by the replace'],
  constructed: [
    { name: 'a quiet day', build: () => base({}), enters: ['quiet'] },
    {
      name: 'mentions from everywhere', enters: ['mentions', 'mention from a followed or own origin', 'mention not verified', 'hidden mention listed', 'mention window edge', 'mentions tie', 'outside entry dropped', 'hidden receipt resolves', 'receipt with an author', 'second edition differs', 'unlinkable page', 'bracketed author', 'every word'],
      build: () => base({
        receipts: [receipt(0, 1, { hidden: true, author: 1, odd: true }), receipt(1, 0, { author: 7 }), receipt(FOLLOWED, 1), receipt(OWN, 1, { author: 5 }), receipt(2, 1, { status: 'pending' }), receipt(3, 1, { author: 6 }), receipt(4, 24, { author: 4 })],
        follow: 1, later: 1,
        outside: [out('mention', 0, { words: true }), out('mention', 4), out('mention', 1, { full: true }), out('mention', 12), out('mention', 5, { words: true }), out('mention', 0)],
        meta: { title: true, lede: true, generatedAt: true, model: true, note: true, kind: 'lead' },
      }),
    },
    {
      name: 'six fresh mentions', enters: ['mentions', 'more mentions than shown', 'mentions tie'],
      build: () => base({ frequency: 'weekly', receipts: [0, 1, 2, 3, 4, 5].map((s) => receipt(s, s % 2 ? 25 : 167)) }),
    },
    {
      name: 'blygs met in reading and listed', enters: ['new blygs', 'listed only', 'met in reading only', 'stale listing not read', 'own origin met', 'reference without an origin', 'listed twice', 'inactive feed read', 'samples tie', 'newer item not a sample', 'remote met in reading', 'remote met but not shown', 'outside entry dropped', 'second edition differs', 'followed since', 'held entry', 'held in full', 'dated by the replace'],
      build: () => base({
        refs: [{ from: 0, to: 0, relation: 'quote', form: 'bare' }, { from: 1, to: 0, relation: 'stub', form: 'slash' }, { from: 2, to: 1, relation: 'link', form: 'slash' }, { from: 0, to: OWN, relation: 'fork', form: 'slash' }, { from: 0, to: 5, relation: 'fork', form: 'slash' }, { from: 1, to: FOLLOWED, relation: 'quote', form: 'slash' }, { from: 2, to: 7, relation: 'link', form: 'none' }],
        directory: { ok: true, listed: [{ target: 2, lastPost: 0 }, { target: 3, lastPost: 40 }, { target: 4, lastPost: null }, { target: OWN, lastPost: 1 }, { target: 6, lastPost: 13 }, { target: 8, lastPost: 'none' }, { target: 2, lastPost: 40 }, { target: 9, lastPost: 14 }] },
        feeds: Array.from({ length: OTHERS }, (_, t) => ({
          status: 'ok' as const,
          // Origin 0 is met most but posted longest ago, so how often met, not the sample's age, puts it first.
          entries: t === 0 ? [entry(13), entry(0, { withdrawn: true }), entry(0, { plain: true })] : t === 1 ? [entry(1), entry(1), entry(13)] : t === 5 ? [entry(30)] : t === 6 ? [entry(15)] : t === 2 ? [entry(14), entry(13)] : [entry(13)],
        })),
        follow: 1,
        outside: [out('remote', 5, { words: true }), out('remote', 3), out('remote', 10), out('held', 0, { full: true }), out('held', 2), out('held', 9)],
        meta: { ...plain, note: true, kind: 'briefs' },
      }),
    },
    {
      name: 'sixteen active listings', enters: ['new blygs', 'listed only', 'five found early', 'sample aged out', 'second edition differs'],
      build: () => base({ directory: { ok: true, listed: Array.from({ length: OTHERS }, (_, t) => ({ target: t, lastPost: t % 2 ? 1 : 13 })) }, feeds: activeFeeds(), later: 300 }),
    },
    {
      name: 'sixteen listings, few active', enters: ['read budget spent', 'new blygs', 'listed only', 'active feed refused'],
      build: () => base({ directory: { ok: true, listed: Array.from({ length: OTHERS }, (_, t) => ({ target: t, lastPost: 1 })) }, feeds: Array.from({ length: OTHERS }, (_, t) => ({ status: t === 15 || t === 2 ? 'ok' as const : t % 3 === 0 ? 'unreachable' as const : t % 2 ? 'missing' as const : 'broken' as const, entries: [entry(1)] })) }),
    },
    {
      name: 'the directory is down', enters: ['directory down', 'new blygs', 'met in reading only', 'remote met in reading'],
      build: () => base({ refs: [{ from: 0, to: 7, relation: 'link', form: 'slash' }], receipts: [receipt(8, 25)], directory: { ok: false, listed: [{ target: 9, lastPost: 1 }] }, feeds: activeFeeds(), outside: [out('remote', 8), out('remote', 9)] }),
    },
  ],
};

const common = {
  histories, model,
  reached: (plan: Plan) => model(plan).states,
  driver: drive,
  // Each history seeds the importer, receipts and the owner API, and writes three editions.
  timeout: 30_000,
};

oracleProperty({
  id: 'agentic-mentions', owns: ['src/agentic-digest.ts#outsideSections'],
  law: { statement: "For every edition window, the digest lists a mention receipt if and only if it is verified, was verified in the window, and its source origin is neither followed nor the owner's own, hidden or not; newest first, then by receipt id, at most 5; an empty section is absent, and an edition is rewritten exactly when it changes.", authority: 'Decision by Venkat Rao (GitHub vgururao), 2026-11-27: blygger-spec docs/agentic-digest-plan.md §8 laws 3 and 5, approved as written; hidden receipts shown, the same day.', limits: 'At most seven receipts.' },
  ...common,
  check: checker(MENTIONS, sectionLaw(MENTIONS, MENTIONS_TITLE)),
  calibrations: [{ name: 'a mention from a followed blyg listed', law: MENTIONS, history: { constructed: 'mentions from everywhere' }, corrupt: (trace) => trace.map((e) => (e.checkpoint === 'edition' ? { ...e, value: (e.value as Section[]).map((s) => (s.title === MENTIONS_TITLE ? { ...s, entries: ['mention-2', ...s.entries] } : s)) } : e)) }],
});

oracleProperty({
  id: 'agentic-new-blygs', owns: ['src/agentic-discovery.ts', 'src/agentic-digest.ts#outsideSections'],
  law: { statement: "For every discovery, the digest lists an origin if and only if it is met, neither followed nor the owner's own, its feed was read from the queue (listed ones only with a lastPost under 14 days, ranked by how often met, then lastPost, then origin, at most 13 reads, stopping at five active) and answered with an item, not withdrawn, created in the last 14 days; the newest such item (of equals, the smaller id) is its sample; most met first, then newest, then origin; at most 5. Discovery fetches the directory and those feeds only, and a later edition without discovery shows the same blygs less any followed since or aged out, and fetches nothing.", authority: 'Decision by Venkat Rao (GitHub vgururao), 2026-11-27: blygger-spec docs/agentic-digest-plan.md §8 law 4, approved as written, bounded to one daily discovery of at most 14 fetches with the directory deciding which listed feeds are read, stored in met_origins, the same day.', limits: 'Sixteen other origins, three entries a feed. The cron choosing the 07:00 tick is not here; an unlisted feed not at feed.xml is not found.' },
  ...common,
  check: checker(NEW_BLYGS, (trace, expected) => differs('fetches', NEW_BLYGS, valueAt(trace, 'fetches'), expected.fetches)
    ?? sectionLaw(NEW_BLYGS, NEW_BLYGS_TITLE)(trace, expected)
    ?? differs('fetches again', NEW_BLYGS, valueAt(trace, 'fetches again'), 0)),
  calibrations: [{ name: 'a stale listing read anyway', law: NEW_BLYGS, history: { constructed: 'blygs met in reading and listed' }, corrupt: (trace) => trace.map((e) => (e.checkpoint === 'fetches' ? { ...e, value: [...(e.value as string[]), feedUrl(3, true)] } : e)) }],
});

oracleProperty({
  id: 'agentic-outside-resolution', owns: ['src/agentic.ts#placeOutside', 'src/agentic.ts#outsideCards', 'src/agentic.ts#outsideKey'],
  law: { statement: 'For every edition, a mention entry resolves if and only if its receipt exists and is verified (hidden or not), showing the receipt as stored, and a remote entry if and only if the last discovery met its origin, listed or referenced, active or not, showing its listing; a repeat is shown once, and anything else is left out.', authority: 'Decision by Venkat Rao (GitHub vgururao), 2026-11-27: blygger-spec docs/agentic-digest-plan.md §6 (the edition resolution law), approved as written, with form B (met_origins) the same day.', limits: 'Six outside entries an edition; a remote entry names id x, never checked against the origin.' },
  ...common,
  check: checker(RESOLUTION, (trace, expected) => differs('outside', RESOLUTION, valueAt(trace, 'outside'), expected.outside)),
  calibrations: [{ name: 'an unmet origin resolved', law: RESOLUTION, history: { constructed: 'blygs met in reading and listed' }, corrupt: (trace) => trace.map((e) => (e.checkpoint === 'outside' ? { ...e, value: [...(e.value as unknown[]), { label: 'remote-10/x', detail: 'met in reading | ' }] } : e)) }],
});

oracleProperty({
  id: 'agentic-edition-layout', owns: ['src/agentic.ts#readEdition', 'src/agentic.ts#writeThread', 'src/agentic-thread.ts#editionMarkdown'],
  law: { statement: "For every edition an assistant replaces, GET /agentic/{feed} returns it as written at the next revision, with a layout that keeps its title, lede, agent and date and each section's kind (section by default) and note, holding only the entries that resolve, each once, and no empty section; and its draft thread is composed as src/agentic-thread.ts documents: the feed's name and the edition's date (generatedAt, else the replace's time) as its heading, impyrt spans for the assistant's words, a quote or a link by id for a held item, a plain link for a mention or a remote item (none when its url cannot be linked), and the same draft reused while the owner has not touched it. An unknown feed is 404.", authority: 'blygger-spec docs/agentic-feed-plan.md §3–§4 (the edition and its layout, decision by Venkat Rao (GitHub vgururao), session 77) and the thread composition in src/agentic-thread.ts (sessions 77 and 85); the outside entry kinds, Venkat Rao, 2026-11-27.', limits: 'Sections mode only (scores are laid out by sectionsOf, not here); one followed blyg per held entry; plain words, so said() only passes them through; the owner never edits the draft.' },
  ...common,
  check: (plan: Plan, trace: readonly Observation[], expected: Expected) => {
    const errors = trace.filter((e) => e.checkpoint === 'production error').map((e) => e.value);
    if (errors.length) return differs('production error', LAYOUT, errors, []) ?? pass;
    // The edition as written is compared by value: the store keeps the contract's key order.
    return differs('first thread', LAYOUT, valueAt(trace, 'first thread'), expected.firstThread)
      ?? differs('outside response', LAYOUT, valueAt(trace, 'outside response'), { revision: expected.revision, mode: 'sections', edition: outsideEdition(plan), updatedAt: true, draftKept: true })
      ?? differs('outside layout', LAYOUT, valueAt(trace, 'outside layout'), expected.layout)
      ?? differs('outside thread', LAYOUT, valueAt(trace, 'outside thread'), expected.outsideThread)
      ?? differs('unknown feed', LAYOUT, valueAt(trace, 'unknown feed'), 404)
      ?? pass;
  },
  calibrations: [{ name: 'a note dropped from the layout', law: LAYOUT, history: { constructed: 'blygs met in reading and listed' }, corrupt: (trace) => trace.map((e) => (e.checkpoint === 'outside layout' ? { ...e, value: { ...(e.value as Layout), sections: (e.value as Layout).sections.map((s) => ({ ...s, note: null })) } } : e)) }],
});
