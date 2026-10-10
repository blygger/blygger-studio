// npm run registry:hash -- <repo> <commit> [path]
//
// Prints the tree hash an index entry's `sha256` must carry (docs/extension-
// registry.md, "Submitting an extension"), read from git objects at exactly
// that commit, so untracked or ignored files in a working copy never count.
// <repo> is an https:// URL, a file:// URL or an absolute path to a clone.
import { fetchTree } from "./registry-lib.ts";
import { COMMIT, SUBDIR } from "./registry-schema.ts";
import { treeHash } from "./registry-tree.ts";

const [repo, commit, path = ""] = process.argv.slice(2);
if (!repo || !commit) {
  console.error("usage: npm run registry:hash -- <repo> <full commit id> [subdirectory]");
  process.exit(1);
}
if (!COMMIT.test(commit) || !SUBDIR.test(path)) {
  console.error("registry:hash: the commit must be a full lowercase id and the path a relative subdirectory");
  process.exit(1);
}
const files = fetchTree({ repo, commit, path }, { from: repo });
for (const file of files) console.log(`  ${file.path}`);
console.log(treeHash(files));
