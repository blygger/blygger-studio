// The built-in digest's switch (agenticDriver, session 90): off by default, only off or resident,
// and turning it on writes an edition at once. What the edition holds is the agentic-digest oracle's.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyEffect, createSubscription } from "../src/importer/store.ts";
import { transition } from "../src/importer/transition.ts";
import { newId } from "../src/util.ts";
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

describe("the built-in digest's switch", () => {
  it("is off by default and takes only off or resident", async () => {
    const cookie = await login();
    expect((await apiJson(cookie, "GET", "/blyg/api/settings")).json.agenticDriver).toBe("off");
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { agenticDriver: "someone" })).status).toBe(400);
  });

  it("writes the default feed's edition as soon as it is turned on", async () => {
    const cookie = await login();
    const { sub, id } = await longPost();
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { agenticDriver: "resident" })).status).toBe(200);
    // The write runs after the response (waitUntil); each read gives it a turn.
    let edition: { layout?: { agent: { name: string }; sections: { title: string; entries: { sub: string; remoteId: string }[] }[] } } = {};
    for (let tries = 0; tries < 20 && edition.layout?.agent.name !== "resident"; tries++) edition = (await apiJson(cookie, "GET", "/blyg/api/agentic/default")).json;
    expect(edition.layout?.agent.name).toBe("resident");
    expect(edition.layout?.sections).toEqual([expect.objectContaining({ title: "Highlights", entries: [expect.objectContaining({ sub, remoteId: id })] })]);
  });
});
