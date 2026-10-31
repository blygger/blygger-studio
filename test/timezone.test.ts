// Timezone for displayed dates (session 28). The Worker's clock is UTC, so
// `toLocaleDateString` rendered every date in UTC regardless of where the
// author lives — an evening post could show tomorrow's date on its own page.
//
// **The wire does not move.** Feed dates stay RFC-822 and item documents stay
// ISO-8601 UTC. Writing local time into a feed would reintroduce the
// session-18 reading-list sort bug on every subscriber that reads us: their
// sort compares instants, and a local-time string is not one.
import { describe, expect, it } from "vitest";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";
import { formatDateIn, isValidTimeZone } from "../src/util.ts";

describe("formatDateIn", () => {
  it("renders the same instant as a different date either side of midnight", () => {
    // 06:00 UTC on the 2nd is still the 1st in Los Angeles. This is the bug.
    const iso = "2026-09-02T06:00:00Z";
    expect(formatDateIn(iso, "UTC")).toContain("Sep 2");
    expect(formatDateIn(iso, "America/Los_Angeles")).toContain("Sep 1");
  });

  it("treats an empty zone as UTC", () => {
    expect(formatDateIn("2026-09-02T06:00:00Z", "")).toBe(formatDateIn("2026-09-02T06:00:00Z", "UTC"));
  });

  it("falls back to UTC on a bad zone rather than throwing", () => {
    // A database row is not a type. A blyg whose every page 500s because of a
    // bad settings string would be worse than a date in the wrong zone.
    expect(formatDateIn("2026-09-02T06:00:00Z", "Mars/Olympus")).toContain("Sep 2");
  });
});

describe("isValidTimeZone", () => {
  it("accepts real zones and empty", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("")).toBe(true);
  });
  it("rejects nonsense", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});

describe("the setting changes rendering, and only rendering", () => {
  it("moves the date shown on a public page", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item");
    // Force a known instant so the assertion is about the zone, not about now.
    const { env } = await import("cloudflare:test");
    await env.DB.prepare("UPDATE items SET created = ?, updated = ? WHERE id = ?")
      .bind("2026-09-02T06:00:00Z", "2026-09-02T06:00:00Z", id)
      .run();

    await apiJson(cookie, "PATCH", "/blyg/api/settings", { timezone: "" });
    expect(await (await getPublic(`/blyg/f/${id}/`)).text()).toContain("Sep 2, 2026");

    await apiJson(cookie, "PATCH", "/blyg/api/settings", { timezone: "America/Los_Angeles" });
    expect(await (await getPublic(`/blyg/f/${id}/`)).text()).toContain("Sep 1, 2026");
  });

  it("leaves the feed's RFC-822 dates in GMT", async () => {
    const cookie = await login();
    await createAndPublish(cookie, "an item");
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { timezone: "America/Los_Angeles" });
    const xml = await (await getPublic("/blyg/feed.xml")).text();
    const pub = /<pubDate>([^<]*)<\/pubDate>/.exec(xml);
    expect(pub, "no pubDate").not.toBeNull();
    // A subscriber sorts by instant; a local-time string is not one.
    expect(pub![1]).toMatch(/GMT$/);
  });

  it("leaves item documents in ISO-8601 UTC", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "an item");
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { timezone: "Asia/Kolkata" });
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<Record<string, string>>();
    expect(doc.created).toMatch(/Z$/);
    expect(doc.updated).toMatch(/Z$/);
  });

  it("refuses a zone the runtime does not know", async () => {
    const cookie = await login();
    const res = await apiJson(cookie, "PATCH", "/blyg/api/settings", { timezone: "Not/AZone" });
    // Accepting it would leave a setting that looks saved and silently does
    // nothing, because formatDateIn falls back to UTC.
    expect(res.status).toBe(400);
  });
});
