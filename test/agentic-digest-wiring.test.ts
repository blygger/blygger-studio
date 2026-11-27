// The Agentic feed's writer (agenticDriver, session 90): an external agent by default, the built-in
// digest, or off; the digest's frequency by the clock; and regenerate now. What the edition holds is
// the agentic-digest oracle's.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyEffect, createSubscription } from "../src/importer/store.ts";
import { transition } from "../src/importer/transition.ts";
import { newId } from "../src/util.ts";
import { digestDue } from "../src/agentic-schedule.ts";
import { itemDocBody } from "./importer/fixtures.ts";
import { apiJson, login } from "./helpers.ts";

const ORIGIN = "https://digest-wiring.example/blyg/";

async function longPost() {
  const sub = (await createSubscription(env.DB, { kind: "blyg", origin: ORIGIN, feedUrl: `${ORIGIN}feed.xml`, title: "Digest source" })).id;
  const id = newId(), now = new Date().toISOString();
  const words = Array.from({ length: 320 }, (_, i) => `word${i}`).join(" ");
  const doc = JSON.parse(await itemDocBody({ id, kind: "fragment", version: 1, content_md: words, content_html: `<p>${words}</p>`, created: now, updated: now, origin: ORIGIN }));
  await applyEffect(env.DB, sub, id, transition({ local: { status: "absent" }, doc }).effect, now);
  return { sub, id };
}

describe("the digest's clock", () => {
  // 2026-11-30 is a Monday; in New York 12:05 UTC is 07:05.
  const at = (iso: string) => new Date(iso);
  it("writes hourly on each hour's first tick, daily at 07:00 and weekly at 07:00 on Mondays, in the owner's timezone", () => {
    expect(digestDue("hourly", at("2026-11-30T12:05:00Z"), "UTC")).toBe(true);
    expect(digestDue("hourly", at("2026-11-30T12:20:00Z"), "UTC")).toBe(false);
    expect(digestDue("daily", at("2026-11-30T12:05:00Z"), "America/New_York")).toBe(true);
    expect(digestDue("daily", at("2026-11-30T07:05:00Z"), "America/New_York")).toBe(false);
    expect(digestDue("weekly", at("2026-11-30T12:05:00Z"), "America/New_York")).toBe(true);
    expect(digestDue("weekly", at("2026-12-01T12:05:00Z"), "America/New_York")).toBe(false);
    // A half-hour zone: 07:00 in Kolkata is 01:30 UTC.
    expect(digestDue("daily", at("2026-11-30T01:35:00Z"), "Asia/Kolkata")).toBe(true);
  });
});

describe("the built-in digest's switch", () => {
  it("is an external agent, daily and shown by default, and takes only the values it names", async () => {
    const cookie = await login();
    expect((await apiJson(cookie, "GET", "/blyg/api/settings")).json).toMatchObject({ agenticDriver: "external", agenticFrequency: "daily", agenticHidden: false });
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { agenticDriver: "someone" })).status).toBe(400);
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { agenticFrequency: "monthly" })).status).toBe(400);
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { agenticDriver: "off", agenticHidden: true })).json).toMatchObject({ agenticDriver: "off", agenticHidden: true });
  });

  it("regenerates on request only for the built-in digest, and then writes even when nothing changed", async () => {
    const cookie = await login();
    expect((await apiJson(cookie, "POST", "/blyg/api/agentic/default/regenerate")).status).toBe(409);
    await longPost();
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { agenticDriver: "resident" })).status).toBe(200);
    const first = await apiJson(cookie, "POST", "/blyg/api/agentic/default/regenerate");
    expect(first.status).toBe(200);
    expect(first.json.layout.agent.name).toBe("resident");
    const again = await apiJson(cookie, "POST", "/blyg/api/agentic/default/regenerate");
    expect(again.json.revision).toBe(first.json.revision + 1);
    expect(again.json.layout.sections).toEqual(first.json.layout.sections);
  });

  it("writes the default feed's edition as soon as it is turned on", async () => {
    const cookie = await login();
    const { sub, id } = await longPost();
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { agenticDriver: "resident" })).status).toBe(200);
    // The write runs after the response (waitUntil); each read gives it a turn.
    let edition: { layout?: { agent: { name: string }; sections: { title: string; entries: { sub: string; remoteId: string }[] }[] } } = {};
    for (let tries = 0; tries < 20 && edition.layout?.agent.name !== "resident"; tries++) edition = (await apiJson(cookie, "GET", "/blyg/api/agentic/default")).json;
    expect(edition.layout?.agent.name).toBe("resident");
    // The file's tests share one database, so an earlier test's long post may be a highlight too.
    expect(edition.layout?.sections[0]).toMatchObject({ title: "Highlights" });
    expect(edition.layout?.sections[0]!.entries).toContainEqual(expect.objectContaining({ sub, remoteId: id }));
  });
});
