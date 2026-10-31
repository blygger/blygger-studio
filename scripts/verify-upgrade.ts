// Run the actual 0.8.3 upgrade entry point against a local, synthetic release.
// npm's dependency resolution is offline and reuses installed dependencies;
// its postinstall build, tsc gate, and a real SDK/Worker smoke suite still run.
// No Wrangler provisioning, signing credentials, network fetch, or deploy.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve("."), temp = mkdtempSync(join(tmpdir(), "blygger-upgrade-"));
const upstream = join(temp, "upstream"), installed = join(temp, "installed"), bin = join(temp, "bin");
const git = (args: string[], cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
let primaryFailure: unknown;
try {
  git(["rev-parse", "v0.8.3"]);
  git(["clone", "--quiet", "--shared", root, upstream]);
  // The candidate can rename a migration after HEAD. Remove tracked files that
  // the working snapshot deleted, so the fixture does not apply both names.
  for (const file of git(["ls-files", "-z"], upstream).split("\0").filter(Boolean)) {
    if (!existsSync(join(root, file))) rmSync(join(upstream, file));
  }
  const files = [...git(["ls-files", "-z"]).split("\0"), ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(file => /^(src|migrations|test|e2e|scripts|docs)\//.test(file))];
  for (const file of files.filter(Boolean)) if (existsSync(join(root, file))) {
    mkdirSync(dirname(join(upstream, file)), { recursive: true });
    cpSync(join(root, file), join(upstream, file));
  }
  git(["add", "--all"], upstream);
  const tree = git(["write-tree"], upstream);
  // Synthetic fixture commit, never pushed or attached to the user's branch.
  const target = execFileSync("git", ["commit-tree", tree, "-p", git(["rev-parse", "HEAD"], upstream)], { cwd: upstream, encoding: "utf8", input: "Upgrade fixture\n", env: { ...process.env, GIT_AUTHOR_NAME: "Upgrade fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Upgrade fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim();
  git(["tag", "v999.0.0", target], upstream);
  git(["clone", "--quiet", "--branch", "v0.8.3", upstream, installed]);
  git(["remote", "add", "upstream", upstream], installed);
  writeFileSync(join(installed, ".git/info/exclude"), "node_modules\n");
  symlinkSync(join(root, "node_modules"), join(installed, "node_modules"), "dir");
  mkdirSync(bin);
  const localD1 = join(temp, "d1");
  const wranglerCli = join(root, "node_modules/wrangler/bin/wrangler.js");
  // Seed the old schema first. No fixture command can contact remote D1.
  execFileSync(process.execPath, [wranglerCli, "d1", "migrations", "apply", "DB", "--local", "--persist-to", localD1], { cwd: installed, encoding: "utf8", env: { ...process.env, WRANGLER_LOG_PATH: join(temp, "wrangler.log") } });
  const require = createRequire(import.meta.url);
  const npmCli = process.env.npm_execpath ?? require.resolve("npm/bin/npm-cli.js");
  const log = join(temp, "commands.jsonl");
  const shim = `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const tool = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool, args }) + '\\n');
let cmd, forwarded;
if (tool === 'npm' && args[0] === 'install') { cmd = process.execPath; forwarded = [${JSON.stringify(npmCli)}, ...args, '--offline', '--package-lock-only', '--cache', ${JSON.stringify(join(temp, "cache"))}, '--userconfig', ${JSON.stringify(join(temp, "npmrc"))}]; }
else if (tool === 'npm' && args.join(' ') === 'run build') { cmd = process.execPath; forwarded = [${JSON.stringify(npmCli)}, ...args]; }
else if (tool === 'npm' && args[0] === 'test') { cmd = process.execPath; forwarded = ['node_modules/vitest/vitest.mjs', 'run', 'test/sdk.test.ts', '--maxWorkers=2']; }
else if (tool === 'npx' && args.join(' ') === 'wrangler d1 migrations apply DB --remote') { cmd = process.execPath; forwarded = [${JSON.stringify(wranglerCli)}, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', ${JSON.stringify(localD1)}]; }
else if (tool === 'npx' && args[0] === 'tsc') { cmd = process.execPath; forwarded = ['node_modules/typescript/bin/tsc', ...args.slice(1)]; }
else { console.error('Unexpected upgrade command', tool, args); process.exit(1); }
const result = spawnSync(cmd, forwarded, { stdio: 'inherit' }); process.exit(result.status ?? 1);
`;
  for (const tool of ["npm", "npx"]) writeFileSync(join(bin, tool), shim, { mode: 0o755 });
  writeFileSync(join(temp, "npmrc"), "");
  const old = readFileSync(join(installed, "scripts/upgrade.ts"), "utf8");
  assert.ok(!old.includes('run("npm", ["run", "build"])'), "Fixture must run the old script without an explicit build gate");
  let output = "";
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/upgrade.ts"], { cwd: installed, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WRANGLER_LOG_PATH: join(temp, "wrangler.log") } });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Upgrade timed out\n${output}`)); }, 180_000);
    child.stdout.on("data", chunk => { const text = String(chunk); output += text; if (text.includes("Merge these?")) child.stdin.write("y\n"); if (text.includes("Deploy now?")) child.stdin.write("n\n"); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); if (code === 0) resolveRun(); else reject(new Error(`Upgrade exited ${code}\n${output}`)); });
  });
  assert.equal(git(["rev-parse", "HEAD"], installed), target);
  assert.ok(existsSync(join(installed, "sdk/dist/browser.js")), "Old npm install must build the new SDK");
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (const command of ["install", "test"]) assert.ok(calls.some(call => call.tool === "npm" && call.args[0] === command));
  assert.ok(calls.some(call => call.tool === "npx" && call.args[0] === "tsc"));
  assert.ok(calls.some(call => call.tool === "npx" && call.args.join(" ") === "wrangler d1 migrations apply DB --remote"));
  const schema = JSON.parse(execFileSync(process.execPath, [wranglerCli, "d1", "execute", "DB", "--local", "--persist-to", localD1, "--command", "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('signals_poll_order','items_public_order','versions_public_pins','media_item_created','subscriptions_origin') ORDER BY name", "--json"], { cwd: installed, encoding: "utf8", env: { ...process.env, WRANGLER_LOG_PATH: join(temp, "wrangler.log") } }));
  assert.deepEqual(schema[0].results, ["items_public_order", "media_item_created", "signals_poll_order", "subscriptions_origin", "versions_public_pins"].map(name => ({ name })));
  // The old install must acquire the native provider schema and shared limiter,
  // not merely the unrelated content indexes checked above.
  const authTables = ["user", "session", "account", "verification", "jwks", "oauthClient", "oauthResource", "oauthClientResource", "oauthRefreshToken", "oauthAccessToken", "oauthConsent", "oauthClientAssertion", "rateLimit", "oauth_records", "oauth_revocations", "oauth_state", "oauth_authorizations", "security_budgets", "security_registrations"];
  const executeLocal = (command: string) => JSON.parse(execFileSync(process.execPath, [wranglerCli, "d1", "execute", "DB", "--local", "--persist-to", localD1, "--command", command, "--json"], { cwd: installed, encoding: "utf8", env: { ...process.env, WRANGLER_LOG_PATH: join(temp, "wrangler.log") } }))[0].results;
  const upgradedAuth = executeLocal(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${authTables.map(name => `'${name}'`).join(",")}) ORDER BY name`);
  assert.deepEqual(upgradedAuth, [...authTables].sort().map(name => ({ name })));
  const rateColumns = executeLocal('PRAGMA table_info("rateLimit")');
  assert.deepEqual(rateColumns.map((column: { name: string }) => column.name), ["id", "key", "count", "lastRequest"]);
  assert.ok(rateColumns.every((column: { notnull: number }) => column.notnull === 1), "Native limiter columns must be non-null after upgrade");
  const versionColumns = executeLocal('PRAGMA table_info("versions")');
  assert.ok(versionColumns.some((column: { name: string; notnull: number }) => column.name === 'kind' && column.notnull === 0), "Version state must remain nullable for unresolved legacy rows and old Worker inserts");
  const state = executeLocal('SELECT epoch FROM oauth_state WHERE id=1');
  assert.deepEqual(state, [{ epoch: 0 }], "Migration initializes the revoke-all epoch");
  assert.match(output, /When you are ready:  npm run deploy/);
  console.log("0.8.3 upgrade script: local release merge, install build, local migration including native auth/shared limiter, typecheck, SDK/Worker smoke, and declined deploy verified");
} catch (error) { primaryFailure = error; throw error; }
finally {
  try { rmSync(temp, { recursive: true, force: true }); }
  catch (cleanup) {
    if (primaryFailure !== undefined) throw new AggregateError([primaryFailure, cleanup], "Upgrade failed; temporary checkout cleanup also failed", { cause: primaryFailure });
    throw cleanup;
  }
}
