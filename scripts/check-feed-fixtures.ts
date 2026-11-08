// The pace-layered fixtures live in blygger-spec (RFC-3 R4, decision #97):
// conformance/feeds/ is where another client finds them, and it is the
// canonical copy. The studio cannot read another repository at build time, so
// it keeps its own copy in test/fixtures/feeds/ and this check says the two are
// identical, file for file, byte for byte. CI only (like check:template): it
// needs the network, and an operator's `npm test` must not.
import { readdirSync, readFileSync } from "node:fs";

const RAW = "https://raw.githubusercontent.com/blygger/blygger-spec/main/conformance/feeds/";
const LISTING = "https://api.github.com/repos/blygger/blygger-spec/contents/conformance/feeds";

const local = readdirSync("test/fixtures/feeds").filter((f) => f.endsWith(".json")).sort();
const listing = await fetch(LISTING, { headers: { accept: "application/vnd.github+json", "user-agent": "blygger-studio check:fixtures" } });
if (!listing.ok) throw new Error(`could not list blygger-spec conformance/feeds: ${listing.status}`);
const canonical = ((await listing.json()) as { name: string }[]).map((f) => f.name).filter((n) => n.endsWith(".json")).sort();

const problems: string[] = [];
for (const name of canonical.filter((n) => !local.includes(n))) problems.push(`missing here: ${name}`);
for (const name of local.filter((n) => !canonical.includes(n))) problems.push(`not in blygger-spec: ${name}`);
for (const name of local.filter((n) => canonical.includes(n))) {
  const remote = await fetch(RAW + name);
  if (!remote.ok) throw new Error(`could not fetch ${name}: ${remote.status}`);
  if ((await remote.text()) !== readFileSync(`test/fixtures/feeds/${name}`, "utf8")) problems.push(`differs: ${name}`);
}
if (problems.length) {
  console.error(`test/fixtures/feeds/ must match blygger-spec conformance/feeds/ (RFC-3 R4):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`check:fixtures: ${local.length} feed fixtures match blygger-spec`);
