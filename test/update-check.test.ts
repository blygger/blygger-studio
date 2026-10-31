// Version-alert logic, fetch privacy, persistent preferences and owner release state.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiJson, login } from "./helpers.ts";
import { CLIENT } from "../src/types.ts";

import {
  readState,
  compareVersions,
  fetchLatest,
  isBehind,
  isDue,
  latestInFeed,
  parseVersion,
  CHECK_INTERVAL_MS,
} from "../src/update-check.ts";

describe("version parsing and comparison", () => {
  it("reads a version with or without a leading v", () => {
    expect(parseVersion("0.7.0")).toEqual([0, 7, 0]);
    expect(parseVersion("v0.7.0")).toEqual([0, 7, 0]);
    expect(parseVersion("not a version")).toBeNull();
  });

  it("compares numerically, not lexicographically", () => {
    // The bug this guards: "0.10.0" < "0.9.0" as strings, which would tell
    // everyone on the newest build that they were behind.
    expect(compareVersions([0, 10, 0], [0, 9, 0])).toBeGreaterThan(0);
    expect(compareVersions([0, 7, 0], [0, 7, 0])).toBe(0);
  });
});

describe("latestInFeed", () => {
  const feed = (versions: string[]) =>
    `<feed>${versions
      .map((v) => `<entry><title>${v}</title><id>tag:github.com,2008:Repository/1/v${v}</id></entry>`)
      .join("")}</feed>`;

  it("takes the highest version, not the first entry", () => {
    // Feed order is the publisher's choice: a re-published or back-dated
    // release would otherwise make an old version look current.
    expect(latestInFeed(feed(["0.4.1", "0.7.0", "0.6.1"]))).toEqual([0, 7, 0]);
  });

  it("finds nothing in a feed with no versions", () => {
    expect(latestInFeed("<feed><entry><title>hello</title></entry></feed>")).toBeNull();
  });

  it("is not confused by a double-digit minor", () => {
    expect(latestInFeed(feed(["0.9.0", "0.10.0"]))).toEqual([0, 10, 0]);
  });
});

describe("isBehind", () => {
  it("is true when the release is newer", () => {
    expect(isBehind("0.6.1", [0, 7, 0])).toBe(true);
  });

  it("is false when level", () => {
    expect(isBehind("0.7.0", [0, 7, 0])).toBe(false);
  });

  it("is false when ahead — a dev build is not out of date", () => {
    // Telling someone running a newer build to downgrade would be nonsense.
    expect(isBehind("0.8.0", [0, 7, 0])).toBe(false);
  });

  it("is false when this build's version cannot be read", () => {
    // Fail quiet: an unreadable local version is our problem, not a reason to
    // nag an operator.
    expect(isBehind("not-a-version", [0, 7, 0])).toBe(false);
  });
});

describe("isDue", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  it("is due when never checked", () => {
    expect(isDue("", now)).toBe(true);
  });
  it("is not due an hour later", () => {
    expect(isDue(new Date(now - 3600_000).toISOString(), now)).toBe(false);
  });
  it("is due after the interval", () => {
    expect(isDue(new Date(now - CHECK_INTERVAL_MS - 1).toISOString(), now)).toBe(true);
  });
  it("is due when the stored timestamp is garbage", () => {
    expect(isDue("whenever", now)).toBe(true);
  });
});

describe("fetchLatest never throws", () => {
  it("returns null when the network fails", async () => {
    const boom = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await fetchLatest({ update_feed_url: "" }, boom)).toBeNull();
  });

  it("returns null on a non-200", async () => {
    const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchLatest({ update_feed_url: "" }, notFound)).toBeNull();
  });

  it("sends no identifier of this deployment", async () => {
    let seen: Request | string | undefined;
    let init: RequestInit | undefined;
    const spy = (async (u: string, i: RequestInit) => {
      seen = u;
      init = i;
      return new Response("<feed><entry><title>0.7.0</title></entry></feed>");
    }) as unknown as typeof fetch;
    expect(await fetchLatest({ update_feed_url: "" }, spy)).toBe("0.7.0");
    // No query string, and a user-agent naming the software, not the node.
    expect(String(seen)).not.toContain("?");
    expect(String((init?.headers as Record<string, string>)["user-agent"])).toMatch(/^blygger-studio\//);
  });

  it("uses a configured feed, so a fork checks its own releases", async () => {
    let seen = "";
    const spy = (async (u: string) => {
      seen = u;
      return new Response("<feed><entry><title>2.0.0</title></entry></feed>");
    }) as unknown as typeof fetch;
    await fetchLatest({ update_feed_url: "https://example.test/releases.atom" }, spy);
    expect(seen).toBe("https://example.test/releases.atom");
  });
});

describe("update preferences and release state", () => {
  it("checking is on by default and its notice is unacknowledged", async () => {
    const cookie = await login();
    expect((await apiJson(cookie, "GET", "/blyg/api/settings")).json).toMatchObject({ update_check: true, update_notice_ack: false });
  });

  it("the notice acknowledgement persists", async () => {
    const cookie = await login();
    expect((await apiJson(cookie, "GET", "/blyg/api/settings")).json.update_notice_ack).toBe(false);
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { update_notice_ack: true });
    expect((await apiJson(cookie, "GET", "/blyg/api/settings")).json.update_notice_ack).toBe(true);
  });

  it("returns stored newer-release state", async () => {
    const cookie = await login();
    // Whatever this client's version is, 99.0.0 is newer.
    //
    // `update_checked_at` is stamped to now as well, and that is not tidiness:
    // reading owner release state schedules a real check under `waitUntil`, so
    // without it the suite reaches out to GitHub and the answer overwrites the
    // version this test just seeded. Marking the check as already done today
    // keeps the test offline and deterministic.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('update_latest_seen', '99.0.0') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ),
      env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('update_checked_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).bind(new Date().toISOString()),
    ]);
    const state = (await apiJson(cookie, "GET", "/blyg/api/update-state")).json;
    expect(readState(state)).toMatchObject({ latest: "99.0.0", behind: true });
  });

  it("returns level release state without an upgrade", async () => {
    const cookie = await login();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('update_latest_seen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).bind(CLIENT.version),
      env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('update_checked_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).bind(new Date().toISOString()),
    ]);
    expect(readState((await apiJson(cookie, "GET", "/blyg/api/update-state")).json)).toMatchObject({ latest: CLIENT.version, behind: false });
  });

  it("turning the check off persists the preference", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { update_check: false });
    expect((await apiJson(cookie, "GET", "/blyg/api/settings")).json.update_check).toBe(false);
  });

  it("rejects a junk update_check rather than silently ignoring it", async () => {
    const cookie = await login();
    // Silently ignoring would leave an operator believing they had changed it.
    const res = await apiJson(cookie, "PATCH", "/blyg/api/settings", { update_check: "maybe" });
    expect(res.status).toBe(400);
  });
});
