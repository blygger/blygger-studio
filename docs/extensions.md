# Studio extensions

Studio is the reference client: it shows each protocol construct in its plainest form, and it stays plain so that other clients do not read its interface as the expected design. Extensions are how an interface experiment runs on a real node without becoming that reference. The first one is the lineage glyph from #35.

Extensions are one of three places a mod can live; [`mods.md`](mods.md) says which to try first and what the Studio will add for a mod. An extension is first-party TypeScript in this repository. An operator compiles it into their build, and the owner turns it on in Settings. With nothing turned on, the Studio is the reference Studio, byte for byte.

> **Extensions from other repositories.** An operator can vendor a browser-only extension that lives in someone else's repository into their own build with `npm run ext:add`, pinned to a full commit and hash-checked by every build. No Studio loads anything at run time, and the program hosts no index of extensions. See [`extension-vendoring.md`](extension-vendoring.md). Everything below describes extensions in this repository, and holds for vendored ones too.

## Extensions in this repository

| Name | What it does |
| --- | --- |
| `bars-example` | A bar above the editor's text box: inserts a mark at the cursor and, with `regions-example` on, shows and hides the held paragraphs in place of the Studio's notice. The template to copy for an editor bar. |
| `example` | Fills each UI slot and does nothing that matters. The template to copy, and what the slot tests enable. |
| `feed-example` | Adds a "Pinned first" home page order: pinned items at the top, most pins first, then the rest newest first. Server only (`feeds.ts`, `server.ts`); the template to copy for a feed order of your own. |
| `inspect` | Adds "inspect" to each reading entry's ⋯ sheet: the record this Studio holds for it, and its JSON. Browser only; shipped in `extensions.json`. |
| `lineage-glyph` | The lineage glyph, hex view and action ring from #35. A glyph in each reading byline counts what a post draws on and what draws on it here. It opens a hex view of one hop of ancestors and descendants, where each corner previews what stub, quote a passage, fork, link post, history and open would make, and a second press runs that action. The actions are the Studio's own (or drafts and navigation through the extension context), so they write through the owner's session like the ⋯ sheet does. Its server routes are owner reads: `GET /api/ext/lineage-glyph/lineage` and `/summaries`. `scripts/lineage-demo.ts` runs a seeded local node with it enabled. |
| `menu-example` | A page with an entry in the main menu, and nothing else. The template to copy for one. |
| `menu-top-example` | A page that asks for the top of the main menu, and shows where it was placed. The template to copy for a page an owner starts from. |
| `reading-time` | An estimated reading time and word count at the end of each reading entry's byline. Browser only; shipped in `extensions.json`. |
| `regions-example` | Holds paragraphs that start with `[held]: #` out of the full editor's text box. The template to copy for keeping generated lines out of the author's way. |
| `spellcheck` | A “spelling” button in an editor bar (composer and full editor) that opens a sheet: a dictionary check against a US English word list (ESDB size 60, served by its owner read `GET /api/ext/spellcheck/words` and checked in the browser), skipping markup, links, ids, code, math and TK instructions, with suggestions, ignore, and add to the blyg's dictionary (`PUT /dictionary/owner`, whose every source it also accepts); and, in the full editor, an AI proofread of the saved draft through the blyg's TK model (`GET /api/ext/spellcheck/proofread`), each fix applied in place. `make-words.ts` regenerates the list. |
| `word-count` | Each reading entry's word count at the end of its byline and beside the character count in the composer (counted in the browser) and the full editor (re-read after each autosave), published and in draft (the working copy as publish would bake it now), and for a thread whose outline links (list items that are just an `[[id]]` link, as a table of contents is written) form a strict tree of your own items (published or draft), the words in the whole document under it. Inline links (navigation, citations) are never followed; transclusions are already in a thread's own count. Its server route is an owner read: `GET /api/ext/word-count/counts`. |

## What an extension can do

| Slot | What it adds | Declared as |
| --- | --- | --- |
| Reading byline | Something at the end of each reading entry's byline, such as a badge or a button | `entryByline` (a component) |
| Reading actions | Rows after the Studio's own in an entry's ⋯ sheet | `entryActions(context)` |
| Draft counter | Something beside the character count, in the composer and the full editor | `draftCounter` (a component) |
| Editor regions | Parts of the full editor's text kept out of its text box: hidden each time the editor opens, read-only when shown | `editorRegions(context)` (see "Editor regions" below) |
| Editor bars | A bar of controls in a row of its own above or below the text box, in the composer and the full editor, that can edit the text. It asks for a row and room; the Studio decides | `editorBar` (see "Editor bars" below) |
| Sheets | A sheet of its own, opened from a reading byline or reading actions | `context.openSheet(render)` |
| A page | A screen at `/studio/ext/<name>`, linked from More | `page` |
| A main-menu entry | Asks for a link to that page in a menu zone: `top` (above the Studio's own tabs), `visible` (among them, where the Studio puts it: above compose) or `hidden` (More). The Studio decides; see "Menu zones" below | `page.mainMenu` (an icon and a `zone`); the label is `page.title` |
| Owner reads | `GET /api/ext/<name>/…` routes, in the documented contract and the SDK | `extensions/<name>/contract.ts` + `server.ts` |
| Feed orders | An order for the public home page, chosen in Settings → home page | `feeds` in `server.ts` (see "Feed orders" below) |

A slot receives a narrow context ([`src/ui/extension-api.ts`](../src/ui/extension-api.ts)):

- `entry`, `id`, `imported`, `url`: the reading entry, as `GET /api/reading` returns it.
- `client`: the SDK client, carrying the owner's session. Extension routes are SDK methods like any other operation.
- `openDraft(body)`, `navigate(location)`, `run(action)`: create-and-edit an item, move within the Studio, and run an action whose error lands in the screen's own error line.
- `showError(error)`: show an error the extension found for itself in that same error line. Pass an `Error` or a message. For news that is not a failure, use `toast`.
- `actions`: the Studio's own handlers for this entry (`stub`, `fork`, `linkPost`, `history`, `open`), present only where the Studio offers them. An extension can present the existing actions differently without reimplementing them.
- `openSheet(render)`: open a sheet that the extension owns, under the entry.

The draft counter slot gets the verbs (`client`, `openDraft`, `navigate`, `run`, `showError`), `text` (as it stands now, saved or not) and, in the full editor, `item`: its `id`, `kind`, `status`, `version` and `revision`. `revision` moves each time autosave reaches the server, so a slot that shows something derived from the working copy re-reads on it. The composer passes no `item`, because its text may have no server copy.

Extensions do not get the router, the query cache, the data collections or any other Studio module. An extension's UI may import only `src/ui/extension-api.ts` (which also re-exports the Studio's `Sheet`, `Button`, `toast` and `confirm`), React, the SDK (`sdk/dist/browser.js`) and files in its own directory. `test-ui/extensions.test.ts` enforces this rule.

Each slot renders inside an error boundary. If an extension throws, that slot renders nothing until the page reloads, and the console names the extension. A throwing `entryActions()` or row handler is caught the same way. The rest of the Studio carries on.

Every failure of an extension goes in the owner's error log (Settings → Errors, kept on the device), under the extension's name and the slot it was filling: what a slot throws, what `run` catches, and what `showError` is given. The first is logged without a banner; the other two show one. An extension that catches its own errors and says nothing leaves no trace, so prefer `run` or `showError` to a silent `catch`. The context a slot receives is built per extension, which is how the log knows whose error it is; do not pass a context to code outside the extension.

## Editor regions

For text an extension writes and the author shouldn't edit by hand, such as navigation a tool regenerates.
`editorRegions({ text, item })` returns ranges of the full text (`start`, `end`, `label`), and the full
editor keeps them out of its text box.

- **The draft is always the whole text.** Autosave, the preview, counts, publish and the server see
  everything; only the text box leaves the regions out. Each edit made there is joined with the regions
  before the draft gets it.
- **Hidden each time the editor opens.** A notice beside the counts ("chapter navigation hidden · show")
  shows them, unless an editor bar has taken that control over ("Editor bars"). Showing is not remembered.
- **Read-only when shown.** An edit that touches a region is refused with a toast. Typing right at a
  region's edge is fine.
- **Where typed text goes:** text typed where a region was cut lands before it. So start a region with
  its own separator (the blank line before it), and text typed at the end of the paragraph above stays in
  that paragraph. Replacing text that surrounds a cut puts the region after the replacement.
- **Fail-safe:** if joining an edit doesn't give back what the box shows, the edit is still saved whole
  and the editor shows the whole text until it is opened again.
- Called on every change: keep it quick and pure. Overlapping regions are merged. A throwing
  extension holds nothing out. The full editor only; the composer and quick edit show everything.
- A text box can't style part of its text, so this hides; it can't dim.

## Editor bars

For controls an extension wants beside the text it works on: insert a citation at the cursor, step
to the next chapter, show the nav it holds out. The Studio's own tool row and counts stay as they are;
bars go in two rows of their own, one above the text box and one below it, in the composer and the
full editor.

```ts
editorBar: { label: 'Book', row: 'above', blocks: 2, replaces: ['regionToggle'], component: BookBar }
```

- **Asking for room:** `row` (`above`, the default, or `below`) and `blocks` (1–4, default 1; a block
  holds about one labelled button) are a request. Each row holds 4 blocks. A row is filled first by
  the bars that asked for it, in compiled order, each taking what it asked for while that fits; a bar
  that doesn't fit tries the other row, then goes to the **bars menu**. A bar gets the blocks it asked
  for or nothing in a row: what it renders past them scrolls inside it. Asking for less is the way to
  a row. `context.bar` says what it asked for, where it went (`above`, `below` or `menu`), and in
  `owns` which Studio controls it replaces (see "Replaceable controls").
- **The bars menu** is the button labelled "bars" at the end of the row above, labelled so it is not
  taken for the item's ⋯. It lists every bar with a switch to hide or
  show it, remembered on this device, and opens a bar that had no room in a sheet. A hidden bar takes
  no room.
- **The context:** `text` (the whole text) and `shown` (what the box shows, without held-out regions),
  `selection()`, `insert(text)` (in place of the selection, caret after), `replace(start, end,
  text)` and `select(start, end)`, all in `shown` offsets. Edits go through the same path as the Studio's own tools, so
  held-out regions, autosave and the preview follow them. `item` in the full editor, as for the draft
  counter. `openSheet(render)`, and the usual verbs.
- **Held-out regions:** in the full editor, while any extension holds text out, `context.regions` has
  their `labels`, whether they are `hidden`, and `show()` / `hide()` (for every extension's regions
  at once). `hide()` also takes the editor out of its fail-safe. A bar may replace the Studio's
  notice for them (`replaces: ['regionToggle']`, see "Replaceable controls").
- **Model text.** A bar that puts model-generated text into a draft MUST disclose it: through the
  Studio's generate endpoint for instructed generation, or as `[TK]impyrt <model>=…[/TK]` for text
  the bar obtained elsewhere (spec §5.7 rule 7, decision #37). Never insert it bare: `insert()` text
  publishes as the author's own, with no `generated[]` entry. The Studio cannot tell, so this is a
  review rule for extensions in this repository and a promise for mods (`mods.md`).
- **Focus view** leaves the bars out, like the Studio's tool row. Focus view is the text and nothing
  else; that is its point.
- Off is invisible: with no bar enabled there is no bar row and no bars menu.

## Editor marks

An editor bar can underline stretches of the text: misspellings, grammar, notes of its own. A text box
can't style part of its text, so the Studio draws the marks in a layer laid exactly over it, with the
same box, font, padding and wrapping, scrolled with it and taking no pointer events. The text is never
changed, and the author types, selects and scrolls as ever.

```ts
context.mark([{ start, end, kind: 'spelling', title: 'not in the dictionary' }], (mark) => openFix(mark));
```

- **A bar's marks replace its earlier ones**; `[]` clears them. Offsets are in `shown`. Make them again
  when the text changes (an effect on `context.shown`); meanwhile the Studio moves each with every
  edit, and drops one the edit touched.
- **Kinds:** `spelling` (a wavy line), `grammar` (a wavy line in another colour), `note` (dotted).
- **Activation:** a click that leaves the caret inside a mark calls the bar's `onActivate` with it.
- **Drawn only while the bar is in a row on screen** and hasn't failed: hidden, in the menu or crashed,
  its marks are gone. Never in focus view, which is the text and nothing else.
- Marks are presentation in the Studio: they reach no draft, version or wire.

## Replaceable controls

A short list of the Studio's own controls that an extension may replace with its own version (ruled
session 76, 2026-11-20, reviewed by Fable the same day). It is not a general override: the Studio
decides by its own rule whether to render its control, and extension markup never goes inside a
built-in one. Entries are added one at a time, when an extension needs one, and each must clear the
bar in [`mods.md`](mods.md#the-bar-a-hook-must-clear).

Every entry keeps the same contract:

- **It still does the job.** A replacement drives the Studio's own state through its context, never
  state of its own, so the built-in and the replacement cannot disagree. Only presentation and
  workflow may differ.
- **One owner.** The first enabled extension in compiled order to claim a control owns it, wherever it
  was placed and whether or not the author hid it. A claim that lost never takes over. The owner is
  told (`owns` in its context) and renders its replacement only then.
- **The built-in comes back.** The Studio renders its own control whenever the owner is not standing in
  for it: off, hidden, in a menu, crashed, or in focus view. The control is never lost.
- **Parity.** A replacement is reachable by keyboard and names what it does, as the control it
  replaces does.

| Control | Replaced from | What the replacement must still do |
|---|---|---|
| `regionToggle` | An editor bar: `editorBar.replaces` | Show and hide the held-out regions through `context.regions` (`show()`, `hide()`, `hidden`), naming them by `labels`. The Studio's notice beside the counts returns while the bar is not in a row on screen. |
| `spellcheck` | An editor bar: `editorBar.replaces` | Find misspellings in the text box's text and mark them (`context.mark`, kind `spelling`), and offer corrections that go in through the context's edit path. While the owner stands in, the Studio turns the browser's own spellcheck off in that text box (`spellcheck="false"`); it is back whenever the bar is not in a row on screen, and in focus view. |

A future entry, for example the TK button, would add a row with its own contract. A TK replacement
would have to generate through the Studio's generate endpoint, so the `generated[]` record stays honest.

## Menu zones

Many extensions may want a place in the main menu, so an extension makes its case and the Studio decides.
What an extension asks for may not be what it gets.

```ts
page: { title: 'Dashboard', mainMenu: { icon: '⌂', zone: 'top' }, component: Page }
```

- **Zones:** `top` holds one page, above reading. `visible` holds one page, at a spot the Studio picks (above
  compose). `hidden` is More and holds any number. A page with no `mainMenu` is in More.
- **No zone** means `visible`, the placement `mainMenu: { icon }` had before zones.
- **Granting:** a zone is filled first by pages that asked for it, then by pages moved down from a full zone above,
  each in compiled order. What doesn't fit moves down a zone. A page gets the zone it asked for or a lower one,
  never a higher one, and at worst lands in More.
- **The page is told** where it landed: its context carries `menu: { asked, zone }`.
- A page in `top` or `visible` leaves More and has no "← more" link.
## What is not offered, on purpose

- **Runtime loading.** No extension is fetched, evaluated or configured by URL at run time. The Studio runs with the owner's session cookie, so any script that runs there can act as the owner: publish, mint tokens, read drafts. Remote code in that session would be a credential-theft surface. Only code compiled into the build runs, and every extension is code the operator chose to compile in, from this repository or vendored at a pinned commit. [Vendoring](extension-vendoring.md) keeps this rule: it copies pinned source into the build on the operator's machine and never loads anything at run time.
- **Writes.** Extension routes are GETs under `/api/ext/<name>/`. The permission model classifies them as `owner:read`, and a route registered with any other method or prefix is refused when the Worker starts. An extension that wants to change something uses the existing contract through `client`, under the same scopes as any client.
- **The wire.** An extension does not reach `blyg.json`, public pages, feeds, `content_html` or mentions. It is studio furniture for one owner. The one exception is order: a feed order may decide the sequence of the home page's cards, and nothing else (session 46; see "Feed orders").
- **Changing the Studio's own controls.** No slot rewrites, hides or annotates a built-in button, row or label, except the controls listed under "Replaceable controls", which an extension may replace whole under that section's contract. #35 needed this (hover previews on `stub ↗`, tips on ⋯ rows), and it was left out because it would make the base UI's markup depend on extension code. That still holds for replaceable controls: the Studio decides by its own rule whether to render its control, and extension markup never goes inside a built-in one.
- **Other screens.** The slots are on the reading view, beside the composer's and full editor's character count, in the editor bar rows above and below the composer's and full editor's text box, and in the full editor's text box (held-out regions), plus an extension's own page. New slots should be added when an extension needs them, not before.

## Writing one

```
extensions/
  catalog.ts              every extension in the repo, and its contract routes
  <name>/
    ui/index.tsx          export const extension: StudioExtension   (required)
    contract.ts           extensionRoute(...) declarations           (optional)
    server.ts             export const server: ServerExtension       (optional)
```

1. Choose a name made of lowercase letters, digits and hyphens. The name is used as the directory, the Settings key and the `/api/ext/<name>/` prefix.
2. Write `ui/index.tsx`. Copy `extensions/example/`, which fills every UI slot and does nothing that matters:

   ```tsx
   import type { StudioExtension } from '../../../src/ui/extension-api.ts';
   export const extension: StudioExtension = {
     name: 'my-thing',
     label: 'My thing',
     description: 'One sentence for Settings.',
     entryByline: ({ context }) => <span className="my-thing">{context.entry.kind}</span>,
     entryActions: (context) => [{ label: 'my thing', onSelect: () => context.openSheet((close) => /* … */ null) }],
   };
   ```

   CSS goes in your own directory, imported from your UI. Prefix your class names with the extension name.

3. If the extension needs data that the base contract does not serve, declare owner reads in `contract.ts` and serve them from `server.ts`:

   ```ts
   // contract.ts
   import { z } from '@hono/zod-openapi';
   import { extensionRoute } from '../../src/extensions/contract.ts';
   export const routes = {
     extMyThingSummary: extensionRoute('my-thing', 'summary', '/summary', z.object({ count: z.number() }), z.object({ id: z.string() })),
   };
   // server.ts
   import type { ServerExtension } from '../../src/extensions/server.ts';
   import { success } from '../../src/operation-types.ts';
   import { routes } from './contract.ts';
   export const server: ServerExtension = {
     name: 'my-thing',
     routes: (router) => router.get(routes.extMyThingSummary, async () => success({ count: 0 })),
   };
   ```

   The operationId is derived (`ext` + the name + the operation, in PascalCase), so it cannot collide with another extension's or the base contract's.

4. Add the extension to `extensions/catalog.ts`: its name in `EXTENSIONS`, and its routes spread into `extensionRoutes`. If it has a server half, add that to `test/fixtures/extensions.server.ts`.
5. Run `npm run sdk:generate` and commit `openapi.json` and `sdk/generated`. Add each new operation to the `owner:read` lists in `test/rest-permissions.oracle.test.ts` and `test/mcp.oracle.test.ts`, and to `test/sdk-operations.test.ts`. The inventory checks fail until you do.
6. Test it: Worker tests for its routes (the Worker suite compiles in every extension, so its routes are live once a test enables it), and a browser spec that enables it with `PATCH /api/settings { "extensions": ["<name>"] }` and turns it off afterwards.

### Feed orders

Blygger keeps time two ways: newest first (synchronic) and pace-layered (diachronic, the default for a fresh install; [`docs/pace-layered-feed.md`](pace-layered-feed.md)). Both are core, in `src/feeds/`. Further orders over the same history are extensions:

```ts
// extensions/<name>/server.ts
export const server: ServerExtension = {
  name: '<name>',
  routes() {},
  feeds: [{ id: '<name>/<order>', title, description, order(history) { return ids; } }],
};
```

- **Input:** a `FeedHistory` (`src/feeds/types.ts`): each item's versions with time, note, pin flag and own-origin quotes, oldest first. It is what any subscriber can read from the blyg's public files, so nothing private reaches an order.
- **Output:** item ids, top first. The core shows published items only, each once, and renders every card itself. An order that returns a draft, a withdrawn item, a repeat or an id that does not exist has that entry dropped. An order cannot add content to a page, only arrange it.
- **Ids are namespaced:** an order's id must start with `<name>/`. One that does not is ignored, so no extension can shadow a core order.
- **Enabling:** the order is offered in Settings → home page while the extension is enabled. If it is disabled later, the stored choice stays and the home page uses the default until it is enabled again.
- **Starting point:** copy `extensions/feed-example/` for the plumbing. To change how items sink and climb, start from `src/feeds/pace-layered.ts`; `test/fixtures/feeds/` holds the histories its tests check, which a copy can reuse.

### Why every extension's routes are in `openapi.json`

The committed contract includes the routes of every extension in the repository, whether or not a given build compiles that extension in. The routes answer 404 on a node that lacks the extension or has not enabled it. The alternative, emitting routes only for compiled-in extensions, would make `openapi.json` and the SDK depend on an operator's local `extensions.local.json`. CI's `sdk:generate` drift check would stop being a function of the repository, and an extension's UI could not typecheck against SDK methods that a given build had left out. With every route committed, the SDK remains the only way the UI talks to `/api`, and the drift check remains deterministic. An extension route is tagged `extension:<name>`, and its description says it may 404.

The same holds for MCP, which serves the contract: an extension's reads are MCP tools under `owner:read`, and they 404 on nodes that have not enabled the extension.

## Enabling one (operators)

Two steps. Both are needed, and both default to off.

1. **Compile it in.** `extensions.json` (committed) lists what every release carries: `inspect` and `reading-time`, the two browser-only extensions with no server half, so a node can try the mechanism with one switch in Settings. Anything with a server half (`lineage-glyph`, any route under `/api/ext/`) is never in it and needs your own build. Put your own list in a gitignored `extensions.local.json` at the repository root, which is merged at build like `models.local.json`:

   ```json
   { "compile": ["lineage-glyph"] }
   ```

   `npm run build` (which also runs before `dev`, `deploy` and `test`) writes the selection to `build/extensions.*.ts`. Without the local file, the build carries what `extensions.json` lists. `"remove": ["reading-time"]` in the local file drops a shipped one. A release download is always built from `extensions.json` alone. `BLYG_EXTENSIONS=a,b` (or `all`) overrides both files for one build. The browser suite uses `all`.

2. **Turn it on.** In **Settings → extensions**, check the extension and save. The card appears only when the build carries at least one extension. The setting is per node (`extensions` in `GET/PATCH /api/settings`, `owner:manage`). Only compiled-in names are accepted, and every extension starts unchecked. If you stop compiling an extension in, its stored setting does nothing. If you compile it in again later, the stored setting turns it back on.

Turning an extension off removes its slots, its page and its routes immediately. Nothing it showed was ever on the wire, so there is nothing to undo.

## Security model, in one place

- The code is in the repository and passes the same review and CI as the rest of the Studio. Nothing loads at run time. A [vendored](extension-vendoring.md) extension is not: its review is the operator's, at the commit they pinned, and the build refuses it if it was edited after vendoring.
- An extension is compiled in only when the operator chooses it, and it runs only on a node whose owner has enabled it.
- Server routes run behind the owner API's middleware: owner session or bearer token, `owner:read` scope, the cross-origin refusal for cookie requests, and the owner and grant work budgets. On top of that, a prefix gate returns 404 when the extension is disabled. These checks are in `test/extensions.test.ts`, and the permission oracles list every extension operation.
- Extension routes are reads only. They are registered under the extension's own prefix, or not at all.
- "Reads only" is a property of an extension's *server routes*, not of its UI. In the browser an extension gets the SDK client carrying the owner's session, so its code can call any owner operation, writes included: publish, discard, mint tokens. Nothing at run time stops it. What makes that acceptable is the first two points: an extension is reviewed code the operator chose to compile in. Review an extension's UI as you would any Studio screen that writes.
- An extension's UI sees a narrow context and imports only the extension surface. Any URL an extension takes from someone else's document and turns into an `href` must pass `isFollowableUrl` (http, https or mailto), the same rule the Studio applies. Lineage-glyph does this on its server.

Server read handlers receive `(context, input)`. The context supplies the node
environment, verified access, deployment URL, compiled extensions, and a `defer`
function for background work. Input has validated `path`, `query`, and `body`
fields. Return `success(value)` or a typed `failure(kind, details)`. Handlers do
not receive Hono contexts or return HTTP responses. REST and MCP invoke the same
operation runner, which owns scopes, live feature checks, and work admission.

All REST addresses in this guide use `/api` as shorthand for `{mount}/api`. Generated operation paths are relative to the complete API base. Mounted nodes do not provide a host-root API alias.
