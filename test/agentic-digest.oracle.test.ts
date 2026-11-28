/**
 * This oracle owns the resident assistant's deterministic digest: which held
 * items the default Agentic feed's edition puts under Highlights and Happening
 * conversations, checked on the edition `GET /agentic/default` lays out after
 * the resident assistant writes it. It owns `src/agentic-digest.ts`.
 *
 * ```ts
 * writeResidentDigest(db, now, ownOrigin) // → Highlights: new, own words ≥ 300, not a response, longest first, at most 7
 *                                         // → Happening conversations: linked items, ≥ 2 authors, one new, at most 5
 * GET /api/agentic/default                // → an item in a conversation is never also a highlight
 * ```
 *
 * Why is a 480-word post sometimes not a highlight? Because it started a
 * conversation, and a conversation claims its items first. Its length also
 * counts only the words it says itself: a long quote or a generated span
 * inside it adds nothing.
 *
 * Three parts decide the edition. The window is the day before the edition was
 * written, or the week before it for a weekly edition. An item's own words are its text outside quotes and generated
 * spans. The link graph joins two held items when one stubs, quotes or links
 * the other, when both point at the same item (held or not), or when a verified
 * mention joins them.
 *
 * Highlights. For every edition window, an item is a highlight if and only if
 * it is held from a followed blyg that is not in Background, it was created in
 * the window, its own words are at least 300, it is not a stub or fork, and it
 * is not in a listed conversation; ordered by own words, then newest, at most 7.
 * Happening conversations. For every window, a conversation is a connected set
 * of held items in the link graph (own items included) with at least two
 * distinct authors and at least one item created in the window; each appears
 * once, ordered by its items in the window, then its newest item, at most 5,
 * showing its newest six items oldest first. The edition. An item appears in at
 * most one section, a section with no items is absent, the same held data and
 * window give the same edition, and an unchanged edition is not written again.
 * Decision by Venkat Rao (GitHub vgururao), 2026-11-27: blygger-spec
 * docs/agentic-digest-plan.md §8, laws 1, 2 and 5, approved as written, with
 * the last clause added the same day, and the window following the frequency.
 *
 * The model reads only the plan: each item's author, age, word counts and
 * relation, resolved to what can legally exist (an own item can only point at
 * a held item, since publishing refuses an unresolvable quote; a fork is not an
 * edge). The driver imports every remote item through the real importer and
 * publishes own items through the owner API, so own items are always new.
 * Verified mentions are stored as the receiver stores them. Ties fall to the
 * item id.
 *
 * Limits: at most three followed blygs, twelve items and one own item a history (own
 * items are published at run time, seconds apart, a clock the plan cannot see);
 * the own item is a plain fragment, or a thread that quotes, stubs or links one
 * held item. Only blyg subscriptions are read, not RSS ones, and own items only
 * when public. Laws 3
 * and 4 (mentions from people you don't follow, new blygs) need entry kinds
 * the edition does not have yet, so they are not here. The edition clock
 * (a daily cutoff) is not here: the window is passed in.
 */
import { env } from 'cloudflare:test';
import fc from 'fast-check';
import { differs, oracleProperty, pass, type Observation } from '@tanstack/oracles';
import { applyEffect } from '../src/importer/store.ts';
import { transition } from '../src/importer/transition.ts';
import { markInboundVerified, upsertInbound } from '../src/mentions/store.ts';
import { writeResidentDigest } from '../src/agentic-digest.ts';
import { itemDocBody } from './importer/fixtures.ts';
import { BASE, apiJson, login } from './helpers.ts';
import { withOracleStorage } from './oracle-storage.ts';

const LAW = 'agentic digest laws';
const OWN_ORIGIN = `${BASE}/blyg/`;
const GHOST = 'https://ghost.digest.test/';
const HOUR = 3_600_000;
const relations = ['none', 'stub', 'fork', 'quote', 'link'] as const;
type Relation = (typeof relations)[number];
// author -1 is the owner; a target is an earlier item's index, or an item nobody here holds.
type PlanItem = { author: number; age: number; words: number; quoteWords: number; genWords: number; relation: Relation; target: number; mentions: number; twin: boolean; bare: boolean; second: number };
type Plan = { background: boolean[]; frequency: 'hourly' | 'daily' | 'weekly'; items: PlanItem[] };

const item = fc.record({
  // Age in hours before the edition is written: exactly 24 is outside the window, and -1 (a clock ahead of ours) is too.
  // 167 and 168 are a weekly window's edges.
  author: fc.integer({ min: -1, max: 2 }), age: fc.constantFrom(-1, 0, 1, 12, 23, 24, 25, 48, 167, 168),
  words: fc.constantFrom(0, 120, 299, 300, 480), quoteWords: fc.constantFrom(0, 400), genWords: fc.constantFrom(0, 400),
  relation: fc.constantFrom(...relations), target: fc.integer({ min: 0, max: 12 }), mentions: fc.integer({ min: -1, max: 9 }),
  // twin: the item reuses the previous item's id on another blyg; bare: it names its target's origin without a trailing slash.
  twin: fc.boolean(), bare: fc.boolean(),
  // A second link, as a real item often has several: an earlier item, one nobody holds, or none (-1).
  second: fc.integer({ min: -1, max: 12 }),
});

// What can legally exist, from the plan alone. Shared by the model and the driver.
type Resolved = { index: number; id: number; own: boolean; blyg: number; age: number; words: number; quoteWords: number; genWords: number; relation: Relation; target: number | null; ghost: number | null; mentions: number | null; bare: boolean; second: { target: number | null; ghost: number | null } };
function resolve(plan: Plan): Resolved[] {
  const out: Resolved[] = [];
  plan.items.forEach((p, index) => {
    // At most one own item: own items are published now, seconds apart, so two would tie on a clock the plan cannot see.
    const own = p.author < 0 && !out.some((r) => r.own);
    const blyg = own ? -1 : Math.max(p.author, 0) % plan.background.length;
    // A twin shares the previous imported item's id, on a blyg that does not already hold that id.
    const before = out[index - 1];
    const id = !own && p.twin && before && !before.own && !out.some((o) => o.id === before.id && o.blyg === blyg) ? before.id : index;
    const shared = (r: Resolved) => r.id !== r.index || out.some((o) => o.id === r.index && o.index !== r.index);
    const held = p.target < index;
    // An own item can point only at a held imported item whose id no other blyg shares; publishing refuses anything else.
    const target = held && !(own && (out[p.target]!.own || p.relation === 'fork' || shared(out[p.target]!))) ? p.target : null;
    const relation: Relation = own && target === null ? 'none' : own && p.relation === 'fork' ? 'none' : p.relation;
    const ghost = relation !== 'none' && target === null ? p.target : null;
    // A verified mention: an imported item names an own item (as a fork or a TK source would, which no other edge records).
    const mentions = !own && p.mentions >= 0 && p.mentions < index && out[p.mentions]!.own ? p.mentions : null;
    // An own item's second link must resolve too; an imported one may name anything.
    const secondHeld = p.second >= 0 && p.second < index && !(own && (out[p.second]!.own || shared(out[p.second]!)));
    const second = p.second < 0 || (own && !secondHeld) ? { target: null, ghost: null } : secondHeld ? { target: p.second, ghost: null } : { target: null, ghost: p.second };
    // An own item is published during seeding, under a minute before the edition: after every imported item but one of age 0.
    out.push({ index, id, own, blyg, age: own ? 0.01 : p.age, words: p.words, quoteWords: p.quoteWords, genWords: p.genWords, relation, target, ghost, mentions, bare: p.bare, second });
  });
  return out;
}
const label = (r: Resolved) => `${r.own ? 'own' : 'item'}-${r.index}`;
// Ids in the real alphabet (src/identity.ts), or `[[id]]` is not a link at all; padded so their order is the plan's.
const remoteId = (r: Resolved) => `dg${String(r.id).padStart(24, '0')}`;
const ghostId = (n: number) => `gh${String(n).padStart(24, '0')}`;

type Section = { title: string; kind: string; entries: { item: string; group: string | null }[] };
type Expected = { sections: Section[]; states: string[] };

function model(plan: Plan): Expected {
  const items = resolve(plan);
  // The window follows the frequency: a day, or a week for a weekly edition.
  const hours = plan.frequency === 'weekly' ? 168 : 24;
  const inWindow = (r: Resolved) => r.age >= 0 && r.age < hours;
  // Ties fall to the item id, then its blyg (the subscription's id).
  const byId = (a: Resolved, b: Resolved) => a.id - b.id || a.blyg - b.blyg;
  // The link graph: an item is a node, and so is every item it points at.
  const parent = new Map<string, string>();
  const find = (k: string): string => { const p = parent.get(k) ?? k; if (p === k) return k; const root = find(p); parent.set(k, root); return root; };
  const join = (a: string, b: string) => { const x = find(a), y = find(b); if (x !== y) parent.set(x < y ? y : x, x < y ? x : y); };
  const node = (r: Resolved) => `held:${r.blyg}:${r.id}`;
  for (const r of items) {
    parent.set(node(r), find(node(r)));
    if (r.relation === 'none' || r.relation === 'fork') continue;
    if (r.target !== null) join(node(r), node(items[r.target]!));
    if (r.ghost !== null) join(node(r), `ghost:${r.ghost}`);
  }
  for (const r of items) {
    if (r.second.target !== null) join(node(r), node(items[r.second.target]!));
    if (r.second.ghost !== null) join(node(r), `ghost:${r.second.ghost}`);
  }
  for (const r of items) if (r.mentions !== null) join(node(r), node(items[r.mentions]!));
  const components = new Map<string, Resolved[]>();
  for (const r of items) components.set(find(node(r)), [...(components.get(find(node(r))) ?? []), r]);
  const author = (r: Resolved) => (r.own ? 'own' : `blyg-${r.blyg}`);
  const created = (r: Resolved) => -r.age;
  const qualifying = [...components.values()].filter((members) => new Set(members.map(author)).size >= 2 && members.some(inWindow)).length;
  const conversations = [...components.values()]
    .filter((members) => new Set(members.map(author)).size >= 2 && members.some(inWindow))
    .map((members) => ({ members, fresh: members.filter(inWindow).length, newest: Math.max(...members.map(created)), first: [...members].sort(byId)[0]! }))
    .sort((a, b) => b.fresh - a.fresh || b.newest - a.newest || byId(a.first, b.first))
    .slice(0, 5);
  const claimed = new Set(conversations.flatMap((c) => c.members.map((m) => m.index)));
  const own = (r: Resolved) => r.words;
  const candidates = items.filter((r) => !r.own && !plan.background[r.blyg] && inWindow(r) && own(r) >= 300 && r.relation !== 'stub' && r.relation !== 'fork');
  const highlights = candidates.filter((r) => !claimed.has(r.index))
    .sort((a, b) => own(b) - own(a) || created(b) - created(a) || byId(a, b)).slice(0, 7);
  const sections: Section[] = [];
  if (highlights.length) sections.push({ title: 'Highlights', kind: 'lead', entries: highlights.map((r) => ({ item: label(r), group: null })) });
  if (conversations.length) {
    sections.push({
      title: 'Happening conversations', kind: 'section',
      entries: conversations.flatMap((c, n) => [...c.members].sort((a, b) => created(a) - created(b) || byId(a, b)).slice(-6).map((r) => ({ item: label(r), group: `conversation-${n + 1}` }))),
    });
  }
  const states = [
    ...(highlights.length ? ['highlights'] : []),
    ...(conversations.length ? ['conversations'] : []),
    ...(!sections.length ? ['quiet'] : []),
    ...(candidates.some((r) => claimed.has(r.index)) ? ['conversation wins'] : []),
    ...(items.some((r) => !r.own && plan.background[r.blyg] && inWindow(r) && r.words >= 300 && r.relation !== 'stub' && r.relation !== 'fork') ? ['background excluded'] : []),
    ...(items.some((r) => !r.own && inWindow(r) && r.words < 300 && r.words + r.quoteWords + r.genWords >= 300) ? ['borrowed words'] : []),
    ...(candidates.filter((r) => !claimed.has(r.index)).length > 7 ? ['over cap'] : []),
    ...(conversations.some((c) => c.members.every((m) => m.relation !== 'none' && m.target === null && m.ghost !== null)) ? ['joined by an item nobody holds'] : []),
    ...(conversations.some((c) => c.members.some((m) => m.mentions !== null)) ? ['joined by a mention'] : []),
    ...(items.some((r) => !r.own && (r.age === hours || r.age < 0)) ? ['window edge'] : []),
    ...(plan.frequency === 'weekly' && items.some((r) => !r.own && r.age > 24 && r.age < 168) ? ['weekly window'] : []),
    ...(items.some((r) => r.id !== r.index) ? ['shared id'] : []),
    ...(qualifying > 5 ? ['more conversations than shown'] : []),
  ];
  return { sections, states };
}

const blyg = (b: number) => ({ sub: `digest-sub-${b}`, origin: `https://b${b}.digest.test/` });
const words = (n: number, stem: string) => Array.from({ length: n }, (_, i) => `${stem}${i}`).join(' ');

async function seed(plan: Plan, now: number) {
  const items = resolve(plan);
  const cookie = await login();
  const api = (method: string, path: string, body?: unknown) => apiJson(cookie, method, '/blyg/api' + path, body);
  for (const [b, background] of plan.background.entries()) {
    await env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,created,background) VALUES(?,'blyg',?,?,?,'2026-01-01',?)")
      .bind(blyg(b).sub, blyg(b).origin, blyg(b).origin + 'feed.xml', `Blyg ${b}`, background ? 1 : 0).run();
  }
  const ids = new Map<number, string>();
  const bare = (r: Resolved, origin: string) => (r.bare ? origin.replace(/\/$/, '') : origin);
  const at2 = (r: Resolved) => (r.second.target !== null ? { origin: bare(r, items[r.second.target]!.own ? OWN_ORIGIN : blyg(items[r.second.target]!.blyg).origin), id: ids.get(r.second.target)! } : r.second.ghost !== null ? { origin: bare(r, GHOST), id: ghostId(r.second.ghost) } : null);
  const pointer = (r: Resolved) => (r.target !== null ? { origin: bare(r, items[r.target]!.own ? OWN_ORIGIN : blyg(items[r.target]!.blyg).origin), id: ids.get(r.target)! } : { origin: bare(r, GHOST), id: ghostId(r.ghost!) });
  for (const r of items) {
    if (r.own) {
      const target = r.target !== null ? ids.get(r.target)! : null;
      const sub = r.target !== null ? blyg(items[r.target]!.blyg).sub : null;
      const created = r.relation === 'stub' && sub
        ? await api('POST', '/items', { mode: 'response', source: { subscriptionId: sub, remoteId: target } })
        // An own item is never a highlight, so its length does not matter (and a fragment holds at most 1,000 characters).
        : await api('POST', '/items', { kind: r.relation === 'quote' ? 'thread' : 'fragment', contentMd: (r.relation === 'quote' ? `${words(12, 'o')}\n\n![[${target}]]` : r.relation === 'link' ? `${words(12, 'o')} [[${target}]]` : words(12, 'o')) + (at2(r) ? ` and [[${at2(r)!.id}]]` : '') });
      if (created.status !== 201) throw new Error(`agentic digest: could not create own item ${r.index}: ${created.status} ${JSON.stringify(created.json)}`);
      if (r.relation === 'stub' && at2(r)) {
        const edited = await api('PATCH', `/items/${created.json.id}`, { contentMd: `${created.json.contentMd ?? ''}\n\nAnd [[${at2(r)!.id}]].`, expectedRevision: created.json.revision });
        if (edited.status !== 200) throw new Error(`agentic digest: could not add a link to own stub ${r.index}: ${edited.status} ${JSON.stringify(edited.json)}`);
      }
      const published = await api('POST', `/items/${created.json.id}/publish`, { visibility: 'public' });
      if (published.status !== 200) throw new Error(`agentic digest: could not publish own item ${r.index}: ${published.status} ${JSON.stringify(published.json)}`);
      ids.set(r.index, created.json.id as string);
      continue;
    }
    const id = remoteId(r);
    ids.set(r.index, id);
    const quote = r.quoteWords || r.relation === 'quote'
      ? `<blockquote class="blyg-transclusion" data-blyg-id="${r.relation === 'quote' ? pointer(r).id : 'elsewhere'}" data-blyg-origin="${r.relation === 'quote' ? pointer(r).origin : GHOST}" data-blyg-version="1"><p>${words(Math.max(r.quoteWords, 1), 'q')}</p></blockquote>` : '';
    const generated = r.genWords ? `<p><span class="blyg-tk-gen">${words(r.genWords, 'g')}</span></p>` : '';
    // An entity, a line break and a comment to self, none of which changes the count of own words.
    const own = words(r.words, 'w').replace(/^w0/, 'w&amp;0').replace(/ w1 /, ' w1<br>');
    const html = `<p>${own}</p><!-- two words -->${quote}${generated}`;
    const at = new Date(now - r.age * HOUR).toISOString();
    const doc = JSON.parse(await itemDocBody({ id, kind: r.relation === 'stub' || r.relation === 'quote' ? 'thread' : 'fragment', version: 1, created: at, updated: at, origin: blyg(r.blyg).origin, content_md: words(r.words, 'w'), content_html: html }));
    if (r.relation === 'stub') doc.stub_of = { ...pointer(r), version: 1 };
    if (r.relation === 'fork') doc.forked_from = { ...pointer(r), version: 1 };
    if (r.relation === 'quote') doc.transclusions = [{ ...pointer(r), version: 1 }];
    doc.links = [...(r.relation === 'link' ? [pointer(r)] : []), ...(at2(r) ? [at2(r)!] : [])];
    await applyEffect(env.DB, blyg(r.blyg).sub, id, transition({ local: { status: 'absent' }, doc }).effect, at);
  }
  for (const r of items) {
    if (r.mentions === null) continue;
    const source = `${blyg(r.blyg).origin}items/${ids.get(r.index)}`;
    const claim = await upsertInbound(env.DB, source, `${OWN_ORIGIN}items/${ids.get(r.mentions)}`, ids.get(r.mentions)!);
    await markInboundVerified(env.DB, claim.id, { relation: 'fork', sourceOrigin: blyg(r.blyg).origin, sourceId: ids.get(r.index)!, sourceKind: 'fragment', sourceVersion: 1, authorJson: null, sourcePage: source });
  }
  // Labels by subscription and id: twins share an id.
  const subOf = (r: Resolved) => (r.own ? '~own' : blyg(r.blyg).sub);
  return { api, labels: new Map([...ids].map(([index, id]) => [`${subOf(items[index]!)}|${id}`, label(items[index]!)])) };
}

const histories = {
  arbitrary: fc.record({ background: fc.array(fc.boolean(), { minLength: 1, maxLength: 3 }), frequency: fc.constantFrom('hourly' as const, 'daily' as const, 'weekly' as const), items: fc.array(item, { maxLength: 12 }) }),
  runs: 25, fixedSeeds: [20261127],
  states: ['weekly window', 'highlights', 'conversations', 'quiet', 'conversation wins', 'background excluded', 'borrowed words', 'over cap', 'joined by an item nobody holds', 'joined by a mention', 'window edge', 'shared id', 'more conversations than shown'],
  constructed: [
    { name: 'a quiet day', build: (): Plan => ({ frequency: 'daily', background: [false], items: [{ author: 0, age: 48, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }] }), enters: ['quiet'] },
    {
      name: 'a long post that started a conversation', enters: ['highlights', 'conversations', 'conversation wins'],
      build: (): Plan => ({ frequency: 'daily', background: [false, false], items: [
        { author: 0, age: 12, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 },
        { author: 1, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 0, mentions: -1, twin: false, bare: false, second: -1 },
        { author: 1, age: 23, words: 300, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 },
      ] }),
    },
    {
      name: 'borrowed words and a blyg in Background', enters: ['background excluded', 'borrowed words', 'quiet'],
      build: (): Plan => ({ frequency: 'daily', background: [false, true], items: [
        { author: 0, age: 1, words: 120, quoteWords: 400, genWords: 400, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 },
        { author: 1, age: 1, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 },
      ] }),
    },
    {
      name: 'eight long posts', enters: ['highlights', 'over cap'],
      build: (): Plan => ({ frequency: 'daily', background: [false, false], items: Array.from({ length: 8 }, (_, i) => ({ author: i % 2, age: i % 2 ? 1 : 12, words: i < 4 ? 480 : 300, quoteWords: 0, genWords: 0, relation: 'none' as const, target: 12, mentions: -1, twin: false, bare: false, second: -1 })) }),
    },
    {
      name: 'two blygs quoting a post nobody here holds', enters: ['conversations', 'joined by an item nobody holds'],
      build: (): Plan => ({ frequency: 'daily', background: [false, false], items: [
        { author: 0, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'quote', target: 11, mentions: -1, twin: false, bare: false, second: -1 },
        { author: 1, age: 25, words: 120, quoteWords: 0, genWords: 0, relation: 'link', target: 11, mentions: -1, twin: false, bare: false, second: -1 },
      ] }),
    },
    {
      name: 'a weekly window', enters: ['highlights', 'weekly window', 'window edge'],
      build: (): Plan => ({ frequency: 'weekly', background: [false], items: [{ author: 0, age: 25, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 167, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 168, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }] }),
    },
    {
      name: 'the window edges', enters: ['highlights', 'window edge'],
      build: (): Plan => ({ frequency: 'daily', background: [false], items: [{ author: 0, age: 24, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: -1, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 23, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }] }),
    },
    {
      // The twin is on the lower blyg, so the order the tie owes is not the order they arrived in.
      name: 'a shared id', enters: ['highlights', 'shared id'],
      build: (): Plan => ({ frequency: 'daily', background: [false, false], items: [{ author: 1, age: 12, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 12, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: true, bare: false, second: -1 }] }),
    },
    {
      name: 'two conversations as active as each other', enters: ['conversations'],
      build: (): Plan => ({ frequency: 'daily', background: [false, false], items: [
        { author: 0, age: 12, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 12, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 0, mentions: -1, twin: false, bare: true, second: -1 },
        { author: 0, age: 23, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 48, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 2, mentions: -1, twin: false, bare: false, second: -1 },
        { author: 0, age: 23, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 25, words: 120, quoteWords: 0, genWords: 0, relation: 'link', target: 4, mentions: -1, twin: false, bare: false, second: -1 },
      ] }),
    },
    {
      name: 'six conversations', enters: ['conversations', 'more conversations than shown'],
      build: (): Plan => ({ frequency: 'daily', background: [false, false], items: [{ author: 0, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 0, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 12, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 12, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 2, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 23, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 23, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 4, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 0, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 0, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 6, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 8, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 12, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 12, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 10, mentions: -1, twin: false, bare: false, second: -1 }] }),
    },
    {
      name: 'more active but older', enters: ['conversations'],
      build: (): Plan => ({ frequency: 'daily', background: [false, false], items: [{ author: 0, age: 23, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 23, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 0, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 48, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 2, mentions: -1, twin: false, bare: false, second: -1 }] }),
    },
    {
      name: 'a long stub of a post nobody holds', enters: ['quiet'],
      build: (): Plan => ({ frequency: 'daily', background: [false], items: [{ author: 0, age: 1, words: 480, quoteWords: 0, genWords: 0, relation: 'stub', target: 11, mentions: -1, twin: false, bare: false, second: -1 }] }),
    },
    {
      // The walk starts at the first item, so the post with two links is reached from its far side.
      name: 'a post with two links', enters: ['conversations'],
      build: (): Plan => ({ frequency: 'daily', background: [false, false, false], items: [{ author: 2, age: 48, words: 120, quoteWords: 0, genWords: 0, relation: 'quote', target: 11, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 48, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'link', target: 1, mentions: -1, twin: false, bare: false, second: 11 }] }),
    },
    {
      // Three blygs hold the same id, arriving in neither their order nor its reverse, so a tie broken either way round shows.
      name: 'one id on three blygs', enters: ['highlights', 'shared id'],
      build: (): Plan => ({ frequency: 'daily', background: [false, false, false], items: [{ author: 1, age: 12, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 12, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: true, bare: false, second: -1 }, { author: 2, age: 12, words: 480, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: true, bare: false, second: -1 }] }),
    },
    {
      // Equally active and equally new: the tie falls to each conversation's first item by id, then blyg, not to arrival.
      name: 'two conversations tied to the id', enters: ['conversations', 'shared id'],
      build: (): Plan => ({ frequency: 'daily', background: [false, false], items: [{ author: 1, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 }, { author: 0, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: true, bare: false, second: -1 }, { author: 0, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 0, mentions: -1, twin: false, bare: false, second: -1 }, { author: 1, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'stub', target: 1, mentions: -1, twin: false, bare: false, second: -1 }] }),
    },
    {
      name: 'a fork of your post, known by its mention', enters: ['conversations', 'joined by a mention'],
      build: (): Plan => ({ frequency: 'daily', background: [false], items: [
        { author: -1, age: 1, words: 120, quoteWords: 0, genWords: 0, relation: 'none', target: 12, mentions: -1, twin: false, bare: false, second: -1 },
        { author: 0, age: 1, words: 480, quoteWords: 0, genWords: 0, relation: 'fork', target: 0, mentions: 0, twin: false, bare: false, second: -1 },
      ] }),
    },
  ],
};

function check(_plan: Plan, trace: readonly Observation[], expected: Expected) {
  const errors = trace.filter((entry) => entry.checkpoint === 'production error').map((entry) => entry.value);
  if (errors.length) return differs('production error', LAW, errors, []) ?? pass;
  const stamps = trace.filter((entry) => entry.checkpoint === 'written at').map((entry) => entry.value);
  if (stamps.some((stamp) => stamp !== true)) return differs('written at', LAW, stamps, stamps.map(() => true)) ?? pass;
  const edition = trace.find((entry) => entry.checkpoint === 'edition');
  if (!edition) return differs('edition', LAW, trace.map((entry) => entry.checkpoint), ['edition']) ?? pass;
  for (const written of trace.filter((entry) => entry.checkpoint === 'as written')) {
    const bad = differs('as written', LAW, written.value, expected.sections);
    if (bad) return bad;
  }
  return differs('rewritten', LAW, trace.find((entry) => entry.checkpoint === 'rewritten')?.value, false)
    ?? differs('edition', LAW, edition.value, expected.sections)
    ?? differs('same edition again', LAW, trace.find((entry) => entry.checkpoint === 'same edition again')?.value, expected.sections)
    ?? pass;
}

oracleProperty({
  id: 'agentic-digest', owns: ['src/agentic-digest.ts', 'src/fork-flatten.ts#ownWordCount'],
  law: { statement: 'For every held reading and edition window, Highlights holds the new, long, non-response items from followed blygs outside Background that no listed conversation claims, longest first, at most 7; Happening conversations holds each linked set of held items with two or more authors and a new item, most active first, at most 5; no item is in both, empty sections are absent, the same data gives the same edition, and an unchanged edition is not written again.', authority: 'Decision by Venkat Rao (GitHub vgururao), 2026-11-27: blygger-spec docs/agentic-digest-plan.md §8, laws 1, 2 and 5, approved as written.', limits: 'The window is a day, or a week for a weekly edition. At most three blygs, twelve items and one own item (always new, public, pointing at one held item); blyg subscriptions only; laws 3 and 4 and the edition clock are not here.' },
  histories, model, check,
  // Each history seeds through the real importer and owner API (a second or more), so shrinking a failure is capped at 15 s.
  timeout: 30_000,
  reached: (plan: Plan) => model(plan).states,
  driver: async (plan: Plan, observe) => {
    await withOracleStorage(async () => {
      // The edition is written a minute after seeding starts: own items are published in between, and imported ones sit at exact ages.
      const written = Math.floor((Date.now() + 60_000) / 1000) * 1000;
      const { api: owner, labels } = await seed(plan, written);
      // A response that breaks the published contract is production's error, recorded for the check.
      const api = async (method: string, path: string, body?: unknown) => {
        try { return await owner(method, path, body); } catch (error) { observe('production error', error instanceof Error ? error.message.slice(0, 200) : String(error)); return { status: 0, json: null }; }
      };
      const frequency = await api('PATCH', '/settings', { agenticFrequency: plan.frequency });
      if (frequency.status !== 200) throw new Error(`agentic digest: could not set the frequency: ${frequency.status}`);
      const read = async () => {
        const edition = await api('GET', '/agentic/default');
        if (edition.status !== 200) return { status: edition.status, body: edition.json };
        observe('written at', edition.json.layout?.generatedAt === new Date(written).toISOString());
        // The edition as the assistant stored it, before the layout drops repeats and empty sections: law 5 holds there too.
        observe('as written', (edition.json.edition?.sections ?? []).filter((s: { entries: unknown[] }) => s.entries.length).map((s: { title: string; kind?: string; entries: { sub: string; remoteId: string; group?: string }[] }) => ({
          title: s.title, kind: s.kind ?? 'section', entries: s.entries.map((e) => ({ item: labels.get(`${e.sub}|${e.remoteId}`) ?? e.remoteId, group: e.group ?? null })),
        })));
        return (edition.json.layout?.sections ?? []).map((s: { title: string; kind: string; entries: { sub: string; remoteId: string; group?: string }[] }) => ({
          title: s.title, kind: s.kind, entries: s.entries.map((e) => ({ item: labels.get(`${e.sub}|${e.remoteId}`) ?? e.remoteId, group: e.group ?? null })),
        }));
      };
      const write = async () => {
        try { await writeResidentDigest(env.DB, written, OWN_ORIGIN); } catch (error) { observe('production error', error instanceof Error ? `${error.name}: ${error.message}` : String(error)); }
      };
      const revision = async () => (await api('GET', '/agentic/default')).json?.revision as number;
      await write();
      observe('edition', await read());
      const first = await revision();
      await write();
      observe('same edition again', await read());
      // Law 5: an unchanged edition is not written again.
      observe('rewritten', (await revision()) !== first);
    });
  },
  calibrations: [
    { name: 'an unchanged edition written again', law: LAW, history: { constructed: 'a quiet day' }, corrupt: (trace) => trace.map((entry) => entry.checkpoint === 'rewritten' ? { ...entry, value: true } : entry) },
    { name: 'a conversation item also listed as a highlight', law: LAW, history: { constructed: 'a long post that started a conversation' }, corrupt: (trace) => trace.map((entry) => entry.checkpoint === 'edition' ? { ...entry, value: [{ title: 'Highlights', kind: 'lead', entries: [{ item: 'item-0', group: null }, { item: 'item-2', group: null }] }, ...(entry.value as Section[]).slice(1)] } : entry) },
  ],
});
