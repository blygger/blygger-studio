# Pace-layered feed — plan (session 46, 2026-10-11)

Blygger keeps time two ways (blygger.org/overview): **synchronic**, what is new now, and
**diachronic**, how things change. The reverse-chronological home page is the synchronic
view. The pace-layered feed is the diachronic one: items sink at speeds set by how much
they have been pinned, and climb as they are revised. Venkat's ruling (session 46): it is
**core**, the studio's default for fresh installs, and the reference that other clients
are recommended to implement. Further algorithms over the same data are extensions.

## The model

Time is counted in **ticks**: one tick each time a new item enters the feed.

- **Depth.** Every item has a depth; the feed is sorted shallowest first. A new item
  enters at depth 0, and on that tick every other item sinks by its layer's speed.
- **Layers.** An item's layer is `min(5, floor(weight))`, and layer *n* sinks at
  `2^-n` per tick. The six layers take Brand's pace-layer names: fashion, commerce,
  infrastructure, governance, culture, nature. More pins, deeper layer, slower sinking.
- **Weight.** An item's own pinned versions, plus half the weight of each item that
  quotes it in a pinned version, recursively (halved again per hop, out to six hops, so a cycle adds a little and fades).
  A pin on a thread freezes what it quotes, so it is evidence that the quoted item
  matters. The other direction (a thread inheriting from what it quotes) would reward
  quoting popular things, so it does not count.
- **Climbing.** A new version moves the item past the one directly above it, `climbFor`
  times: 1, and 0 for a version the loader judged maintenance — the same text as the
  version before it, or a near-same edit (`src/change-size.ts`; RFC-3 R2, decision #97).
  `climbFor` is also where changelog-driven climbing would go: a classification the
  reader derives itself, or one the owner's own instruction asks for (#96).
- **Bursts.** A thread version and the own items it is the first to name, first published
  within 15 minutes before it, are one publication (§13.7) and take one tick: the thread
  on top, its fragments beneath it in publication order (RFC-3 R3). A withdrawn thread is
  no burst.
- **Withdrawn** items leave the ordering.

In the limit, an item that is heavily pinned barely sinks and climbs with every revision,
so it holds the top: the familiar "pinned post", arrived at rather than declared.

## Wire-only inputs

The reference algorithm reads only what any subscriber can fetch from a blyg's public
files, so a reader's client can compute the diachronic view of someone else's blyg:

| Input | Wire source |
|---|---|
| Item ids, kinds, withdrawal | `archive.json`, item documents |
| Versions, times, notes | item `changelog` |
| Pins | `changelog[].pinned` |
| Who quotes whom, per pinned version | `transclusions` in `items/{id}/v{n}.json` |

The wire does not say *when* a version was pinned, so a pin takes effect from its
version's publication time. Inbound pins from other blygs are not on the wire (mentions
are private), so they stay out of the reference and belong to an extension. Whether a pin
should re-send its mentions, so quoted blygs hear of it, is a §16 question for Fable.

## Code layout

- `src/feeds/types.ts` — the contract: `FeedHistory` in, ordered ids out.
- `src/feeds/pace-layered.ts`, `src/feeds/reverse-chronological.ts` — core algorithms.
- `src/feeds/index.ts` — the registry. Extensions add algorithms here (phase 2).
- `src/feeds/history.ts` — builds a `FeedHistory` from D1.
- `test/fixtures/feeds/*.json` — fixed histories with their expected orderings: the
  conformance suite other clients check themselves against. **Canonical in blygger-spec
  `conformance/feeds/`** (RFC-3 R4); `npm run check:fixtures` (CI only) fails if this copy
  differs.

## Phases

1. **Algorithm** (this release): model, loader, fixtures, the home page honouring a
   `feed_order` setting. Migration marks existing nodes `reverse-chronological` so no
   home page reorders on upgrade; fresh installs get `pace-layered`.
2. **Setting and extension contract**: Settings control with each algorithm's
   description; extensions can register an algorithm; `docs/extensions.md` updated.
3. **Setup wizard**: Identity, Look, Feed, AI, Defaults, Review; each field shows its
   current value and "reset to default"; runs on fresh install, re-runnable from Settings;
   existing installs get a one-time notice instead.

Outside the studio: RFC-3 (blygger-spec `docs/rfcs/rfc-3-pace-layered-order.md`) recommends the
model to other clients, ruled as decision #97; the §16 pin-mention question was ruled as #73.

Only the home page follows the algorithm. RSS, Atom and the archive stay newest-first.
