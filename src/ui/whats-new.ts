/*
 * What's new after an upgrade (session 82): the pure half. The setup
 * walk-through doubles as the post-upgrade cue. Each wizard setting carries the
 * release it joined the walk-through in, and each release may name a few
 * highlights that have no setting. The owner's setupSeenVersion is the newest
 * release they have finished or dismissed; whatever came after it is offered
 * once, as a banner and a walk-through of just the new steps.
 *
 * Adding a setting to the wizard? Tag it in SINCE with the release it ships in.
 * A feature worth a line without a setting goes in HIGHLIGHTS.
 */

/** The release each wizard setting joined the walk-through in. Untagged keys predate this (0.71.0 and earlier). */
export const SINCE: Record<string, string> = {
  defaultVisibility: '0.72.0',
  studioTheme: '0.72.0',
  changelogDisplay: '0.72.0',
  readerOrder: '0.72.0',
  readerMarkRead: '0.72.0',
  readerChangelogDisplay: '0.72.0',
  agenticTitle: '0.72.0',
  aiModelHelpers: '0.72.0',
  aiModelClassify: '0.72.0',
  changeCategoryInNote: '0.72.0',
  hopperFeeds: '0.72.0',
  // The step after Review that opens Discover.
  read: '0.72.0',
};

/** Per release, newest first: what changed for the owner, in a line each. */
export const HIGHLIGHTS: { version: string; items: string[] }[] = [
  {
    version: '0.75.0',
    items: [
      "The built-in digest adds mentions from blygs you don't follow, and newly active blygs to discover, found once a day.",
    ],
  },
  {
    version: '0.74.0',
    items: [
      'The Agentic feed can write itself: choose the built-in digest in Settings → AI, hourly, daily or weekly.',
    ],
  },
  {
    version: '0.72.0',
    items: [
      'Notebook mode: a blyg can be private by default, and an item goes public only when you say so.',
      'Each item’s history lists its private versions, p1, p2, …',
      'Discover shows who writes each blyg.',
      'Setup now covers your mode, your reader, and the newer look and AI settings.',
    ],
  },
];

const parts = (version: string) => version.split('.').map((part) => Number.parseInt(part, 10) || 0);

/** Negative when a is older than b. A blank version is older than every release. */
export function compareVersions(a: string, b: string): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export interface WhatsNew {
  /** Wizard keys (and `read`) added after the seen release. */
  keys: string[];
  /** Highlights of the releases after it, newest first. */
  highlights: { version: string; items: string[] }[];
  /** What setupSeenVersion becomes once this has been shown: never backwards. */
  latest: string;
}

/**
 * What is new since `seen`. A blank `seen` means setup has never finished:
 * the whole walk-through is due, which is not a what's-new, so nothing is
 * returned here. `running` is the studio's own version, so the marker never
 * sits behind the release that showed it.
 */
export function whatsNew(seen: string, running: string, since = SINCE, highlights = HIGHLIGHTS): WhatsNew {
  const versions = [running, ...Object.values(since), ...highlights.map((h) => h.version)];
  const latest = versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b), seen);
  if (!seen) return { keys: [], highlights: [], latest };
  return {
    keys: Object.keys(since).filter((key) => compareVersions(since[key]!, seen) > 0),
    highlights: highlights.filter((h) => compareVersions(h.version, seen) > 0),
    latest,
  };
}
