// The extension registry (docs/extension-registry.md; a proposal pending
// Venkat's ruling). What these pin, all without network:
//   1. The index schema: pinned full commit ids, https sources, browser-only
//      entries, unique names; the committed index lists nothing third-party and
//      its JSON Schema is current.
//   2. The tree hash is reproducible and is checked against the index.
//   3. Vendoring refuses a server half, an import outside the extension
//      boundary, a name an in-repo extension holds, and a Studio range this
//      checkout is outside; a good fixture typechecks against the extension API.
//   4. A vendored extension compiles in from extensions.local.json, and a
//      release build (BLYG_EXTENSIONS_SHIPPED_ONLY) never carries it; a tree
//      edited after vendoring fails the build.
//   5. extensions-vendor/ is gitignored and holds nothing tracked.
// Sources are throwaway git repositories made from registry/fixtures/.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { checkEntry, checkImports, checkLayout, commitVendored, readLocal, removeVendored, satisfies } from '../scripts/registry-lib.ts';
import { type RegistryEntry, jsonSchema, parseIndex } from '../scripts/registry-schema.ts';
import { hashDirectory, readTree, treeHash } from '../scripts/registry-tree.ts';
import { renderSite } from '../scripts/registry-site.ts';

const REPO = resolve('.');
const FIXTURE = join(REPO, 'registry/fixtures/hello-registry');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A git repository holding `files` under `ext/`, committed once. */
function sourceRepo(files: Record<string, string>): { dir: string; commit: string } {
  const dir = temp('blyg-registry-src-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'ext', path)), { recursive: true });
    writeFileSync(join(dir, 'ext', path), content);
  }
  writeFileSync(join(dir, 'outside.txt'), 'not part of the extension');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return { dir, commit: git('rev-parse', 'HEAD') };
}

const fixtureFiles = (): Record<string, string> =>
  Object.fromEntries(readTree(FIXTURE).map((file) => [file.path, new TextDecoder().decode(file.bytes)]));

function entryFor(repo: { commit: string }, files: Record<string, string>, overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: 'hello-registry',
    label: 'Hello registry',
    description: 'A test fixture.',
    author: { name: 'Test' },
    homepage: 'https://example.invalid/hello-registry',
    license: 'MIT',
    source: { repo: 'https://example.invalid/hello-registry.git', commit: repo.commit, path: 'ext' },
    sha256: treeHash(Object.entries(files).map(([path, content]) => ({ path, bytes: new TextEncoder().encode(content) }))),
    studio: '>=0.0.1',
    server: false,
    ...overrides,
  };
}

/** A throwaway checkout: the real source, SDK and dependencies by symlink, and its own build/, local file and vendor directory. */
function checkoutRoot(): string {
  const root = temp('blyg-registry-root-');
  for (const link of ['src', 'sdk', 'node_modules', 'extensions', 'scripts', 'tsconfig.ui.json']) symlinkSync(join(REPO, link), join(root, link));
  for (const copy of ['package.json', 'extensions.json']) cpSync(join(REPO, copy), join(root, copy));
  return root;
}
// The operator's environment, without an override of the extension list.
const { BLYG_EXTENSIONS: _override, BLYG_EXTENSIONS_SHIPPED_ONLY: _shippedOnly, ...shipped } = process.env;
const buildExtensions = (root: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['--import', TSX, join(REPO, 'scripts/build-extensions.ts')], { cwd: root, encoding: 'utf8', env: { ...shipped, ...env } });

describe('the index', () => {
  const valid = entryFor({ commit: 'a'.repeat(40) }, { 'ui/index.tsx': '' });

  test('accepts a pinned, browser-only entry', () => {
    expect(parseIndex({ version: 1, extensions: [valid] }).extensions[0].name).toBe('hello-registry');
  });

  test('refuses a server half, and says why', () => {
    expect(() => parseIndex({ version: 1, extensions: [{ ...valid, server: true }] })).toThrow(/browser-only in v1.*openapi\.json/);
  });

  test('refuses anything but a full commit id, an https source, a valid name and range, and duplicates', () => {
    const bad = (patch: object) => () => parseIndex({ version: 1, extensions: [{ ...valid, ...patch }] });
    expect(bad({ source: { ...valid.source, commit: 'main' } })).toThrow(/full, lowercase commit id/);
    expect(bad({ source: { ...valid.source, commit: 'abc1234' } })).toThrow(/commit/);
    expect(bad({ source: { ...valid.source, commit: 'A'.repeat(40) } })).toThrow(/commit/);
    expect(bad({ source: { ...valid.source, repo: 'http://example.invalid/x.git' } })).toThrow(/https/);
    expect(bad({ source: { ...valid.source, repo: 'ext::sh -c touch% /tmp/pwned' } })).toThrow(/https/);
    expect(bad({ source: { ...valid.source, path: '../escape' } })).toThrow(/subdirectory/);
    expect(bad({ name: 'Bad_Name' })).toThrow(/name/);
    expect(bad({ studio: '^0.39' })).toThrow(/comparators/);
    expect(bad({ sha256: 'f'.repeat(63) })).toThrow(/sha256/);
    expect(bad({ runtimeUrl: 'https://cdn.example/x.js' })).toThrow();
    expect(() => parseIndex({ version: 1, extensions: [valid, valid] })).toThrow(/listed twice/);
  });

  test('the committed index lists nothing third-party, and its JSON Schema is current', () => {
    const index = parseIndex(JSON.parse(readFileSync('registry/index.json', 'utf8')));
    expect(index.extensions).toEqual([]);
    expect(JSON.parse(readFileSync('registry/index.schema.json', 'utf8'))).toEqual(JSON.parse(JSON.stringify(jsonSchema())));
  });

  test('studio ranges', () => {
    expect(satisfies('0.39.0', '>=0.39.0 <0.50.0')).toBe(true);
    expect(satisfies('0.50.0', '>=0.39.0 <0.50.0')).toBe(false);
    expect(satisfies('0.38.9', '>=0.39.0')).toBe(false);
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
  });
});

describe('the tree hash', () => {
  test('is the sha256 of sha256sum-style lines sorted by path, whatever order the files arrive in', () => {
    const files = [
      { path: 'ui/index.tsx', bytes: new TextEncoder().encode('a') },
      { path: 'README.md', bytes: new TextEncoder().encode('b') },
    ];
    const hex = (data: string) => createHash('sha256').update(data).digest('hex');
    const expected = hex(`${hex('b')}  README.md\n${hex('a')}  ui/index.tsx\n`);
    expect(treeHash(files)).toBe(expected);
    expect(treeHash([...files].reverse())).toBe(expected);
  });

  test('of a fetched commit equals the hash of the same files on disk, and excludes what is outside the path', async () => {
    const files = fixtureFiles();
    const repo = sourceRepo(files);
    const report = await checkEntry(entryFor(repo, files), { from: repo.dir, root: checkoutRoot(), typecheck: false });
    expect(report.problems).toEqual([]);
    expect(report.hash).toBe(hashDirectory(FIXTURE));
    expect(report.files.map((file) => file.path)).not.toContain('outside.txt');
  });

  test('a mismatch with the index is refused', async () => {
    const files = fixtureFiles();
    const repo = sourceRepo(files);
    const report = await checkEntry(entryFor(repo, files, { sha256: '0'.repeat(64) }), { from: repo.dir, root: checkoutRoot(), typecheck: false });
    expect(report.problems.join('\n')).toMatch(/tree hash is [0-9a-f]{64}, the index says 0{64}/);
  });

  test('a commit the source does not have is refused', async () => {
    const files = fixtureFiles();
    const repo = sourceRepo(files);
    await expect(checkEntry(entryFor({ commit: 'b'.repeat(40) }, files), { from: repo.dir, root: checkoutRoot(), typecheck: false })).rejects.toThrow(/not in/);
  });
});

describe('what may be vendored', () => {
  const bytes = (files: Record<string, string>) => Object.entries(files).map(([path, content]) => ({ path, bytes: new TextEncoder().encode(content) }));

  test('a server half is refused, with the reason', async () => {
    const files = { ...fixtureFiles(), 'server.ts': 'export const server = {};', 'contract.ts': 'export const routes = {};' };
    expect(checkLayout(bytes(files)).join('\n')).toMatch(/server\.ts: registry extensions are browser-only in v1/);
    const repo = sourceRepo(files);
    const report = await checkEntry(entryFor(repo, files), { from: repo.dir, root: checkoutRoot(), typecheck: false });
    expect(report.problems.some((problem) => problem.startsWith('contract.ts: registry extensions are browser-only'))).toBe(true);
  });

  test('ui/ holds code and styles only, and nothing else rides along', () => {
    const problems = checkLayout(bytes({ 'ui/index.tsx': '', 'ui/payload.js': '', 'tools/build.ts': '', '.github/x.yml': '', 'LICENSE': '', 'NOTES.md': '' }));
    expect(problems).toEqual([
      'ui/payload.js: ui/ holds .ts, .tsx and .css files only',
      'tools/build.ts: a registry extension carries ui/ and top-level docs (README, LICENSE, *.md) only',
      '.github/x.yml: paths are ASCII letters, digits, ".", "_" and "-", with no hidden files',
    ]);
    expect(checkLayout(bytes({ 'ui/other.tsx': '' }))).toEqual(['ui/index.tsx is missing (it must export `extension: StudioExtension`)']);
  });

  test('the import boundary holds for vendored code, enforced by the parser', async () => {
    const ok = bytes({
      'ui/index.tsx': "import { useState } from 'react';\nimport { jsx } from 'react/jsx-runtime';\nimport type { StudioExtension } from '../../../src/ui/extension-api.ts';\nimport { unwrap } from '../../../sdk/dist/browser.js';\nimport { x } from './lib/x.ts';\nimport './style.css';",
      'ui/lib/x.ts': "export { y } from '../y.ts';",
      'ui/y.ts': '',
      'ui/style.css': '.a { background: url(data:image/png;base64,AA==); }',
    });
    expect(await checkImports(ok)).toEqual([]);
    const bad = bytes({
      'ui/index.tsx': [
        "import { router } from '../../../src/ui/router.tsx';",
        "import _ from 'lodash';",
        "export * from '../README.md';",
        "import x from '../../other-extension/ui/index.tsx';",
        "const later = import('./y.ts');",
        "const old = require('./y.ts');",
      ].join('\n'),
      'ui/y.ts': '',
      'ui/style.css': "@import 'https://fonts.example/x.css';\n.a { background: url(https://tracker.example/p.gif); }",
      'README.md': '',
    });
    expect(await checkImports(bad)).toEqual([
      'ui/index.tsx: dynamic import() is not allowed in a registry extension',
      'ui/index.tsx: require() is not allowed in a registry extension',
      'ui/index.tsx imports "../../../src/ui/router.tsx": only React, the extension API, the SDK and the extension\'s own ui/ files',
      'ui/index.tsx imports "lodash": only React, the extension API, the SDK and the extension\'s own ui/ files',
      'ui/index.tsx imports "../README.md": only React, the extension API, the SDK and the extension\'s own ui/ files',
      'ui/index.tsx imports "../../other-extension/ui/index.tsx": only React, the extension API, the SDK and the extension\'s own ui/ files',
      'ui/style.css: url(https://tracker.example/p.gif) loads from the network at run time',
      'ui/style.css imports "https://fonts.example/x.css": only React, the extension API, the SDK and the extension\'s own ui/ files',
    ]);
  });

  test("a name an in-repo extension holds is refused, and so is a Studio range this checkout is outside", async () => {
    const files = fixtureFiles();
    const repo = sourceRepo(files);
    const root = checkoutRoot();
    const taken = await checkEntry(entryFor(repo, files, { name: 'inspect' }), { from: repo.dir, root, typecheck: false });
    expect(taken.problems).toContain('"inspect" is the name of an extension in this repository');
    const old = await checkEntry(entryFor(repo, files, { studio: '<0.1.0' }), { from: repo.dir, root, typecheck: false });
    expect(old.problems.join('\n')).toMatch(/targets Studio <0\.1\.0; this checkout is/);
  });

  test('a good extension typechecks against the extension API; a bad one does not', async () => {
    const files = fixtureFiles();
    const repo = sourceRepo(files);
    const root = checkoutRoot();
    const good = await checkEntry(entryFor(repo, files), { from: repo.dir, root });
    expect(good.problems).toEqual([]);
    const broken = { ...files, 'ui/greeting.ts': 'export const greeting = (kind: number) => kind;' };
    const brokenRepo = sourceRepo(broken);
    const bad = await checkEntry(entryFor(brokenRepo, broken), { from: brokenRepo.dir, root });
    expect(bad.problems.join('\n')).toMatch(/does not typecheck against the extension API:\nui\/index.tsx\(\d+,\d+\): error TS2345/);
    expect(existsSync(join(root, 'extensions-vendor/.staging-hello-registry'))).toBe(false);
  }, 120_000);
});

describe('vendored extensions in a build', () => {
  test('compile in from extensions.local.json, never into a release build, and not once edited', async () => {
    const files = fixtureFiles();
    const repo = sourceRepo(files);
    const root = checkoutRoot();
    const entry = entryFor(repo, files);
    const report = await checkEntry(entry, { from: repo.dir, root, typecheck: false, keepStaged: true });
    expect(report.problems).toEqual([]);
    commitVendored(entry, report.staged!, 'registry/index.json', root);
    expect(readLocal(root)).toEqual({
      compile: ['hello-registry'],
      vendored: { 'hello-registry': { repo: entry.source.repo, commit: repo.commit, path: 'ext', sha256: entry.sha256, index: 'registry/index.json' } },
    });

    const operator = buildExtensions(root);
    expect(operator.status, operator.stderr).toBe(0);
    const ui = readFileSync(join(root, 'build/extensions.ui.ts'), 'utf8');
    expect(ui).toContain('from "../extensions-vendor/hello-registry/ui/index.tsx"');
    expect(ui).toContain('from "../extensions/inspect/ui/index.tsx"');
    expect(readFileSync(join(root, 'build/extensions.names.ts'), 'utf8')).toContain('"hello-registry"');
    expect(readFileSync(join(root, 'build/extensions.server.ts'), 'utf8')).not.toContain('hello-registry');

    const release = buildExtensions(root, { BLYG_EXTENSIONS_SHIPPED_ONLY: '1' });
    expect(release.status, release.stderr).toBe(0);
    expect(readFileSync(join(root, 'build/extensions.ui.ts'), 'utf8')).not.toContain('extensions-vendor');
    expect(readFileSync(join(root, 'build/extensions.names.ts'), 'utf8')).toContain('["inspect","reading-time"]');
    // The browser suite's "all" means the catalogue, never a vendored extension.
    const all = buildExtensions(root, { BLYG_EXTENSIONS: 'all' });
    expect(readFileSync(join(root, 'build/extensions.ui.ts'), 'utf8'), all.stderr).not.toContain('extensions-vendor');

    writeFileSync(join(root, 'extensions-vendor/hello-registry/ui/greeting.ts'), 'export const greeting = () => "edited";\n');
    const edited = buildExtensions(root);
    expect(edited.status).toBe(1);
    expect(edited.stderr).toMatch(/extensions-vendor\/hello-registry has changed since it was vendored/);

    expect(removeVendored('hello-registry', root)).toBe(true);
    expect(existsSync(join(root, 'extensions-vendor/hello-registry'))).toBe(false);
    expect(readLocal(root)).toEqual({ compile: [] });
  });

  test('the CLI shows what it will vendor and will not proceed unreviewed without --yes', () => {
    const files = fixtureFiles();
    const repo = sourceRepo(files);
    const root = checkoutRoot();
    mkdirSync(join(root, 'registry'));
    writeFileSync(join(root, 'registry/index.json'), JSON.stringify({ version: 1, extensions: [entryFor(repo, files)] }));
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, ['--import', TSX, join(REPO, 'scripts/ext-vendor.ts'), ...args], { cwd: root, encoding: 'utf8', input: '' });

    const unreviewed = cli('add', 'hello-registry', '--from', repo.dir);
    expect(unreviewed.status).toBe(1);
    expect(unreviewed.stdout).toContain(`source    https://example.invalid/hello-registry.git @ ${repo.commit} : ext`);
    expect(unreviewed.stdout).toContain('ui/index.tsx');
    expect(unreviewed.stdout).toContain("runs with the owner's session");
    expect(unreviewed.stderr).toContain('re-run with --yes');
    expect(existsSync(join(root, 'extensions.local.json'))).toBe(false);

    const added = cli('add', 'hello-registry', '--from', repo.dir, '--yes');
    expect(added.status, added.stderr).toBe(0);
    expect(existsSync(join(root, 'extensions-vendor/hello-registry/ui/index.tsx'))).toBe(true);
    expect(readLocal(root).vendored?.['hello-registry']?.commit).toBe(repo.commit);
    expect(cli('update', 'hello-registry', '--from', repo.dir).stdout).toContain('is current');
    expect(cli('remove', 'hello-registry').status).toBe(0);
    expect(existsSync(join(root, 'extensions-vendor/hello-registry'))).toBe(false);
  }, 60_000);

  test('extensions-vendor/ is gitignored and nothing in it is tracked', () => {
    const ignored = spawnSync('git', ['check-ignore', '-q', 'extensions-vendor/anything/ui/index.tsx'], { cwd: REPO });
    expect(ignored.status).toBe(0);
    expect(execFileSync('git', ['ls-files', 'extensions-vendor'], { cwd: REPO, encoding: 'utf8' })).toBe('');
  });
});

test('the browse page is static, escaped, and offers no code to a Studio', () => {
  const entry = entryFor({ commit: 'c'.repeat(40) }, { 'ui/index.tsx': '' }, { description: '<script>alert(1)</script>' });
  const html = renderSite({ version: 1, extensions: [entry] });
  expect(html).not.toContain('<script');
  expect(html).toContain('&#60;script&#62;alert(1)&#60;/script&#62;');
  expect(html).toContain('npm run ext:add -- hello-registry');
  expect(renderSite({ version: 1, extensions: [] })).toContain('No extensions are listed yet.');
});
