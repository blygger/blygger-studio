// Which of Check's slow jobs a change needs (ROADMAP row 55, session 45).
//
// The mutation suites take most of a Check run (auth-security alone ~13 min),
// and their failures in CI have all been PRs moving the exact code a mutant
// targets. So each suite runs when a PR touches a file it mutates, a test it
// runs, or the suite's own script. The targets are read from the suites' own
// `file:` and `test:` fields, never listed here, so a new mutant widens the
// trigger by itself. e2e runs for any change outside the docs.
//
// The backstop for indirect breakage (a shared helper no suite names): pushes
// to main and manual runs get every job, and Release requires that green run.
//
// Usage: node --import tsx scripts/ci-scope.ts <event> [base-ref]
// Writes `e2e=true|false` and `mutations=<json list>` to $GITHUB_OUTPUT (or stdout).
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

// Matrix entries in check.yml. auth-security is split along the script's own
// --browser / --exclude-browser selectors so its two halves run side by side.
const suites = {
  oracle: "scripts/verify-oracle-mutations.ts",
  "polling-cache": "scripts/verify-polling-cache-mutations.ts",
  "auth-security-worker": "scripts/verify-auth-security-mutations.ts",
  "auth-security-browser": "scripts/verify-auth-security-mutations.ts",
} as const;
// Shared by every suite: a change here can break any of them.
const everything = [
  /^package(-lock)?\.json$/, /^\.github\/workflows\//, /^scripts\/ci-scope\.ts$/,
  /^vitest(\.ui)?\.config\.ts$/, /^tsconfig.*\.json$/, /^wrangler\.jsonc$/, /^migrations\//,
];
const docsOnly = [/\.md$/, /^docs\//, /^LICENSE$/, /^\.github\/ISSUE_TEMPLATE\//];

export function targets(script: string): Set<string> {
  // Auth-security also mutates through the auth-oracle script it imports.
  const sources = [script, ...(script.includes("auth-security") ? ["scripts/verify-auth-oracle-mutations.ts", "scripts/verify-auth-security-race.ts"] : [])];
  const found = new Set<string>(sources);
  for (const s of sources) {
    for (const m of readFileSync(s, "utf8").matchAll(/\b(?:file|test):\s*(['"])((?:src|test|test-ui|e2e)\/[^'"]+)\1/g)) found.add(m[2]);
  }
  return found;
}

export function scope(changed: string[] | "all") {
  const names = Object.keys(suites) as (keyof typeof suites)[];
  if (changed === "all") return { e2e: true, mutations: names };
  const shared = changed.some((f) => everything.some((r) => r.test(f)));
  return {
    e2e: changed.some((f) => !docsOnly.some((r) => r.test(f))),
    mutations: names.filter((n) => shared || changed.some((f) => targets(suites[n]).has(f))),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [event, base] = process.argv.slice(2);
  const changed = event === "pull_request" && base
    ? execFileSync("git", ["diff", "--name-only", `origin/${base}...HEAD`], { encoding: "utf8" }).split("\n").filter(Boolean)
    : "all";
  const result = scope(changed);
  const out = `e2e=${result.e2e}\nmutations=${JSON.stringify(result.mutations)}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
  process.stdout.write((changed === "all" ? "all jobs (not a pull request)\n" : `${changed.length} changed file(s)\n`) + out);
}
