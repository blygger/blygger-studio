# Studio extensions

Studio is the reference client: it shows each protocol construct in its plainest form, and it stays plain so that other clients do not read its interface as the expected design. Extensions are how an interface experiment runs on a real node without becoming that reference. The first one is the lineage glyph from #35.

An extension is first-party TypeScript in this repository. An operator compiles it into their build, and the owner turns it on in Settings. With nothing turned on, the Studio is the reference Studio, byte for byte.

## Extensions in this repository

| Name | What it does |
| --- | --- |
| `example` | Fills each UI slot and does nothing that matters. The template to copy, and what the slot tests enable. |
| `inspect` | Adds "inspect" to each reading entry's ⋯ sheet: the record this Studio holds for it, and its JSON. Browser only; shipped in `extensions.json`. |
| `lineage-glyph` | The lineage glyph, hex view and action ring from #35. A glyph in each reading byline counts what a post draws on and what draws on it here. It opens a hex view of one hop of ancestors and descendants, where each corner previews what stub, quote a passage, fork, link post, history and open would make, and a second press runs that action. The actions are the Studio's own (or drafts and navigation through the extension context), so they write through the owner's session like the ⋯ sheet does. Its server routes are owner reads: `GET /api/ext/lineage-glyph/lineage` and `/summaries`. `scripts/lineage-demo.ts` runs a seeded local node with it enabled. |
| `reading-time` | An estimated reading time and word count at the end of each reading entry's byline. Browser only; shipped in `extensions.json`. |

## What an extension can do

| Slot | What it adds | Declared as |
| --- | --- | --- |
| Reading byline | Something at the end of each reading entry's byline, such as a badge or a button | `entryByline` (a component) |
| Reading actions | Rows after the Studio's own in an entry's ⋯ sheet | `entryActions(context)` |
| Sheets | A sheet of its own, opened from either slot above | `context.openSheet(render)` |
| A page | A screen at `/studio/ext/<name>`, linked from More | `page` |
| Owner reads | `GET /api/ext/<name>/…` routes, in the documented contract and the SDK | `extensions/<name>/contract.ts` + `server.ts` |

A slot receives a narrow context ([`src/ui/extension-api.ts`](../src/ui/extension-api.ts)):

- `entry`, `id`, `imported`, `url`: the reading entry, as `GET /api/reading` returns it.
- `client`: the SDK client, carrying the owner's session. Extension routes are SDK methods like any other operation.
- `openDraft(body)`, `navigate(location)`, `run(action)`: create-and-edit an item, move within the Studio, and run an action whose error lands in the screen's own error line.
- `actions`: the Studio's own handlers for this entry (`stub`, `fork`, `linkPost`, `history`, `open`), present only where the Studio offers them. An extension can present the existing actions differently without reimplementing them.
- `openSheet(render)`: open a sheet that the extension owns, under the entry.

Extensions do not get the router, the query cache, the data collections or any other Studio module. An extension's UI may import only `src/ui/extension-api.ts` (which also re-exports the Studio's `Sheet`, `Button`, `toast` and `confirm`), React, the SDK (`sdk/dist/browser.js`) and files in its own directory. `test-ui/extensions.test.ts` enforces this rule.

Each slot renders inside an error boundary. If an extension throws, that slot renders nothing until the page reloads, and the console names the extension. A throwing `entryActions()` or row handler is caught the same way. The rest of the Studio carries on.

## What is not offered, on purpose

- **Runtime loading.** No extension is fetched, evaluated or configured by URL at run time. The Studio runs with the owner's session cookie, so any script that runs there can act as the owner: publish, mint tokens, read drafts. Remote code in that session would be a credential-theft surface. Only code compiled into the build runs, and every extension is code in this repository that the operator chose to compile in.
- **Writes.** Extension routes are GETs under `/api/ext/<name>/`. The permission model classifies them as `owner:read`, and a route registered with any other method or prefix is refused when the Worker starts. An extension that wants to change something uses the existing contract through `client`, under the same scopes as any client.
- **The wire.** An extension does not reach `blyg.json`, public pages, feeds, `content_html` or mentions. It is studio furniture for one owner.
- **Changing the Studio's own controls.** No slot rewrites, hides or annotates a built-in button, row or label. #35 needed this (hover previews on `stub ↗`, tips on ⋯ rows), and it was left out because it would make the base UI's markup depend on extension code. See the open questions in the extension PR.
- **Other screens.** The slots are on the reading view only, plus an extension's own page. New slots should be added when an extension needs them, not before.

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
   import { routes } from './contract.ts';
   export const server: ServerExtension = {
     name: 'my-thing',
     routes: (router) => router.get(routes.extMyThingSummary, async (c) => c.json({ count: 0 }, 200)),
   };
   ```

   The operationId is derived (`ext` + the name + the operation, in PascalCase), so it cannot collide with another extension's or the base contract's.

4. Add the extension to `extensions/catalog.ts`: its name in `EXTENSIONS`, and its routes spread into `extensionRoutes`. If it has a server half, add that to `test/fixtures/extensions.server.ts`.
5. Run `npm run sdk:generate` and commit `openapi.json` and `sdk/generated`. Add each new operation to the `owner:read` lists in `test/rest-permissions.oracle.test.ts` and `test/mcp.oracle.test.ts`, and to `test/sdk-operations.test.ts`. The inventory checks fail until you do.
6. Test it: Worker tests for its routes (the Worker suite compiles in every extension, so its routes are live once a test enables it), and a browser spec that enables it with `PATCH /api/settings { "extensions": ["<name>"] }` and turns it off afterwards.

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

- The code is in the repository and passes the same review and CI as the rest of the Studio. Nothing loads at run time.
- An extension is compiled in only when the operator chooses it, and it runs only on a node whose owner has enabled it.
- Server routes run behind the owner API's middleware: owner session or bearer token, `owner:read` scope, the cross-origin refusal for cookie requests, and the owner and grant work budgets. On top of that, a prefix gate returns 404 when the extension is disabled. These checks are in `test/extensions.test.ts`, and the permission oracles list every extension operation.
- Extension routes are reads only. They are registered under the extension's own prefix, or not at all.
- "Reads only" is a property of an extension's *server routes*, not of its UI. In the browser an extension gets the SDK client carrying the owner's session, so its code can call any owner operation, writes included: publish, discard, mint tokens. Nothing at run time stops it. What makes that acceptable is the first two points: an extension is reviewed code the operator chose to compile in. Review an extension's UI as you would any Studio screen that writes.
- An extension's UI sees a narrow context and imports only the extension surface. Any URL an extension takes from someone else's document and turns into an `href` must pass `isFollowableUrl` (http, https or mailto), the same rule the Studio applies. Lineage-glyph does this on its server.
