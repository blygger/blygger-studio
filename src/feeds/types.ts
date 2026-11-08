/**
 * The feed-algorithm contract (docs/pace-layered-feed.md). An algorithm is a
 * pure function from a blyg's publishing history to the order of its home
 * page. Its input holds only what any subscriber can read from the blyg's
 * public files, so the same code can order someone else's blyg too.
 */

/** One `changelog` entry, as an item document publishes it (§6). */
export interface FeedVersion {
  version: number;
  /** Publication time, ISO 8601. */
  at: string;
  note: string | null;
  pinned: boolean;
  /** Own-origin items this version quotes (`transclusions` without an `origin`). */
  quotes: string[];
  /**
   * The client judged this version maintenance: the same text as the version
   * before it (same `content_hash`, #77) or under its near-sameness threshold
   * (#83). Not on the wire — the changelog carries no hash — so the client
   * derives it: from its own versions for its own blyg, at reconciliation for
   * an imported one. Absent means no. RFC-3 R2 (decision #97): it climbs zero.
   */
  maintenance?: boolean;
}

export interface FeedHistoryItem {
  id: string;
  kind: "fragment" | "thread";
  withdrawn: boolean;
  /** Oldest first. A withdrawal endcap is not included. */
  versions: FeedVersion[];
}

export interface FeedHistory {
  /** Oldest first, as the archive lists them. Publication times are to the second, so this breaks ties. */
  items: FeedHistoryItem[];
}

export interface FeedAlgorithm {
  /** Stable key, stored in the `feed_order` setting. */
  id: string;
  title: string;
  /** One or two sentences for Settings and the setup wizard. */
  description: string;
  /** Ids of the items to show, top first. Withdrawn items are left out. */
  order(history: FeedHistory): string[];
}
