// npm run registry:site — a static browse page for the extension registry
// (docs/extension-registry.md). PROPOSAL, pending Venkat's ruling.
//
// Emits build/registry-site/index.html and a copy of the index as index.json:
// plain, server-rendered HTML, no framework and no script, so it can be served
// from any static host (blygger.org was proposed; nothing here names a host or
// an account, and nothing deploys it). The page lists entries and tells an
// operator how to vendor one; it never offers code to a Studio.
//
//   npm run registry:site [-- --index <path|url>] [--out <dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_INDEX, loadIndex } from "./registry-lib.ts";
import type { RegistryEntry, RegistryIndex } from "./registry-schema.ts";

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A browsable link to the pinned tree, for hosts whose URL shape is known; otherwise the repo itself. */
function treeUrl(entry: RegistryEntry): string {
  const base = entry.source.repo.replace(/\.git$/, "");
  if (/^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\//.test(base)) {
    const sep = base.includes("gitlab.com") ? "/-/tree/" : base.includes("codeberg.org") ? "/src/commit/" : "/tree/";
    return `${base}${sep}${entry.source.commit}${entry.source.path ? `/${entry.source.path}` : ""}`;
  }
  return entry.source.repo;
}

function card(entry: RegistryEntry): string {
  return `<article class="card" id="${escape(entry.name)}">
  <h2>${escape(entry.label)} <code>${escape(entry.name)}</code></h2>
  <p>${escape(entry.description)}</p>
  <dl>
    <dt>Author</dt><dd>${entry.author.url ? `<a href="${escape(entry.author.url)}" rel="nofollow">${escape(entry.author.name)}</a>` : escape(entry.author.name)}</dd>
    <dt>Homepage</dt><dd><a href="${escape(entry.homepage)}" rel="nofollow">${escape(entry.homepage)}</a></dd>
    <dt>Source</dt><dd><a href="${escape(treeUrl(entry))}" rel="nofollow">${escape(entry.source.repo)}</a> at <code>${escape(entry.source.commit.slice(0, 12))}</code>${entry.source.path ? ` in <code>${escape(entry.source.path)}/</code>` : ""}</dd>
    <dt>Tree hash</dt><dd><code class="hash">${escape(entry.sha256)}</code></dd>
    <dt>Studio</dt><dd><code>${escape(entry.studio)}</code></dd>
    <dt>License</dt><dd>${escape(entry.license)}</dd>
    <dt>Runs</dt><dd>In the browser only</dd>
  </dl>
  <pre><code>npm run ext:add -- ${escape(entry.name)}</code></pre>
</article>`;
}

export function renderSite(index: RegistryIndex): string {
  const entries = [...index.extensions].sort((a, b) => a.label.localeCompare(b.label));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio extensions</title>
<meta name="description" content="Third-party extensions for Blygger Studio, vendored into an operator's own build.">
<style>
:root { --bg: #fbfaf7; --fg: #1d1c1a; --muted: #6a675f; --rule: #dedad0; --card: #fff; --warn: #fff4d6; --link: #1f5fa8; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #ece9e1; --muted: #a29e94; --rule: #36332d; --card: #1e1d1a; --warn: #3a3020; --link: #8ab8f0; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 Georgia, "Iowan Old Style", serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { font-size: 1.8rem; margin: 0 0 .25rem; }
h2 { font-size: 1.2rem; margin: 0 0 .5rem; }
h2 code { font-size: .8rem; color: var(--muted); font-weight: normal; }
a { color: var(--link); }
code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: var(--bg); border: 1px solid var(--rule); padding: .5rem .75rem; overflow-x: auto; margin: .75rem 0 0; }
.lede { color: var(--muted); }
.warn { background: var(--warn); border: 1px solid var(--rule); padding: .75rem 1rem; margin: 1.5rem 0; }
.card { background: var(--card); border: 1px solid var(--rule); padding: 1rem 1.25rem; margin: 1rem 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .15rem 1rem; margin: .75rem 0 0; font-size: .9rem; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.hash { font-size: 11px; }
.empty { color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<main>
<h1>Studio extensions</h1>
<p class="lede">Browser-only extensions for Blygger Studio, written by people other than its maintainers. A proposal: see docs/extension-registry.md in the Studio repository.</p>
<div class="warn">
<p><strong>Nothing on this page runs in your Studio until you build it in.</strong> A Studio never loads code from here. You vendor an extension's pinned source into your own build with <code>npm run ext:add</code>, which checks its hash and shows you every file first.</p>
<p>An extension runs with your owner session. Its code can do anything you can do in the Studio, including publishing and minting tokens. Read it before you vendor it.</p>
</div>
${entries.length ? entries.map(card).join("\n") : `<p class="empty">No extensions are listed yet.</p>`}
<p class="lede">Index format: <a href="index.json">index.json</a>, version ${index.version}. To list an extension, open a pull request that adds an entry to <code>registry/index.json</code>.</p>
</main>
</body>
</html>
`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const index = await loadIndex(value("--index") ?? DEFAULT_INDEX);
  const out = value("--out") ?? "build/registry-site";
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "index.html"), renderSite(index));
  writeFileSync(join(out, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`registry: ${out}/index.html (${index.extensions.length} entr${index.extensions.length === 1 ? "y" : "ies"})`);
}
