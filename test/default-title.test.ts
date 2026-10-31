// The default a blyg publishes when nobody has set a title.
//
// It used to be the literal string "blyg". That leaked: by session 29 two
// independent live nodes were publishing `"title": "blyg"` in their manifests
// because neither operator had opened Settings, and blygger.com listed both
// under that name — which then briefly got a real submission held as a
// suspected impersonation. Venkat's ruling on that:
//
//   "blyg as name is people setting lazy defaults. We shouldn't use that as the
//    discriminator. Blyg name collisions are okay if different domains. There
//    can be 2 'Joe's blyg' sites. What's actually needed there is a new feature
//    in the reference client that sets more unique defaults."
//
// So the collision is manufactured here and fixed here. A directory must not
// have to tell deployments apart by a name none of their operators chose.
import { describe, expect, it } from "vitest";
import { defaultSiteTitle } from "../src/model.ts";
import { apiJson, getPublic, login } from "./helpers.ts";

describe("the default title is the deployment's own address", () => {
  it("drops a leading blyg. — it says nothing about whose blyg it is", () => {
    expect(defaultSiteTitle("https://blyg.thoughtfolio.xyz/")).toBe("thoughtfolio.xyz");
  });

  it("drops a leading www. for the same reason", () => {
    expect(defaultSiteTitle("https://www.example.org/")).toBe("example.org");
  });

  it("keeps a path-mounted host as the host", () => {
    expect(defaultSiteTitle("https://venkateshrao.com/blyg/")).toBe("venkateshrao.com");
  });

  it("gives two deployments two different names — the whole point", () => {
    const a = defaultSiteTitle("https://blyg.alice.example/");
    const b = defaultSiteTitle("https://blyg.bob.example/");
    expect(a).not.toBe(b);
  });

  it("does not invent a human name the operator never asserted", () => {
    // "Thoughtfolio's Blyg" would be the client claiming something nobody said.
    // The address is true on day one and obviously a placeholder to its owner.
    expect(defaultSiteTitle("https://blyg.thoughtfolio.xyz/")).not.toMatch(/blyg/i);
  });

  it("falls back to blyg only with nothing to derive from", () => {
    expect(defaultSiteTitle("")).toBe("blyg");
    expect(defaultSiteTitle(undefined)).toBe("blyg");
    expect(defaultSiteTitle("not a url")).toBe("blyg");
  });
});

describe("what an unconfigured blyg actually publishes", () => {
  it("titles itself by host once site_url is known, not 'blyg'", async () => {
    const cookie = await login();
    // site_url set (as `npm run init` now does), title never touched.
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: "https://blyg.stranger.example/" });
    const manifest = (await (await getPublic("/blyg/blyg.json")).json()) as any;
    expect(manifest.title).toBe("stranger.example");
  });

  it("an operator's own title always wins over the derivation", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", {
      siteUrl: "https://blyg.stranger.example/",
      siteTitle: "A Name I Chose",
    });
    const manifest = (await (await getPublic("/blyg/blyg.json")).json()) as any;
    expect(manifest.title).toBe("A Name I Chose");
  });

  it("an emptied title falls back to the derivation, not to the empty string", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { siteUrl: "https://blyg.stranger.example/", siteTitle: "" });
    const manifest = (await (await getPublic("/blyg/blyg.json")).json()) as any;
    expect(manifest.title).toBe("stranger.example");
  });
});
