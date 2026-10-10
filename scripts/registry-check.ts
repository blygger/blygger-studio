// npm run registry:check — validate the extension registry index
// (docs/extension-registry.md). PROPOSAL, pending Venkat's ruling.
//
// Run on every submission PR to registry/index.json. For each entry it checks
// the schema, the name (unique, not an extension in this repository), the
// pinned commit's format and the Studio range, then fetches the commit and
// checks the tree hash, that it is browser-only, the import boundary, and that
// it typechecks against the extension API. It prints the review flags a human
// reviewer must look at; passing this check is necessary, not sufficient.
//
//   npm run registry:check                     everything (fetches each entry's source)
//   npm run registry:check -- --offline        no network: schema, names, ranges, schema file
//   npm run registry:check -- --index <path|url> [--from <name>=<mirror>]…
//   npm run registry:schema                    rewrite registry/index.schema.json
//
// CI runs --offline, which needs no network.
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_INDEX, checkEntry, loadIndex, reservedNames, satisfies, studioVersion } from "./registry-lib.ts";
import { jsonSchema } from "./registry-schema.ts";

const SCHEMA_FILE = "registry/index.schema.json";
const args = process.argv.slice(2);
const value = (flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const schemaText = `${JSON.stringify(jsonSchema(), null, 2)}\n`;

if (args.includes("--write-schema")) {
  writeFileSync(SCHEMA_FILE, schemaText);
  console.log(`registry: wrote ${SCHEMA_FILE}`);
  process.exit(0);
}

const problems: string[] = [];
const offline = args.includes("--offline");
const indexSource = value("--index") ?? DEFAULT_INDEX;
const mirrors = new Map(args.flatMap((arg, i) => (args[i - 1] === "--from" ? [arg.split(/=(.*)/s).slice(0, 2) as [string, string]] : [])));

if (indexSource === DEFAULT_INDEX && readFileSync(SCHEMA_FILE, "utf8") !== schemaText) problems.push(`${SCHEMA_FILE} is stale; run npm run registry:schema`);

let index;
try {
  index = await loadIndex(indexSource);
} catch (e) {
  console.error(`registry: ${indexSource} is invalid:\n${(e as Error).message}`);
  process.exit(1);
}
const reserved = reservedNames();
const version = studioVersion();
for (const entry of index.extensions) {
  const where = `${entry.name}:`;
  if (reserved.has(entry.name)) problems.push(`${where} the name of an extension in this repository`);
  if (!satisfies(version, entry.studio)) console.warn(`registry: ${where} targets Studio ${entry.studio}, not this checkout (${version}); typechecked anyway`);
  if (offline) continue;
  try {
    const report = await checkEntry(entry, { from: mirrors.get(entry.name), checkStudioVersion: false });
    problems.push(...report.problems.map((problem) => `${where} ${problem}`));
    for (const flag of report.flags) console.log(`registry: ${where} review: ${flag}`);
    if (!report.problems.length) console.log(`registry: ${where} ok (${report.files.length} files, tree ${report.hash.slice(0, 12)})`);
  } catch (e) {
    problems.push(`${where} ${(e as Error).message}`);
  }
}
if (problems.length) {
  console.error(`registry: ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`registry: ${indexSource} ok, ${index.extensions.length} entr${index.extensions.length === 1 ? "y" : "ies"}${offline ? " (offline: sources not fetched)" : ""}`);
