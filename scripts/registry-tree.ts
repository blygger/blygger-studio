// The registry's tree hash (docs/extension-registry.md, "The tree hash").
//
// One line per regular file, `<sha256 of its bytes>  <path relative to the
// tree>\n`, sorted by path, and the sha256 of those lines joined. It is what
// `sha256sum` prints for each file, so it can be reproduced without this repo:
//
//   cd <tree> && find . -type f | sed 's|^\./||' | LC_ALL=C sort \
//     | while read -r f; do sha256sum "$f"; done | sha256sum
//
// Paths are restricted to ASCII (scripts/registry-lib.ts refuses anything
// else), so JavaScript's sort order is the same as LC_ALL=C's.
//
// Kept apart from registry-lib.ts because scripts/build-extensions.ts uses it
// on every build, to refuse a vendored tree that no longer matches its lock.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TreeFile {
  path: string;
  bytes: Uint8Array;
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export function treeHash(files: readonly TreeFile[]): string {
  const lines = files
    .map((file) => `${sha256(file.bytes)}  ${file.path}\n`)
    .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : a.slice(66) > b.slice(66) ? 1 : 0));
  return sha256(lines.join(""));
}

/** Every regular file under `root`, relative paths with forward slashes. A symlink or other special file is an error. */
export function readTree(root: string): TreeFile[] {
  const out: TreeFile[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full, rel);
      else if (stat.isFile()) out.push({ path: rel, bytes: readFileSync(full) });
      else throw new Error(`${rel}: not a regular file or directory`);
    }
  };
  walk(root, "");
  return out;
}

export const hashDirectory = (root: string) => treeHash(readTree(root));
