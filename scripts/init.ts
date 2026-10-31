// `npm run init` — stand up a new blyg on Cloudflare.
//
// Interactive, idempotent and resumable: every step checks before it creates,
// and a second run after a failure reports what already exists rather than
// provisioning a duplicate. Progress is recorded in `.blyg-init.json`, but the
// real source of truth is Cloudflare itself — the marker only saves round
// trips.
//
// Runs under `node --experimental-strip-types` (Node 22+); no dependencies.
//
// ── On secrets ───────────────────────────────────────────────────────────────
// This script never reads, echoes, stores or transmits your owner password. It
// shells out to `wrangler secret put` and lets *wrangler* do the prompting, so
// the plaintext never enters this process, this repo, or your shell history.
// The one value it does generate is COOKIE_SECRET — random bytes, piped
// straight to wrangler on stdin and never written down — because a signing key
// a human invented is a worse key, and asking you to think one up is asking
// for the wrong thing.
//
// ── On accounts ──────────────────────────────────────────────────────────────
// You are asked to pick an account explicitly, even when you only have one.
// Deploying to the wrong Cloudflare account is a real failure mode with an
// incident behind it (2026-09-12-01), and it is silent: the deploy succeeds,
// against infrastructure you did not mean. Nothing here is inferred.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { initConfig } from "./init-config.ts";

const root = path.join(import.meta.dirname, "..");
const MARKER = path.join(root, ".blyg-init.json");
const CONFIG = path.join(root, "wrangler.jsonc");
const TARGETS = path.join(root, "deploy-targets.json");

const rl = createInterface({ input: stdin, output: stdout });

function die(msg: string): never {
  console.error(`\n✘ ${msg}`);
  rl.close();
  process.exit(1);
}

/** Run wrangler and capture output. Never given a secret as an argument. */
function wrangler(args: string[], env: Record<string, string> = {}) {
  return spawnSync("npx", ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** Run wrangler attached to the terminal, so it can prompt for itself. */
function wranglerInteractive(args: string[], env: Record<string, string> = {}) {
  return spawnSync("npx", ["wrangler", ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

type Marker = {
  accountId?: string;
  accountLabel?: string;
  zone?: string;
  host?: string;
  siteUrlSet?: boolean;
  slug?: string;
  databaseId?: string;
  databaseName?: string;
  bucketName?: string;
  migrationsApplied?: boolean;
  secretsSet?: boolean;
};

const marker: Marker = existsSync(MARKER) ? JSON.parse(readFileSync(MARKER, "utf8")) : {};
const save = () => writeFileSync(MARKER, `${JSON.stringify(marker, null, 2)}\n`);

async function ask(question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback || "";
}

async function confirm(question: string): Promise<boolean> {
  const a = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase();
  return a === "y" || a === "yes";
}

console.log(`
┌─ blygger studio — init ─────────────────────────────────────────────────┐
│ Provisions a blyg on your own Cloudflare account: a D1 database, an R2  │
│ bucket, this Worker, and a subdomain pointed at it.                     │
│                                                                         │
│ You need: a Cloudflare account, and a domain already on it (its zone    │
│ must exist — this script will not register a domain for you).           │
│                                                                         │
│ Safe to re-run. Nothing here is destructive.                            │
└─────────────────────────────────────────────────────────────────────────┘
`);

// ── 1. Authentication ────────────────────────────────────────────────────────

if (process.env.CLOUDFLARE_API_TOKEN) {
  die(
    `CLOUDFLARE_API_TOKEN is set, and an env token silently overrides your\n` +
      `  wrangler login session — including which account you are on. Unset it and\n` +
      `  re-run:  unset CLOUDFLARE_API_TOKEN`,
  );
}

const who = wrangler(["whoami"]);
if (who.status !== 0) {
  die(`not logged in. Run:  npx wrangler login\n\n${who.stderr ?? ""}`);
}

// ── 2. Account: picked, never inferred ───────────────────────────────────────

/** Parse the account table `wrangler whoami` prints. */
function parseAccounts(out: string): { name: string; id: string }[] {
  const found: { name: string; id: string }[] = [];
  for (const line of out.split("\n")) {
    // Table rows look like: │ Some Account │ 0123456789abcdef… │
    const m = /^[│|]\s*(.+?)\s*[│|]\s*([0-9a-f]{32})\s*[│|]/.exec(line.trim());
    if (m) found.push({ name: m[1], id: m[2] });
  }
  return found;
}

const accounts = parseAccounts(`${who.stdout ?? ""}`);
if (!accounts.length) die(`could not read any account from \`wrangler whoami\`:\n\n${who.stdout ?? ""}`);

if (!marker.accountId) {
  console.log("Cloudflare accounts you can reach:\n");
  accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.name}   ${a.id}`));
  console.log(
    accounts.length === 1
      ? "\nOnly one — but confirm it anyway. A deploy to the wrong account is silent.\n"
      : "\n",
  );
  const pick = await ask(`Which account? 1-${accounts.length}`, "1");
  const chosen = accounts[Number(pick) - 1];
  if (!chosen) die(`"${pick}" is not one of the options.`);
  marker.accountId = chosen.id;
  marker.accountLabel = chosen.name;
  save();
}
console.log(`\n→ account: ${marker.accountLabel} (${marker.accountId})`);
const ACCOUNT = { CLOUDFLARE_ACCOUNT_ID: marker.accountId! };

// ── 3. Where the blyg lives ──────────────────────────────────────────────────

if (!marker.host) {
  console.log(`
This setup creates a blyg on its own subdomain, such as blyg.yourdomain.com.
Path mounts are also supported: their Studio and API live below the mount.
They need matching forwarding routes, so init leaves that configuration to you.
`);
  const domain = await ask("Your domain (the zone, e.g. example.com)");
  if (!domain || !domain.includes(".")) die("that does not look like a domain.");
  const label = await ask("Subdomain label", "blyg");
  marker.zone = domain;
  marker.host = `${label}.${domain}`;
  marker.slug = marker.host.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  save();
}
console.log(`→ blyg: https://${marker.host}/`);

// Verify the zone is actually on the chosen account, now rather than at deploy
// time, where the same mistake surfaces as a confusing routing error.
const zones = wrangler(["zones", "list"], ACCOUNT);
if (zones.status === 0 && `${zones.stdout}`.trim() && !`${zones.stdout}`.includes(marker.zone!)) {
  console.log(
    `\n! ${marker.zone} was not in this account's zone list. That is often a\n` +
      `  stale cache or a wrangler version without \`zones list\`, so this is a\n` +
      `  warning rather than a stop — but if the deploy fails on routing, this\n` +
      `  is why: the domain must be on the account you picked.\n`,
  );
}

// ── 4. D1 ────────────────────────────────────────────────────────────────────

marker.databaseName ??= `blyg-${marker.slug}`;
if (!marker.databaseId) {
  console.log(`\n— creating D1 database ${marker.databaseName}`);
  const created = wrangler(["d1", "create", marker.databaseName], ACCOUNT);
  const out = `${created.stdout ?? ""}${created.stderr ?? ""}`;
  let id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(out)?.[1];
  if (!id) {
    // Already exists (a re-run, or you made it by hand) — find it rather than
    // failing, which is what makes this script safe to run twice.
    const list = wrangler(["d1", "list", "--json"], ACCOUNT);
    try {
      const rows = JSON.parse(`${list.stdout}`) as { name: string; uuid: string }[];
      id = rows.find((r) => r.name === marker.databaseName)?.uuid;
    } catch {
      /* fall through to the error below */
    }
  }
  if (!id) die(`could not create or find D1 database ${marker.databaseName}:\n${out}`);
  marker.databaseId = id;
  save();
}
console.log(`→ D1: ${marker.databaseName} (${marker.databaseId})`);

// ── 5. R2 ────────────────────────────────────────────────────────────────────

marker.bucketName ??= `blyg-${marker.slug}-media`;
{
  // Always attempted: `r2 bucket create` on an existing bucket is a no-op we
  // can detect, and that is cheaper than tracking a flag that could disagree
  // with Cloudflare.
  const made = wrangler(["r2", "bucket", "create", marker.bucketName], ACCOUNT);
  const out = `${made.stdout ?? ""}${made.stderr ?? ""}`;
  if (made.status !== 0 && !/already (exists|owned)/i.test(out)) {
    console.log(`! could not create R2 bucket ${marker.bucketName}. Image attachments will fail\n  until it exists; everything else works. Continuing.\n${out}`);
  }
  save();
}
console.log(`→ R2: ${marker.bucketName}`);

// ── 6. Write the config ──────────────────────────────────────────────────────

const config = initConfig({
  slug: marker.slug!,
  accountId: marker.accountId!,
  host: marker.host!,
  databaseName: marker.databaseName!,
  databaseId: marker.databaseId!,
  bucketName: marker.bucketName!,
});
writeFileSync(CONFIG, config);
console.log(`\n→ wrote wrangler.jsonc`);

const targets = {
  $note: [
    "Your live deployments. Gitignored — a manifest of what you run is yours.",
    "`npm run deploy:all` cross-checks each account against wrangler.jsonc before",
    "deploying, checks for unapplied migrations, and verifies the URLs below after.",
    "No secret values here, ever: only the names of secrets and where they live.",
  ],
  targets: [
    {
      env: "",
      label: `My blyg at ${marker.host}`,
      worker: `blyg-${marker.slug}`,
      account_id: marker.accountId,
      account_label: marker.accountLabel,
      base: `https://${marker.host}/`,
      credentials: {
        registry: "Cloudflare Worker secrets (wrangler secret put)",
        worker_secrets: ["OWNER_PASSWORD", "COOKIE_SECRET", "AI_PROVIDER_KEY"],
        note: "Names, not values. AI_PROVIDER_KEY is optional — it powers [TK] generation only.",
      },
      verify: [
        { path: "blyg.json", status: 200, contains: '"blyg"' },
        { path: "feed.xml", status: 200, contains: "<rss" },
        { path: "items/index.json", status: 200 },
      ],
    },
  ],
};
writeFileSync(TARGETS, `${JSON.stringify(targets, null, 2)}\n`);
console.log(`→ wrote deploy-targets.json`);

// ── 7. Migrations ────────────────────────────────────────────────────────────

if (!marker.migrationsApplied) {
  console.log(`\n— applying database migrations`);
  const applied = wranglerInteractive(["d1", "migrations", "apply", "DB", "--remote"], ACCOUNT);
  if (applied.status !== 0) die("migrations failed. Nothing is broken — fix the error above and re-run `npm run init`.");
  marker.migrationsApplied = true;
  save();
}
console.log(`→ schema applied`);

// ── 7b. The one setting worth writing for you ────────────────────────────────
//
// `site_url` is the deployment's own address, and this script is the only place
// that knows it without being told twice. Writing it here buys two things:
// absolute URLs are right from the first publish, and the blyg's **title**
// defaults to the host rather than to the word "blyg".
//
// That second one is not cosmetic. The client shipped `"blyg"` as its default
// title, so every operator who never opened Settings published under the same
// name — by session 29 two independent live nodes were doing exactly that, and
// the directory listed both as "blyg". A generic default manufactures
// collisions; the address does not, because it is already unique.
//
// Idempotent, and never overwrites a choice: re-running init on an existing
// blyg leaves a title the operator has since set alone.
if (!marker.siteUrlSet) {
  const siteUrl = `https://${marker.host}/`;
  const sql =
    `INSERT INTO settings (key, value) VALUES ('site_url', '${siteUrl}') ` +
    `ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value = '';`;
  const set = spawnSync("npx", ["wrangler", "d1", "execute", "DB", "--remote", "--command", sql], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...ACCOUNT },
  });
  // Not fatal. The blyg works without it — every URL still resolves from the
  // request — and failing a provisioning run over a convenience would be the
  // wrong trade.
  if (set.status === 0) {
    marker.siteUrlSet = true;
    save();
    console.log(`→ site_url set to ${siteUrl} (your blyg will title itself "${marker.host!.replace(/^blyg\./i, "")}" until you change it)`);
  } else {
    console.log(`  (could not write site_url — set it in Settings once you are in; not a problem)`);
  }
}

// ── 8. Secrets ───────────────────────────────────────────────────────────────

if (!marker.secretsSet) {
  console.log(`
— secrets

  Wrangler will prompt for your OWNER_PASSWORD. This script never sees it.
  It is the only credential your blyg has: it logs you into the studio, and
  anything you hand it to (an editor plugin, a shortcut) gets full control.
  Per-tool tokens with scopes are coming; until then, choose accordingly.
`);
  const pw = wranglerInteractive(["secret", "put", "OWNER_PASSWORD"], ACCOUNT);
  if (pw.status !== 0) die("could not set OWNER_PASSWORD.");

  // Generated, not asked for: this signs your session cookie, and a key a human
  // invented is a worse key. Piped on stdin so it is never an argv entry (which
  // is world-readable in `ps`), never logged, never written to disk.
  const cookieSecret = randomBytes(32).toString("base64url");
  const res = spawnSync("npx", ["wrangler", "secret", "put", "COOKIE_SECRET"], {
    cwd: root,
    input: `${cookieSecret}\n`,
    encoding: "utf8",
    env: { ...process.env, ...ACCOUNT },
  });
  if (res.status !== 0) die(`could not set COOKIE_SECRET:\n${res.stderr ?? ""}`);
  console.log("→ COOKIE_SECRET generated and set (32 random bytes; not shown, not stored)");

  marker.secretsSet = true;
  save();

  console.log(`
  Optional: AI_PROVIDER_KEY powers [TK] instructed generation. A blyg without
  one works completely — every other feature is unaffected.`);
  if (await confirm("  Set AI_PROVIDER_KEY now?")) {
    wranglerInteractive(["secret", "put", "AI_PROVIDER_KEY"], ACCOUNT);
  }
}

// ── 9. Done ──────────────────────────────────────────────────────────────────

console.log(`
┌─ ready ─────────────────────────────────────────────────────────────────┐

  npm run deploy

  Then open   https://${marker.host}/studio
  and log in with the password you just set.

  First things to do there:
    • Settings — your blyg's title and your name. These appear in your
      manifest and your feed, so other people's readers show them.
    • Subscriptions — add a few feeds. A blyg with nothing to read is a
      room with no doors; any RSS or Atom feed works, not just other blygs.
    • Compose — publish something. It is a fragment by default; threads are
      the long form.

  When it looks the way you want:

    • Tell the directory: https://blygger.com — paste your URL and it runs
      the real resolution algorithm against you, so it doubles as a
      conformance check. Listing is suggested, never required: nothing about
      the protocol needs a registry, and a blyg nobody has heard of works
      exactly as well as a listed one. It is how people find you, that is all.

  Upgrading later:  npm run upgrade
  Taking it elsewhere:  npm run export  (your whole blyg as static files)

└─────────────────────────────────────────────────────────────────────────┘
`);

rl.close();
