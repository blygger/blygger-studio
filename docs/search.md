# Search on the reading and compose pages

**Status: first version built** (session 59, 2026-11-04, Opus 5.5 with Venkat;
decisions 1–3 below taken as recommended). Two simplifications from the design:
the search box sits in its own row at the top of the reading page rather than
inside `ReadingHead`, and on the compose page the status filter row is hidden
while a search is open rather than disabled.
Studio only: nothing reaches the wire, so it needs no Fable round (decision #58's
four-question test is no on 1–3).

Venkat: a quick search on the reading page and the compose page, the same as the
search the `[[` / `![[` picker runs, with the same scope on the reading page and
an extra *this blyg only* filter on the compose page.

## What exists

The picker already has the search. `GET {mount}/api/search` (`searchOperation`
in `src/read-api.ts`) matches every word (up to 8) anywhere in an item's
`content_md` or id, case-folded with `instr`, never `LIKE` (D1 caps patterns at
50 bytes). Its scope is deliberately what `resolveTarget` accepts at publish:
own **published** items of both kinds, plus imported blyg items that are current
or keep a pinned version (no L0 rows). It already takes `source=all|mine|imported`,
`sub` (one subscription), `sort=newest|oldest` and a cursor, and it returns
`excerpt`, `label`, `kind`, `source`, `sourceTitle`, `subscriptionId`. So
**`source=mine` is already "this blyg only"**. The picker UI (`src/ui/picker.tsx`)
holds the query box, the source radio, the sort select, the subscription select
and the paged result list.

So the feature is mostly UI. One route change may be wanted (decision 1).

## Design

**One shared search component.** Lift the picker's search box, filters, paged
query (`BlyggerApi.search` through the same window and validation) and hit row
into `src/ui/search.tsx`: a `useSearch(filters)` hook and a `SearchResults`
list taking an `onPick(hit)` callback. The picker keeps its panel, bracket
header and insert-on-pick. The reading and compose pages use the same list with
their own `onPick`. One query, one result shape, three surfaces, so the scopes
cannot drift apart. That is the reason the route has one name today.

**Reading page.**
- A search box in `ReadingHead`, beside the feed/sources tabs. `/` focuses it;
  Escape clears it.
- The query goes in the URL as `?q=` (added to `readingSearch` in `app.tsx`), so
  back returns to the results and a search can be bookmarked. While `q` is set,
  the results replace the timeline; clearing it restores the timeline at its
  offset.
- Scope: the picker's, `source=all`. If a single subscription is selected in the
  sidebar, the search starts narrowed to it (`sub`), with a chip to widen it to
  everything. A hopper, a lens or Background does not narrow it: those are
  views of the feed, and the route has no such filter.
- Picking a hit opens it in the reader: `/reading/{subscriptionId}/{id}`, or
  `/reading/~own/{id}` for your own items. That route already serves both.

**Compose page.**
- A search box above the item list, beside the all / drafts / changes / public /
  withdrawn filter row, with the `?q=` in the URL as on the reading page.
- Source control: **this blyg only** / **everything**. *This blyg only* sends
  `source=mine`; *everything* is the reading page's scope.
- While `q` is set, the results replace the item list. Picking your own item
  opens its editor (`/edit/{id}`); picking an imported one opens it in the
  reader.
- The status filter row applies to your own items only, so it is disabled
  while searching *everything*.

**Shared behaviour.** Requests are debounced (250 ms) and sent only for two or
more characters, or for any query once Enter is pressed. Each hit row shows the
excerpt and `source · kind · age · vN`, with the matched words marked in the
excerpt client-side. The `source` and `sort` choices are remembered per surface
in localStorage, as the picker's already are.

## Decisions for Venkat

1. **Drafts in the compose search.** The route returns only *published* own
   items, because it mirrors what a quote or link can name. That is right for
   the picker and for reading. On the compose page, finding your own drafts is
   probably the main use. Recommended: an opt-in `include=drafts` parameter that
   adds own drafts and unpublished changes, matching the working copy.
   *This blyg only* on the compose page sends it; the picker never does, so the
   picker keeps its invariant. The alternative is to ship without drafts and add
   them later.
2. **The compose page's default scope.** Recommended: *this blyg only*, since the
   list the search replaces is your own items.
3. **Narrowing on the reading page.** Should a selected subscription narrow the
   search (recommended), or should search always cover everything?

## Cost

Each search reads every candidate row: `instr` cannot use an index. #113 is the
reminder that free-plan D1 counts rows read. Debouncing and the two-character
minimum keep this to one query per pause in typing. If it ever matters, FTS5 is
the upgrade the route's comment already names, and it would serve all three
surfaces at once. Not for now.

## Tests

- Unit: `useSearch` sends the filters each surface asks for (`source`, `sub`,
  `include`).
- e2e:
  - reading `?q=` shows hits and back returns to them;
  - a selected subscription narrows the search, and the chip widens it;
  - compose *this blyg only* excludes imported items, and *everything*
    includes them;
  - picking an own hit on compose opens its editor;
  - with decision 1, a draft is found on compose and never in the picker.
