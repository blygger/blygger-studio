# The extension registry (proposal)

> **Status: a proposal with a working implementation, for Venkat's ruling. Nothing here is decided.**
> It touches the security model, because it lets third-party code be compiled into the owner's session, and it proposes hosting on blygger.org. Under the project's model routing both are ⚠️ FABLE questions. The code, tests and docs show what the proposal would look like in practice. Merging them would not settle the questions; the ruling would. The open questions are [at the end](#open-questions).

[Studio extensions](extensions.md) are first-party: every extension is code in this repository. The registry lets other people's extensions reach an operator's build **without** changing the rule that makes extensions safe enough to have: nothing is loaded at run time. A registry entry is a pointer to pinned, hashed source. An operator vendors that source into their own build on their own machine, after reviewing it. The Studio never learns the registry exists.

```
registry/index.json ──PR review──▶ entry: repo + full commit + tree hash + "browser-only"
                                     │
operator: npm run ext:add <name> ────┤ fetch that commit (operator's machine only)
                                     │ check tree hash, layout, import boundary, typecheck
                                     │ print every file + review flags, ask
                                     ▼
extensions-vendor/<name>/  (gitignored)    extensions.local.json "vendored" lock (gitignored)
                                     │
npm run build ──────────────────────▶ re-hash, refuse if edited; compile in
                                     │
Settings → extensions ──────────────▶ owner turns it on (off by default)
```

## What it is and is not

- **It is** an index file (`registry/index.json`) with a schema, a validator (`npm run registry:check`), a vendoring CLI (`npm run ext:add` / `ext:update` / `ext:remove`), a hash helper (`npm run registry:hash`), and a static browse page (`npm run registry:site`).
- **It is not** a plugin loader, a package manager or a store. No Studio fetches, evaluates or configures anything from the registry, at run time or ever. The index is read only by `npm` scripts on an operator's or reviewer's machine.
- **Nothing third-party is committed to this repository.** The committed index has no entries. Vendored source goes into the gitignored `extensions-vendor/`, and the record of it goes into the gitignored `extensions.local.json`. A release is built from `extensions.json` alone (`BLYG_EXTENSIONS_SHIPPED_ONLY=1`), so a release can never carry a registry extension.

## Security model

The Studio runs with the owner's session. An extension's UI gets the SDK client carrying that session, so it can call any owner operation, writes included: publish, discard, mint tokens ([docs/extensions.md](extensions.md#security-model-in-one-place)). The registry keeps this tolerable by keeping two things true:

1. **The only code that runs is code the operator built.** A registry entry names a git repository, a **full commit id** (never a branch or tag) and a **tree hash** of the extension's files at that commit. `ext:add` fetches that exact commit and refuses it if the hash differs. `npm run build` re-hashes the vendored copy every time and refuses to compile one that was edited after vendoring. The commit pins history, and the hash pins bytes in a form a build can check without git or a network.
2. **The operator sees what they are adding.** `ext:add` prints the entry, every file, the hash and a list of review flags, and stages the source at `extensions-vendor/.staging-<name>/` for reading. It vendors nothing until the operator answers yes (or passes `--yes`, and in a non-interactive shell it refuses without it). The owner then still has to turn the extension on in Settings, where every extension starts off.

The static checks are **necessary, not sufficient**. The validator and `ext:add` refuse, mechanically:

| Refused | Why |
| --- | --- |
| A server half (`server.ts`, `contract.ts`) or `"server": true` | v1 is browser-only; [see below](#why-v1-is-browser-only) |
| An import other than React, `src/ui/extension-api.ts`, `sdk/dist/browser.js` and the extension's own `ui/` files | The import boundary that `test-ui/extensions.test.ts` holds in-repo extensions to. For vendored code it is enforced with the TypeScript parser instead of a regex |
| `import()` and `require()` | A computed specifier cannot be checked |
| CSS `@import` or `url()` naming a remote URL | That would load from the network at run time |
| Anything besides `ui/**/*.{ts,tsx,css}` and top-level docs (README, LICENSE, `*.md`); symlinks; submodules; hidden or non-ASCII paths; more than 200 files or 2 MB | Nothing rides along that the boundary check did not see |
| A name an in-repo extension holds (catalogued, or a directory under `extensions/`) | The name is the directory, the Settings key and the class-name prefix |
| A Studio version range that this checkout is outside (`ext:add`) | The extension API is not versioned separately; see the open questions |
| Code that fails to typecheck against the extension API with `tsconfig.ui.json` | The API it was written against has to be the API it gets |

They **flag**, for a human to read, anything that makes its own network requests, evaluates strings, creates scripts or workers, writes raw HTML, touches storage or cookies, or navigates windows. None of these can be ruled out statically: an extension that `fetch`es could be exfiltrating the owner's drafts. **A registry listing is not a security guarantee**, and the browse page says so.

## Operators: using a registry extension

```sh
npm run ext:add -- word-count                 # from registry/index.json
npm run ext:add -- word-count --index https://…/index.json
npm run ext:add -- word-count --from /path/to/a/clone   # fetch the pinned commit from a mirror; hash still checked
npm run ext:update -- word-count              # moves to the commit the index now names, showing which files changed
npm run ext:remove -- word-count
```

`ext:add` writes `extensions-vendor/word-count/` and records it in `extensions.local.json`:

```json
{
  "compile": ["word-count"],
  "vendored": {
    "word-count": { "repo": "https://…", "commit": "<full id>", "path": "…", "sha256": "<tree hash>", "index": "registry/index.json" }
  }
}
```

Then run `npm run build` (or deploy, which builds), and turn the extension on in **Settings → extensions**. To keep an extension vendored but out of a build, remove its name from `compile`. `ext:remove` deletes both the directory and the lock. A stored Settings toggle for an extension that is no longer compiled in does nothing.

`npm run upgrade` does not touch `extensions-vendor/` or `extensions.local.json`. After an upgrade, `npm run ext:update -- <name>` picks up an entry whose author has re-targeted it, and the build tells you if a vendored tree no longer matches its lock.

`BLYG_EXTENSIONS=all` (the browser suite) means every catalogued extension, never a vendored one.

## Authors: listing an extension

1. **Write it like an in-repo extension** ([docs/extensions.md](extensions.md#writing-one)), browser-only, in a directory of your own repository:

   ```
   <path>/
     ui/index.tsx        export const extension: StudioExtension, with name: '<name>'
     ui/…                .ts, .tsx and .css only
     README.md, LICENSE  optional
   ```

   Import the API as `../../../src/ui/extension-api.ts` and the SDK as `../../../sdk/dist/browser.js`, exactly as an in-repo extension does. The vendored copy sits at the same depth (`extensions-vendor/<name>/ui/`), so the paths resolve unchanged. Keep tests, build tooling and `package.json` outside `<path>`. The easiest way to develop is inside a Studio checkout as `extensions/<name>/`. Move the directory to your own repository to publish.

2. **Pin it.** Commit and push, then hash exactly that commit:

   ```sh
   npm run registry:hash -- https://github.com/you/your-repo.git <full commit id> <path>
   ```

3. **Write the entry.** `registry/index.schema.json` describes it, and `scripts/registry-schema.ts` is the authority:

   | Field | |
   | --- | --- |
   | `name` | lowercase letters, digits, single hyphens; unique; not an in-repo extension's |
   | `label`, `description` | as in Settings |
   | `author` | `{ "name": …, "url"?: https }` |
   | `homepage` | https |
   | `license` | SPDX expression |
   | `source` | `{ "repo": https git URL, "commit": full 40- or 64-hex id, "path": subdirectory or "" }` |
   | `sha256` | the tree hash from step 2 |
   | `studio` | comparators that must all hold, e.g. `">=0.39.0 <0.50.0"` |
   | `server` | `false`, the only value v1 accepts |

4. **Check it locally**, then open a PR that adds the entry to `registry/index.json`:

   ```sh
   npm run registry:check                                  # fetches every entry
   npm run registry:check -- --from <name>=/path/to/clone  # the same, from a local clone
   ```

   To test vendoring before you submit, put the entry in a scratch index and run `npm run ext:add -- <name> --index /tmp/index.json --from /path/to/clone`.

5. **To release a new version,** open a PR that changes the entry's `commit` and `sha256` (and `studio` if needed). Operators pick it up with `ext:update`, which shows which files changed.

### Reviewing a submission (maintainers)

`npm run registry:check` must pass, and CI runs only its `--offline` half, so run the full check yourself. Then read the source at the pinned commit with the printed review flags in hand. Check what it does with `client` (any write is a reason to ask why), every URL it turns into an `href` (`isFollowableUrl`), and any network request. The full diff between the old and new pinned commits is the unit of review for an update.

## Example: the in-repo extensions as entries

`inspect` and `reading-time` ship in this repository, so they are **not** registry entries and their names are reserved. This is what they would look like if they lived elsewhere (hashes taken at `9f6bab8`):

```json
{
  "$schema": "./index.schema.json",
  "version": 1,
  "extensions": [
    {
      "name": "reading-time",
      "label": "Reading time",
      "description": "Shows an estimated reading time and word count at the end of each reading entry's byline.",
      "author": { "name": "Blygger Studio" },
      "homepage": "https://github.com/blygger/blygger-studio/blob/main/docs/extensions.md",
      "license": "MIT",
      "source": { "repo": "https://github.com/blygger/blygger-studio.git", "commit": "9f6bab8add4d5d68e759b1ebfb7acf0517f269d9", "path": "extensions/reading-time" },
      "sha256": "45f47cac2a1516e3b9b29cba68130c440075a922a1042cf4c4a81f7fd719e62d",
      "studio": ">=0.39.0",
      "server": false
    },
    {
      "name": "inspect",
      "label": "Inspect",
      "description": "Adds “inspect” to each reading entry’s ⋯ sheet: the record this Studio holds for it — ids, versions, references, hashes — and its JSON.",
      "author": { "name": "Blygger Studio" },
      "homepage": "https://github.com/blygger/blygger-studio/blob/main/docs/extensions.md",
      "license": "MIT",
      "source": { "repo": "https://github.com/blygger/blygger-studio.git", "commit": "9f6bab8add4d5d68e759b1ebfb7acf0517f269d9", "path": "extensions/inspect" },
      "sha256": "132f55712aab9d1d2b9172f48e8f26588d9bcf64765908363fb9242179db2298",
      "studio": ">=0.39.0",
      "server": false
    }
  ]
}
```

`lineage-glyph` could not be an entry in v1, because it has a server half.

The tests use `registry/fixtures/hello-registry/`, which is committed to a throwaway git repository during each run and never listed in the index.

## The tree hash

The hash covers one line per regular file under `source.path`, formatted as `sha256sum` prints it (`<hex>  <relative path>\n`), with the lines sorted by path. The value is the sha256 of the joined lines. `scripts/registry-tree.ts` implements it, and anyone can reproduce it without this repository:

```sh
cd <path> && find . -type f | sed 's|^\./||' | LC_ALL=C sort \
  | while read -r f; do sha256sum "$f"; done | sha256sum
```

`registry:hash` and `ext:add` read the files from git objects at the pinned commit, so untracked or ignored files in a working copy never count.

## Hosting the browse page

`npm run registry:site` writes `build/registry-site/index.html` and `index.json`. The page is plain, server-rendered HTML with no script and no framework, listing each entry with its pinned source and the `ext:add` line. It is meant for a static host, and blygger.org was proposed. **Nothing here deploys it, and no committed config names a host, an account or a domain** (CLAUDE.md, "Our deploy config is not committed"). Where it is served, and from which repository, is one of the open questions.

## Why v1 is browser-only

An extension with a server half contributes contract routes, and the committed `openapi.json` and SDK include the routes of **every extension in the repository**, so that `npm run sdk:generate` is a function of the repository alone and CI's drift check is deterministic ([docs/extensions.md](extensions.md#why-every-extensions-routes-are-in-openapijson)). A vendored extension is not in the repository. Its routes would either be missing from the contract, leaving its UI with no SDK methods to call, or would make the contract depend on an operator's local files. Either outcome breaks a rule that exists for good reasons. A server half also runs in the Worker with the database, which is a larger trust step than a browser slot. So v1 refuses server halves, both in the schema (`"server": false`) and in the vendored tree (no `server.ts` or `contract.ts`). The build refuses them too.

## Open questions

For Venkat's ruling. The implementation takes the conservative side of each one where it had to take a side.

1. **Should third-party code be compiled into the owner's session at all?** This is the core question. The proposal's answer is yes, if it is pinned, hashed, statically checked and reviewed by the operator, and never loaded at run time. The alternative is to keep extensions first-party and point authors at upstreaming.
2. **Is a listing an endorsement?** Who reviews registry PRs, to what standard, and what the browse page promises. The draft says that a listing is not a security guarantee.
3. **Where does the index live?** The options are this repository (as drafted), a separate `blygger/registry` repository, or blygger.org serving a copy. A separate repository would decouple registry PRs from Studio releases, but `registry:check` needs a Studio checkout to typecheck against.
4. **Server halves.** Possible routes: (a) an extension that needs routes must be upstreamed into this repository; (b) an operator-local contract overlay, which gives up a deterministic `openapi.json`; (c) a small, generic owner-read surface that browser-only extensions share. None is built.
5. **Revocation.** If a listed extension turns out to be malicious, removing the entry stops new installs, but vendored copies keep building. Options: a `yanked` list that `npm run build` checks (which needs network at build, or a vendored copy of the list), or advisories only.
6. **An extension API version.** Entries target Studio version ranges because the extension API has no version of its own. A separate `EXTENSION_API` version would let an extension outlive Studio releases that do not touch the API.
7. **Signing.** The commit id and tree hash prove that the bytes are the ones the index names. They do not prove who wrote the index entry. Signed entries (for example sigstore attestations on the author's commit) would add that.
8. **A Content-Security-Policy `connect-src`** for the Studio would turn "makes network requests" from a review flag into something the browser enforces. It would also constrain the Studio itself, so it is a separate decision.
9. **Licences.** Does vendoring an extension into a build that is then deployed impose obligations the operator should be told about? The draft only displays the SPDX string.
