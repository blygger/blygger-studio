/** Independent reference for the polling/cache contract in
 * docs/d1-polling-cache-design.md. No production dependency classifier, cursor
 * reducer, SQL trigger or renderer is imported to predict an answer.
 *
 * Source facts, applied data and saved artifacts are distinct: a later load,
 * failed acknowledgment, or competing publication distinguishes each pair.
 * Epoch distinguishes restored counter reuse. Time is separate because passing
 * a deadline changes scheduled work without changing source revisions.
 * Histories can serve any saved legal snapshot; SWR promises no maximum age.
 * A successful publisher cannot lower generation within the same epoch.
 */
export const oracleDomains = ['items', 'reading', 'subscriptions', 'hoppers', 'signals', 'settings', 'feed', 'mentions', 'responses', 'interactions', 'browse', 'shelf'] as const;
export type OracleDomain = typeof oracleDomains[number];
export type OracleToken = { epoch: string; domains: Record<OracleDomain, number> };
export function changedDomains(before: OracleToken, after: OracleToken) {
  return oracleDomains.filter(d => before.epoch !== after.epoch || before.domains[d] !== after.domains[d]);
}
/** The query cache owns fetched responses. Collection publication and local
 * overlays are receiving-adapter behavior, not a second application cursor. */
export class StudioQueryReference {
  readonly fetched = new Map<string, { epoch: string; revision: number; value: number }>();
  needsFetch(key: string, source: { epoch: string; revision: number }) {
    const cached = this.fetched.get(key);
    return !cached || cached.epoch !== source.epoch || cached.revision !== source.revision;
  }
  receive(key: string, target: { epoch: string; revision: number }, value: number, source: number) {
    if (target.revision > value) throw new Error('cached token outruns fetched data');
    if (value > source) throw new Error('cached data absent from source');
    this.fetched.set(key, { ...target, value });
  }
}
export type FeedFacts = { title: string; bio: string; body: string };
export class FeedReference {
  history: FeedFacts[] = [];
  readonly generations = new Map<string, FeedFacts>();
  commit(facts: FeedFacts, generation?: { epoch: string; revision: number }) {
    this.history.push({ ...facts });
    if (generation) this.generations.set(`${generation.epoch}:${generation.revision}`, { ...facts });
  }
  at(generation: { epoch: string; revision: number }) { return this.generations.get(`${generation.epoch}:${generation.revision}`); }
  legal(facts: FeedFacts) {
    return this.history.some(s => s.title === facts.title && s.bio === facts.bio && s.body === facts.body);
  }
}
