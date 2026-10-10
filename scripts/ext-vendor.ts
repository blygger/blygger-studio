// npm run ext:add | ext:update | ext:remove (docs/extension-registry.md).
//
// PROPOSAL, pending Venkat's ruling. Vendors a registry extension's pinned,
// browser-only source into the gitignored extensions-vendor/<name>/ and records
// it in the gitignored extensions.local.json, so `npm run build` compiles it in.
// Nothing is fetched or evaluated by a Studio at run time, and nothing
// third-party is committed or reaches a release build.
//
//   npm run ext:add -- <name> [--index <path|https-url>] [--from <mirror>] [--yes]
//   npm run ext:update -- <name> [--index …] [--from …] [--yes]
//   npm run ext:remove -- <name>
//
// --index  where to read the registry index (default registry/index.json)
// --from   fetch the pinned commit from a mirror or local clone instead of the
//          entry's repo; the commit and tree hash are verified all the same
// --yes    skip the review prompt (you have reviewed the source another way)
import { createInterface } from "node:readline/promises";
import { rmSync } from "node:fs";
import { relative } from "node:path";
import { DEFAULT_INDEX, checkEntry, commitVendored, loadIndex, readLocal, removeVendored, treeDiff, vendoredTree } from "./registry-lib.ts";

const fail = (msg: string): never => {
  console.error(`ext: ${msg}`);
  process.exit(1);
};

const [command, ...rest] = process.argv.slice(2);
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg === "--yes" || arg === "-y") flags.set("yes", true);
  else if (arg === "--index" || arg === "--from") flags.set(arg.slice(2), rest[++i] ?? fail(`${arg} needs a value`));
  else if (arg.startsWith("-")) fail(`unknown option ${arg}`);
  else positional.push(arg);
}
const name = positional[0] ?? fail(`usage: npm run ext:${command ?? "add"} -- <name>`);

async function confirm(question: string): Promise<boolean> {
  if (flags.get("yes")) return true;
  if (!process.stdin.isTTY) fail("not a terminal: review the staged source and re-run with --yes");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function vendor(update: boolean) {
  const local = readLocal();
  const lock = local.vendored?.[name];
  if (update && !lock) fail(`"${name}" is not vendored; use npm run ext:add -- ${name}`);
  if (!update && lock) fail(`"${name}" is already vendored at ${lock.commit.slice(0, 12)}; use npm run ext:update -- ${name}`);
  const indexSource = (flags.get("index") as string | undefined) ?? lock?.index ?? DEFAULT_INDEX;
  const index = await loadIndex(indexSource);
  const entry = index.extensions.find((candidate) => candidate.name === name) ?? fail(`"${name}" is not in ${indexSource}`);
  if (update && lock!.commit === entry.source.commit && lock!.sha256 === entry.sha256) {
    console.log(`ext: ${name} is current (${entry.source.commit.slice(0, 12)})`);
    return;
  }
  console.log(`ext: fetching ${entry.source.repo} at ${entry.source.commit}${flags.get("from") ? ` (from ${flags.get("from")})` : ""} …`);
  const report = await checkEntry(entry, { from: flags.get("from") as string | undefined, keepStaged: true });
  if (report.problems.length) fail(`refusing "${name}":\n  - ${report.problems.join("\n  - ")}`);
  const staged = report.staged!;
  const size = report.files.reduce((sum, file) => sum + file.bytes.length, 0);
  console.log(`
  ${entry.label} (${entry.name})
  ${entry.description}
  author    ${entry.author.name}${entry.author.url ? ` <${entry.author.url}>` : ""}
  homepage  ${entry.homepage}
  license   ${entry.license}
  source    ${entry.source.repo} @ ${entry.source.commit}${entry.source.path ? ` : ${entry.source.path}` : ""}
  tree      sha256 ${report.hash} (matches the index)
  studio    ${entry.studio}
  files     ${report.files.length}, ${(size / 1024).toFixed(1)} KB
${report.files.map((file) => `            ${file.path}`).join("\n")}
`);
  if (update) {
    const diff = treeDiff(vendoredTree(name), report.files);
    console.log(`  changes since ${lock!.commit.slice(0, 12)}: ${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed`);
    for (const [label, paths] of Object.entries(diff)) for (const path of paths) console.log(`            ${label.padEnd(8)}${path}`);
    console.log("");
  }
  console.log(
    report.flags.length
      ? `  For review (not refusals; the extension runs with the owner's session):\n${report.flags.map((flag) => `    - ${flag}`).join("\n")}\n`
      : "  For review: nothing flagged. Read it anyway; the extension runs with the owner's session.\n",
  );
  console.log(`  The source is staged for review at ${relative(process.cwd(), staged)}/`);
  console.log("  An extension's UI can call any owner operation, writes included (docs/extensions.md, \"Security model\").\n");
  if (!(await confirm(`Vendor ${name} into extensions-vendor/${name}/ and compile it in?`))) {
    rmSync(staged, { recursive: true, force: true });
    fail("not vendored");
  }
  commitVendored(entry, staged, indexSource);
  console.log(`ext: vendored ${name}. Run npm run build (or deploy), then turn it on in Settings → extensions.`);
}

switch (command) {
  case "add":
    await vendor(false);
    break;
  case "update":
    await vendor(true);
    break;
  case "remove":
    if (!removeVendored(name)) fail(`"${name}" is not vendored`);
    console.log(`ext: removed ${name} from extensions-vendor/ and extensions.local.json. Its Settings toggle now does nothing.`);
    break;
  default:
    fail("usage: ext-vendor.ts add|update|remove <name>");
}
