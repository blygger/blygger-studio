// The extension registry's machinery (docs/extension-registry.md).
//
// PROPOSAL, pending Venkat's ruling. Third-party code compiled into the
// owner's session, and an index hosted on blygger.org, are both decisions this
// file does not make; it is the working implementation the proposal points at.
//
// The model is build-time vendoring of pinned, reviewed source, because the
// Studio refuses runtime loading (docs/extensions.md): a registry entry pins a
// git commit and a tree hash; `ext:add` fetches that commit on the operator's
// machine, checks the hash, the browser-only layout and the import boundary,
// typechecks it against the extension API, shows the operator what it is about
// to vendor, and only then writes it to the gitignored extensions-vendor/ and
// records it in the gitignored extensions.local.json. Nothing here runs in a
// Worker or a browser, and nothing third-party is ever committed.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { EXTENSIONS } from "../extensions/catalog.ts";
import { type RegistryEntry, type RegistryIndex, RANGE, parseIndex } from "./registry-schema.ts";
import { type TreeFile, readTree, treeHash } from "./registry-tree.ts";

export const VENDOR_DIR = "extensions-vendor";
export const LOCAL_FILE = "extensions.local.json";
export const DEFAULT_INDEX = "registry/index.json";

const LIMITS = { files: 200, fileBytes: 512 * 1024, totalBytes: 2 * 1024 * 1024 };

// ---------------------------------------------------------------------------
// The index

/** Read an index from a path or an https:// URL. Only the operator's machine ever reads it. */
export async function loadIndex(source: string, root = process.cwd()): Promise<RegistryIndex> {
  let text: string;
  if (/^https:\/\//.test(source)) {
    const response = await fetch(source, { redirect: "follow" });
    if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
    text = await response.text();
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    throw new Error(`${source}: an index is a local path or an https:// URL`);
  } else {
    text = readFileSync(resolve(root, source), "utf8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source} is not valid JSON: ${(e as Error).message}`);
  }
  return parseIndex(raw);
}

/** Names a registry extension may not take: everything catalogued, and every directory under extensions/ (a branch may carry one the catalog does not yet list). */
export function reservedNames(root = process.cwd()): Set<string> {
  const names = new Set<string>(EXTENSIONS);
  const dir = join(root, "extensions");
  if (existsSync(dir)) for (const name of readdirSync(dir)) if (statSync(join(dir, name)).isDirectory()) names.add(name);
  return names;
}

// ---------------------------------------------------------------------------
// Versions

const parseVersion = (v: string) => v.split(".").map(Number) as [number, number, number];
const compare = (a: string, b: string) => {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

/** Whether `version` satisfies every comparator in `range` (`>=0.39.0 <0.50.0`). */
export function satisfies(version: string, range: string): boolean {
  if (!RANGE.test(range)) throw new Error(`"${range}" is not a version range`);
  const plain = version.replace(/[-+].*$/, "");
  return range.split(" ").every((comparator) => {
    const [, op = "=", target] = /^(>=|<=|>|<|=)?(.+)$/.exec(comparator)!;
    const c = compare(plain, target);
    return op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : c === 0;
  });
}

export const studioVersion = (root = process.cwd()) => (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

// ---------------------------------------------------------------------------
// Fetching a pinned tree

export interface FetchOptions {
  /** Fetch the pinned commit from here instead of `source.repo`: a mirror, or a local clone (file:// or a path). The commit and hash are checked all the same. */
  from?: string;
}

/**
 * The files of `source.path` at `source.commit`, read straight from git
 * objects (nothing is checked out, so no path in the tree touches the disk).
 * Symlinks and submodules are refused. Runs only on the operator's machine.
 */
export function fetchTree(source: RegistryEntry["source"], options: FetchOptions = {}): TreeFile[] {
  const url = options.from ?? source.repo;
  const local = !/^https:\/\//.test(url);
  if (local && !(/^file:\/\//.test(url) || url.startsWith("/"))) throw new Error(`${url}: a source is an https:// URL, a file:// URL or an absolute path`);
  const dir = mkdtempSync(join(tmpdir(), "blyg-registry-"));
  // Only https (and, for a --from mirror, the local file transport): never ext::, ssh or anything else a URL could name.
  const protocols = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...(local ? ["-c", "protocol.file.allow=always"] : [])];
  const git = (args: string[], encoding: "utf8" | "buffer" = "utf8") =>
    execFileSync("git", [...protocols, ...args], { cwd: dir, encoding: encoding as "buffer", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  try {
    git(["init", "-q", "--bare"]);
    try {
      git(["fetch", "-q", "--depth", "1", "--no-tags", url, source.commit]);
    } catch {
      // A server that will not serve a commit by id: fetch its refs and look for it among them.
      git(["fetch", "-q", "--no-tags", url, "+refs/*:refs/fetched/*"]);
    }
    let type = "";
    try {
      type = git(["cat-file", "-t", source.commit]).toString().trim();
    } catch {
      /* missing */
    }
    if (type !== "commit") throw new Error(`commit ${source.commit} is not in ${url}`);
    const prefix = source.path ? `${source.path}/` : "";
    const listing = git(["ls-tree", "-r", "-z", "--full-tree", source.commit, ...(prefix ? ["--", prefix] : [])]).toString();
    const files: TreeFile[] = [];
    for (const line of listing.split("\0").filter(Boolean)) {
      const [meta, path] = line.split("\t");
      const [mode, kind, oid] = meta.split(" ");
      const rel = path.slice(prefix.length);
      if (mode === "120000") throw new Error(`${rel}: symlinks are not allowed`);
      if (kind !== "blob") throw new Error(`${rel}: submodules are not allowed`);
      files.push({ path: rel, bytes: new Uint8Array(git(["cat-file", "blob", oid], "buffer") as unknown as Buffer) });
    }
    if (!files.length) throw new Error(`${source.path || "(root)"} is empty or missing at ${source.commit}`);
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// What a registry extension may contain

const DOC = /^(?:README|LICEN[CS]E|COPYING|NOTICE|CHANGELOG)(?:\.[A-Za-z0-9]+)?$|^[A-Za-z0-9_-]+\.md$/;
const SAFE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/** Problems with a tree's layout: browser-only, `ui/` plus top-level docs, sane sizes. Empty means it passes. */
export function checkLayout(files: readonly TreeFile[]): string[] {
  const problems: string[] = [];
  const paths = new Set(files.map((file) => file.path));
  if (!paths.has("ui/index.tsx")) problems.push("ui/index.tsx is missing (it must export `extension: StudioExtension`)");
  for (const half of ["server.ts", "contract.ts"]) {
    if (paths.has(half)) problems.push(`${half}: registry extensions are browser-only in v1. A server half adds routes to openapi.json, which must stay a function of the repository (docs/extension-registry.md)`);
  }
  let total = 0;
  for (const file of files) {
    total += file.bytes.length;
    if (!SAFE_PATH.test(file.path)) problems.push(`${file.path}: paths are ASCII letters, digits, ".", "_" and "-", with no hidden files`);
    else if (file.path === "server.ts" || file.path === "contract.ts") continue;
    else if (file.path.startsWith("ui/")) {
      if (!/\.(tsx?|css)$/.test(file.path)) problems.push(`${file.path}: ui/ holds .ts, .tsx and .css files only`);
      if (/\.d\.ts$/.test(file.path)) problems.push(`${file.path}: declaration files are not allowed`);
    } else if (file.path.includes("/") || !DOC.test(file.path)) {
      problems.push(`${file.path}: a registry extension carries ui/ and top-level docs (README, LICENSE, *.md) only`);
    }
    if (file.bytes.length > LIMITS.fileBytes) problems.push(`${file.path}: larger than ${LIMITS.fileBytes / 1024} KB`);
  }
  if (files.length > LIMITS.files) problems.push(`more than ${LIMITS.files} files`);
  if (total > LIMITS.totalBytes) problems.push(`larger than ${LIMITS.totalBytes / 1024 / 1024} MB in all`);
  return problems;
}

/** Where an extension's UI may reach, relative to the extension's own directory (extensions/<name>/ or extensions-vendor/<name>/). */
const ALLOWED_OUTSIDE = new Set(["../../src/ui/extension-api.ts", "../../sdk/dist/browser.js"]);
const BARE = /^react(?:\/[a-z0-9-]+)*$/;

let ts: typeof import("typescript") | undefined;
async function typescript() {
  return (ts ??= (await import("typescript")).default);
}

/**
 * The import boundary (test-ui/extensions.test.ts holds the repository's own
 * extensions to it): an extension's UI imports only src/ui/extension-api.ts,
 * React, the SDK and files in its own ui/ directory. For third-party code it is
 * enforced with the TypeScript parser, not a regex, and dynamic import() and
 * require() are refused outright, since a computed specifier cannot be checked.
 */
export async function checkImports(files: readonly TreeFile[]): Promise<string[]> {
  const problems: string[] = [];
  const paths = new Set(files.map((file) => file.path));
  const resolves = (target: string) => ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].some((suffix) => paths.has(target + suffix));
  const decoder = new TextDecoder();
  const parser = await typescript();
  for (const file of files) {
    if (!file.path.startsWith("ui/")) continue;
    const source = decoder.decode(file.bytes);
    const specs: string[] = [];
    if (file.path.endsWith(".css")) {
      for (const match of source.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g)) specs.push(match[1]);
      for (const match of source.matchAll(/url\(\s*['"]?([^'")\s]+)/g)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(match[1]) && !match[1].startsWith("data:")) problems.push(`${file.path}: url(${match[1]}) loads from the network at run time`);
      }
    } else {
      const info = parser.preProcessFile(source, true, true);
      specs.push(...info.importedFiles.map((ref) => ref.fileName), ...info.referencedFiles.map((ref) => ref.fileName));
      if (/\bimport\s*\(/.test(source)) problems.push(`${file.path}: dynamic import() is not allowed in a registry extension`);
      if (/\brequire\s*\(/.test(source)) problems.push(`${file.path}: require() is not allowed in a registry extension`);
    }
    for (const spec of specs) {
      if (BARE.test(spec)) continue;
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        problems.push(`${file.path} imports "${spec}": only React, the extension API, the SDK and the extension's own ui/ files`);
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(file.path), spec));
      if (ALLOWED_OUTSIDE.has(target)) continue;
      if (!target.startsWith("ui/") || !resolves(target)) problems.push(`${file.path} imports "${spec}": only React, the extension API, the SDK and the extension's own ui/ files`);
    }
  }
  return problems;
}

/**
 * Things a reviewer should look at, not refusals: the extension runs with the
 * owner's session, and none of these can be ruled out statically. Printed by
 * ext:add before the operator decides, and by registry:check.
 */
export function reviewFlags(files: readonly TreeFile[]): string[] {
  const flags: [RegExp, string][] = [
    [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/, "makes network requests of its own"],
    [/\beval\s*\(|new\s+Function\b|setTimeout\s*\(\s*['"`]/, "evaluates strings as code"],
    [/createElement\s*\(\s*['"`]script|<script\b|importScripts|new\s+Worker\b/, "creates scripts or workers"],
    [/dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML/, "writes raw HTML"],
    [/localStorage|sessionStorage|indexedDB|document\.cookie/, "touches browser storage or cookies"],
    [/window\.open|location\s*(?:\.href)?\s*=|\.assign\s*\(/, "opens or navigates windows"],
  ];
  const decoder = new TextDecoder();
  const out: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith("ui/")) continue;
    const source = decoder.decode(file.bytes);
    for (const [pattern, what] of flags) if (pattern.test(source)) out.push(`${file.path} ${what}`);
  }
  return out;
}

/** Whether ui/index.tsx declares the entry's name (Settings matches on it). A warning only: it cannot be proved without running the code. */
export function declaresName(files: readonly TreeFile[], name: string): boolean {
  const index = files.find((file) => file.path === "ui/index.tsx");
  return !!index && new RegExp(`\\bname\\s*:\\s*['"\`]${name}['"\`]`).test(new TextDecoder().decode(index.bytes));
}

// ---------------------------------------------------------------------------
// Staging and typechecking

export function writeTree(dir: string, files: readonly TreeFile[]) {
  rmSync(dir, { recursive: true, force: true });
  for (const file of files) {
    const target = join(dir, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
}

/**
 * Typecheck a staged extension against the extension API with tsconfig.ui.json.
 * The staged tree sits at the same depth as extensions/<name>/, so its
 * `../../../src/ui/extension-api.ts` imports resolve exactly as an in-repo
 * extension's do. Needs a built SDK (npm run build).
 */
export function typecheck(stagedDir: string, root = process.cwd()): { ok: boolean; output: string } {
  if (!existsSync(join(root, "sdk/dist/browser.d.ts"))) return { ok: false, output: "sdk/dist is not built; run npm run build first" };
  mkdirSync(join(root, "build"), { recursive: true });
  const config = join(root, "build", `registry-typecheck-${posix.basename(stagedDir)}.json`);
  const rel = `../${stagedDir.split(/[\\/]/).slice(-2).join("/")}`;
  writeFileSync(config, JSON.stringify({ extends: "../tsconfig.ui.json", include: [`${rel}/ui/**/*.ts`, `${rel}/ui/**/*.tsx`] }));
  try {
    const result = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", config, "--pretty", "false"], { cwd: root, encoding: "utf8" });
    // Name files relative to the extension, not by the staging directory's path.
    const output = `${result.stdout}${result.stderr}`.trim().replace(/[^\s(]*extensions-vendor\/\.staging-[^/]+\//g, "");
    return { ok: result.status === 0, output };
  } finally {
    rmSync(config, { force: true });
  }
}

// ---------------------------------------------------------------------------
// The operator's local file

export interface VendorLock {
  repo: string;
  commit: string;
  path: string;
  sha256: string;
  /** Where the entry came from, so ext:update knows where to look again. */
  index: string;
}
export interface LocalConfig {
  compile?: string[];
  remove?: string[];
  vendored?: Record<string, VendorLock>;
  [key: string]: unknown;
}

export function readLocal(root = process.cwd()): LocalConfig {
  const path = join(root, LOCAL_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LocalConfig) : {};
}
export function writeLocal(config: LocalConfig, root = process.cwd()) {
  writeFileSync(join(root, LOCAL_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Checking one entry end to end (used by ext:add and registry:check)

export interface EntryReport {
  files: TreeFile[];
  hash: string;
  problems: string[];
  flags: string[];
  /** The staged copy, still on disk, when `stage` was asked for and nothing was refused before typechecking. */
  staged?: string;
}

export interface CheckOptions extends FetchOptions {
  root?: string;
  /** Typecheck against the extension API (default true). */
  typecheck?: boolean;
  /** Leave the staged copy for review instead of removing it. */
  keepStaged?: boolean;
  /** Check the Studio version range against this checkout (ext:add), not just its syntax (registry:check). */
  checkStudioVersion?: boolean;
}

export async function checkEntry(entry: RegistryEntry, options: CheckOptions = {}): Promise<EntryReport> {
  const root = options.root ?? process.cwd();
  const problems: string[] = [];
  if (reservedNames(root).has(entry.name)) problems.push(`"${entry.name}" is the name of an extension in this repository`);
  if (options.checkStudioVersion !== false) {
    const version = studioVersion(root);
    if (!satisfies(version, entry.studio)) problems.push(`targets Studio ${entry.studio}; this checkout is ${version}`);
  }
  const files = fetchTree(entry.source, options);
  const hash = treeHash(files);
  if (hash !== entry.sha256) problems.push(`tree hash is ${hash}, the index says ${entry.sha256}`);
  problems.push(...checkLayout(files), ...(await checkImports(files)));
  const flags = reviewFlags(files);
  if (!declaresName(files, entry.name)) flags.push(`ui/index.tsx does not visibly declare name: "${entry.name}"; Settings will not match it unless it does`);
  const report: EntryReport = { files, hash, problems, flags };
  if (problems.length) return report;
  const staged = join(root, VENDOR_DIR, `.staging-${entry.name}`);
  writeTree(staged, files);
  if (options.typecheck !== false) {
    const result = typecheck(staged, root);
    if (!result.ok) problems.push(`does not typecheck against the extension API:\n${result.output}`);
  }
  if (options.keepStaged && !problems.length) report.staged = staged;
  else rmSync(staged, { recursive: true, force: true });
  return report;
}

/** Move a reviewed, staged tree into place and record it. */
export function commitVendored(entry: RegistryEntry, staged: string, index: string, root = process.cwd()) {
  const target = join(root, VENDOR_DIR, entry.name);
  rmSync(target, { recursive: true, force: true });
  renameSync(staged, target);
  const local = readLocal(root);
  local.compile = [...new Set([...(local.compile ?? []), entry.name])];
  local.remove = local.remove?.filter((name) => name !== entry.name);
  if (local.remove && !local.remove.length) delete local.remove;
  local.vendored = { ...local.vendored, [entry.name]: { repo: entry.source.repo, commit: entry.source.commit, path: entry.source.path, sha256: entry.sha256, index } };
  writeLocal(local, root);
}

export function removeVendored(name: string, root = process.cwd()): boolean {
  const local = readLocal(root);
  const known = !!local.vendored?.[name] || existsSync(join(root, VENDOR_DIR, name));
  rmSync(join(root, VENDOR_DIR, name), { recursive: true, force: true });
  if (local.vendored) delete local.vendored[name];
  if (local.vendored && !Object.keys(local.vendored).length) delete local.vendored;
  if (local.compile) local.compile = local.compile.filter((entry) => entry !== name);
  if (known) writeLocal(local, root);
  return known;
}

/** Files added, removed and changed between the vendored copy and a candidate tree (ext:update shows this). */
export function treeDiff(before: readonly TreeFile[], after: readonly TreeFile[]) {
  const key = (file: TreeFile) => treeHash([{ path: "", bytes: file.bytes }]);
  const old = new Map(before.map((file) => [file.path, key(file)]));
  const now = new Map(after.map((file) => [file.path, key(file)]));
  return {
    added: [...now.keys()].filter((path) => !old.has(path)),
    removed: [...old.keys()].filter((path) => !now.has(path)),
    changed: [...now.keys()].filter((path) => old.has(path) && old.get(path) !== now.get(path)),
  };
}

export const vendoredTree = (name: string, root = process.cwd()) => {
  const dir = join(root, VENDOR_DIR, name);
  return existsSync(dir) ? readTree(dir) : [];
};
