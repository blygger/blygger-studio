import type { FeedAlgorithm, FeedHistory, FeedVersion } from "./types.ts";

/**
 * The diachronic view (docs/pace-layered-feed.md, session 46). Items sink at a
 * speed set by how much they have been pinned and climb as they are revised,
 * so what keeps mattering stays near the top and what was only new moves on.
 */

/** Brand's pace layers, fastest first. An item's layer is its pin weight, floored. */
export const LAYERS = ["fashion", "commerce", "infrastructure", "governance", "culture", "nature"] as const;

/** Depth gained per tick: each layer down sinks at half the speed of the one above. */
export const sinkSpeed = (layer: number) => 2 ** -layer;

export const layerFor = (weight: number) => Math.min(LAYERS.length - 1, Math.floor(weight));

/**
 * How many items a new version climbs past: one, and none for a version the
 * client judged maintenance (RFC-3 R2, decision #97 — climbing a place is
 * resurfacing in miniature, and §13.2 says SHOULD NOT resurface). This is
 * also where changelog-driven climbing would go: a classification the reader
 * derives itself, from the two versions it holds, or one an owner's own
 * instruction asks for (#96). Never from a note by the client's own accord.
 */
export function climbFor(version: FeedVersion): number {
  return version.maintenance ? 0 : 1;
}

/**
 * How long before a thread version its fragments may have been published and
 * still count as one burst with it (RFC-3 R3, decision #97; spec §13.7's fold).
 * A reference constant, as the reader's burst window is (background-plan.md).
 */
export const BURST_WINDOW_MS = 15 * 60 * 1000;

/**
 * Bursts: a thread version and the own items it is the first to name whose
 * first publication falls within BURST_WINDOW_MS before it. The publisher
 * sends the fragments first and the thread last (§7), so the replay would meet
 * each fragment before knowing it belongs to a burst: they are found here,
 * before it. Keyed by "thread id@version"; members in publication order.
 */
function findBursts(history: FeedHistory, visible: Set<string>): { byThread: Map<string, string[]>; member: Set<string> } {
  const first = new Map(history.items.filter((i) => i.versions.length).map((i) => [i.id, i.versions[0].at]));
  const byThread = new Map<string, string[]>();
  const member = new Set<string>();
  const threadVersions = history.items
    // A withdrawn thread is no entry to fold into: its fragments stand alone.
    .filter((i) => i.kind === "thread" && visible.has(i.id))
    .flatMap((i) => i.versions.map((v) => ({ id: i.id, v })))
    .sort((a, b) => a.v.at.localeCompare(b.v.at));
  for (const { id, v } of threadVersions) {
    const at = Date.parse(v.at);
    const members = v.quotes.filter((q) => {
      const t = first.get(q);
      if (q === id || !t || member.has(q)) return false;
      const ms = Date.parse(t);
      return ms <= at && at - ms <= BURST_WINDOW_MS;
    });
    if (!members.length) continue;
    members.sort((a, b) => first.get(a)!.localeCompare(first.get(b)!));
    for (const m of members) member.add(m);
    byThread.set(`${id}@${v.version}`, members);
  }
  return { byThread, member };
}

/** Hops a pin's weight travels up the quoting tree before it is ignored (it halves each hop). */
export const WEIGHT_HOPS = 6;

/**
 * Pin weight: an item's own pins, plus half the weight of each item that quotes
 * it in a pinned version, plus a quarter of what quotes those, out to
 * WEIGHT_HOPS. A pinned thread freezes what it quotes, so its pin is evidence
 * that the quoted item matters; the other direction would reward quoting
 * popular things and does not count. Counted over walks, so a cycle adds a
 * little and then fades.
 */
export function pinWeights(pins: Map<string, number>, quoters: Map<string, Set<string>>): Map<string, number> {
  let weights = new Map(pins);
  for (let hop = 0; hop < WEIGHT_HOPS; hop++) {
    const next = new Map(pins);
    for (const [quoted, by] of quoters) {
      let inherited = 0;
      for (const quoter of by) inherited += weights.get(quoter) ?? 0;
      next.set(quoted, (next.get(quoted) ?? 0) + inherited / 2);
    }
    weights = next;
  }
  return weights;
}

type Event = { id: string; version: FeedVersion };

export function paceLayeredOrder(history: FeedHistory): string[] {
  const visible = new Set(history.items.filter((item) => !item.withdrawn).map((item) => item.id));
  const bursts = findBursts(history, visible);
  // Replay every publication in time order. Times are to the second, so two
  // items can share one; then the listing order decides (oldest first, as the
  // archive lists them), and an item's own versions stay in sequence.
  const events: Event[] = history.items
    .flatMap((item) => item.versions.map((version) => ({ id: item.id, version })))
    .sort((a, b) => a.version.at.localeCompare(b.version.at));

  const depth = new Map<string, number>();
  const entered = new Map<string, number>();
  let clock = 0;
  const pins = new Map<string, number>();
  const quoters = new Map<string, Set<string>>();
  let layers = new Map<string, number>();
  // Shallowest first; at equal depth, the later entrant is on top.
  const ranked = () => [...depth.keys()].sort((a, b) => depth.get(a)! - depth.get(b)! || entered.get(b)! - entered.get(a)!);

  for (const { id, version } of events) {
    // The wire says which versions are pinned but not when, so a pin counts
    // from its version's publication. A withdrawn item's pins still count:
    // pinned versions are served forever.
    if (version.pinned) {
      pins.set(id, (pins.get(id) ?? 0) + 1);
      for (const quoted of version.quotes) {
        if (quoted === id) continue;
        if (!quoters.has(quoted)) quoters.set(quoted, new Set());
        quoters.get(quoted)!.add(id);
      }
      layers = new Map([...pinWeights(pins, quoters)].map(([key, weight]) => [key, layerFor(weight)]));
    }
    if (!visible.has(id)) continue;
    // A burst's member enters with its thread, not on its own (R3).
    if (!depth.has(id) && bursts.member.has(id)) continue;
    const burst = bursts.byThread.get(`${id}@${version.version}`)?.filter((m) => visible.has(m) && !depth.has(m));
    if (burst?.length) {
      // One tick for the whole burst: everything else sinks once, then the
      // fragments enter in reverse publication order and the thread last, so
      // the later-entrant tie-break puts the thread on top and its fragments
      // beneath it in publication order. A thread already in the order comes
      // back to the top with them: the burst is one publication, and it is the
      // entry.
      for (const [other, d] of depth) if (other !== id) depth.set(other, d + sinkSpeed(layers.get(other) ?? 0));
      for (const m of [...burst].reverse()) {
        depth.set(m, 0);
        entered.set(m, clock++);
      }
      depth.set(id, 0);
      entered.set(id, clock++);
      continue;
    }
    if (!depth.has(id)) {
      // A tick: everything already in the feed sinks, and the newcomer enters on top.
      for (const [other, d] of depth) depth.set(other, d + sinkSpeed(layers.get(other) ?? 0));
      depth.set(id, 0);
      entered.set(id, clock++);
    } else {
      for (let step = climbFor(version); step > 0; step--) {
        const order = ranked();
        const at = order.indexOf(id);
        if (at <= 0) break;
        const above = order[at - 1];
        const own = depth.get(id)!;
        depth.set(id, depth.get(above)!);
        depth.set(above, own);
        // At equal depths the swap changes nothing; the tie-break decides, so
        // make the climber the later entrant.
        if (depth.get(id) === own) entered.set(id, clock++);
      }
    }
  }

  return ranked();
}

export const paceLayered: FeedAlgorithm = {
  id: "pace-layered",
  title: "Pace-layered",
  description:
    "Items sink as new ones arrive, more slowly the more they have been pinned, and climb one place with each new version. What keeps mattering stays near the top.",
  order: paceLayeredOrder,
};
