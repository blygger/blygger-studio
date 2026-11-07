// The deploy protocol's safety net: the deploy manifest and the wrangler config
// must agree about which Cloudflare account each target deploys to. Incident
// 2026-09-12-01 was a deploy silently resolving to the wrong account, so these
// tests cover real files, not just the pure functions.
//
// **Session 28 — which real files changed.** The client is now a packaged
// artifact anyone can stand up, so `wrangler.jsonc` is generic and
// `deploy-targets.json` is gitignored: a copy of this repo must name no
// account, database, route or domain of ours. That means the live manifest is
// no longer guaranteed to exist — on a fresh clone, or in anyone else's copy,
// it is simply absent.
//
// The suite is therefore in two halves, and the split is deliberate:
//
//   - **Always** — `crossCheckTarget`'s own behaviour, against fixtures and
//     against the committed example. These are the tests that say the guard
//     works, and they must pass for everybody, including a stranger running
//     `npm test` before their first deploy.
//   - **Only when the private config is present** — the assertion that *our*
//     live targets cross-check clean. This is the half that actually caught
//     the incident, and it still runs for us, on every `npm test`.
//
// The failure mode worth naming: if the second half were simply deleted rather
// than conditioned, nothing would check our own deploys again, and the suite
// would stay green while doing it.
import { describe, expect, it } from "vitest";
import exampleManifest from "../deploy-targets.example.json";
import {
  crossCheckTarget,
  describeVerifyFailure,
  envArgs,
  hasPendingMigrations,
  stripJsonComments,
  verifyUrl,
  wranglerEnv,
  type DeployTarget,
} from "../scripts/deploy-lib.ts";
import wranglerRaw from "../wrangler.jsonc?raw";

const wranglerConfig = JSON.parse(stripJsonComments(wranglerRaw));

/**
 * Read the two gitignored files *if they exist*, via `import.meta.glob`.
 *
 * Not `node:fs`. The first attempt used `existsSync` and silently disabled the
 * live half: inside the Workers test pool `import.meta.dirname` resolves to the
 * right directory but the filesystem is sandboxed, so `existsSync` returns
 * false for a file that is plainly there — and `describe.runIf(false)` skips
 * without failing. The suite would have gone green while checking nothing,
 * which is the precise failure this file exists to prevent.
 *
 * `import.meta.glob` is resolved by Vite at transform time: present files are
 * inlined as strings, an absent one yields an empty object rather than a build
 * error. So it works inside the sandbox, and it works in a copy of this repo
 * where neither file exists.
 */
const globbed = (pattern: Record<string, unknown>): string | null => {
  const hit = Object.values(pattern)[0];
  return typeof hit === "string" ? hit : null;
};
const privateRaw = globbed(
  import.meta.glob("../wrangler.private.jsonc", { query: "?raw", import: "default", eager: true }),
);
const liveRaw = globbed(
  import.meta.glob("../deploy-targets.json", { query: "?raw", import: "default", eager: true }),
);
const havePrivate = privateRaw !== null && liveRaw !== null;

const privateConfig = privateRaw ? JSON.parse(stripJsonComments(privateRaw)) : null;
const liveTargets: DeployTarget[] = liveRaw ? (JSON.parse(liveRaw).targets as DeployTarget[]) : [];

// The example is the fixture the always-on tests use, so it has to be a real,
// parseable manifest rather than prose with braces around it.
const targets = exampleManifest.targets as unknown as DeployTarget[];

describe("stripJsonComments", () => {
  it("strips line and block comments", () => {
    expect(JSON.parse(stripJsonComments('{ // hi\n "a": 1 /* there */ }'))).toEqual({ a: 1 });
  });

  it("does not corrupt the // inside string literals", () => {
    // The bug this guards: wrangler.jsonc is full of URLs and route patterns.
    const src = '{ "url": "https://example.com/blyg", "p": "a.com/x/*" }';
    expect(JSON.parse(stripJsonComments(src))).toEqual({ url: "https://example.com/blyg", p: "a.com/x/*" });
  });

  it("handles escaped quotes before a comment", () => {
    expect(JSON.parse(stripJsonComments('{ "a": "say \\"hi\\"" } // done'))).toEqual({ a: 'say "hi"' });
  });

  it("parses the real wrangler.jsonc", () => {
    // Only that it parses: on an operator's install this file is their own
    // deployment, which is correct (studio#1). That the *repository* ships the
    // template is checked in CI by scripts/check-template.ts.
    expect(typeof wranglerConfig.name).toBe("string");
  });
});

describe("the shipped artifact names nobody's deployment", () => {
  // The packaging requirement, asserted rather than trusted to review. The
  // committed wrangler.jsonc half lives in scripts/check-template.ts (CI only),
  // because an operator's install legitimately holds their own (studio#1).
  it("commits no real hostname in the example manifest", () => {
    const serialized = JSON.stringify(exampleManifest);
    for (const ours of ["venkateshrao", "protocol-institute", "blygger.com"]) {
      expect(serialized.toLowerCase()).not.toContain(ours);
    }
  });

  it("the example manifest stores no secret values, only pointers", () => {
    const serialized = JSON.stringify(exampleManifest);
    for (const marker of ["PASSWORD=", "SECRET=", "sk-ant", "-----BEGIN"]) {
      expect(serialized).not.toContain(marker);
    }
    for (const t of targets) {
      expect(t.credentials?.registry).toBeTruthy();
      for (const name of t.credentials?.worker_secrets ?? []) {
        expect(name).toMatch(/^[A-Z0-9_]+$/);
      }
    }
  });
});

// The half that caught incident 2026-09-12-01. Runs only where the private
// config exists — for us, that is every `npm test`.
describe.runIf(havePrivate)("our own live targets still cross-check", () => {
  it("lists the live nodes", () => {
    expect(liveTargets.length).toBeGreaterThan(0);
  });

  it("every live target cross-checks clean against the private config", () => {
    for (const target of liveTargets) {
      expect(crossCheckTarget(target, privateConfig), target.env).toEqual([]);
    }
  });

  it("every live target pins an account_id in the private config", () => {
    for (const target of liveTargets) {
      expect(wranglerEnv(privateConfig, target.env)?.account_id, target.env).toBe(target.account_id);
    }
  });

  it.runIf(liveTargets.length > 1)("spans more than one Cloudflare account", () => {
    // Not a style preference: the nodes really are billed to different
    // accounts, which is what made the wrong-account deploy possible and why
    // each env pins its own (checked above). Nodes may share an account —
    // the official blyg (blyggerOrg) sits on the personal one with venkateshrao.
    expect(new Set(liveTargets.map((t) => t.account_id)).size).toBeGreaterThan(1);
  });

  it("stores no secret values, only pointers", () => {
    const serialized = JSON.stringify({ targets: liveTargets });
    for (const marker of ["PASSWORD=", "SECRET=", "sk-ant", "-----BEGIN"]) {
      expect(serialized).not.toContain(marker);
    }
  });
});

describe("a single-node config with no named env", () => {
  const config = { name: "blyg-solo", account_id: "acct-solo" };
  const target = { ...targets[0], env: "", worker: "blyg-solo", account_id: "acct-solo" };

  it("resolves env \"\" to the top level", () => {
    expect(wranglerEnv(config, "")?.account_id).toBe("acct-solo");
    expect(crossCheckTarget(target, config)).toEqual([]);
  });

  it("still catches an account mismatch at the top level", () => {
    expect(crossCheckTarget({ ...target, account_id: "acct-other" }, config).join(" ")).toMatch(/account_id mismatch/);
  });

  it("passes no --env to wrangler", () => {
    expect(envArgs("")).toEqual([]);
    expect(envArgs("production")).toEqual(["--env", "production"]);
  });
});

describe("crossCheckTarget catches real drift", () => {
  const base = targets[0];
  // The example target's env is `production`; give the fixture config a
  // matching block so the drift cases below vary one field at a time.
  const wranglerConfig = { env: { production: { name: base.worker, account_id: base.account_id } } };

  it("flags an unknown env", () => {
    expect(crossCheckTarget({ ...base, env: "nope" }, wranglerConfig)[0]).toMatch(/no env "nope"/);
  });

  it("flags a worker-name mismatch", () => {
    expect(crossCheckTarget({ ...base, worker: "wrong-name" }, wranglerConfig)[0]).toMatch(/worker name mismatch/);
  });

  it("flags an account-id mismatch — the incident's failure mode", () => {
    const drifted = { ...base, account_id: "0000000000000000000000000000000f" };
    expect(crossCheckTarget(drifted, wranglerConfig)[0]).toMatch(/account_id mismatch/);
  });

  it("flags an env with no account_id pinned at all", () => {
    const config = { env: { solo: { name: base.worker } } };
    expect(crossCheckTarget({ ...base, env: "solo" }, config)[0]).toMatch(/no account_id pinned/);
  });
});

describe("hasPendingMigrations", () => {
  // Both fixtures are real `wrangler d1 migrations list --remote` output,
  // captured against the venkateshrao node (wrangler 4.112.0).
  it("reads the up-to-date sentinel", () => {
    expect(hasPendingMigrations("Resource location: remote \n\n✅ No migrations to apply!\n")).toBe(false);
  });

  it("reads the pending-migrations table", () => {
    const out = [
      "Resource location: remote ",
      "",
      "Migrations to be applied:",
      "┌───────────────────────┐",
      "│ Name                  │",
      "├───────────────────────┤",
      "│ 9999_deploy_probe.sql │",
      "└───────────────────────┘",
    ].join("\n");
    expect(hasPendingMigrations(out)).toBe(true);
  });

  it("treats unrecognised output as pending, not as up to date", () => {
    // A wrangler upgrade that reworded the table must stop the deploy, not
    // silently skip a schema change.
    expect(hasPendingMigrations("some future wrangler format nobody predicted")).toBe(true);
    expect(hasPendingMigrations("")).toBe(true);
  });
});

describe("verification helpers", () => {
  it("resolves and cache-busts a check URL against the target base", () => {
    const url = verifyUrl("https://example.com/blyg/", { path: "blyg.json", status: 200 }, "42");
    expect(url).toBe("https://example.com/blyg/blyg.json?_deploycheck=42");
  });

  it("resolves against a root-mounted base too", () => {
    const url = verifyUrl("https://blyg.example.org/", { path: "feed.xml", status: 200 }, "7");
    expect(url).toBe("https://blyg.example.org/feed.xml?_deploycheck=7");
  });

  it("passes a matching status and body", () => {
    expect(describeVerifyFailure({ path: "a", status: 200, contains: "ok" }, 200, "it is ok")).toBeNull();
  });

  it("fails a wrong status", () => {
    expect(describeVerifyFailure({ path: "a", status: 200 }, 500, "")).toMatch(/expected 200, got 500/);
  });

  it("fails a right status with missing body content", () => {
    expect(describeVerifyFailure({ path: "a", status: 200, contains: "rss" }, 200, "nope")).toMatch(/missing/);
  });
});
