// Reading typeface: a choice of system font stacks. Only --serif changes, so
// reading text follows the choice and the apparatus keeps its sans. Nothing
// is downloaded: no @font-face, no url(), no third-party host.
import { describe, expect, it } from "vitest";
import { apiJson, getPublic, login } from "./helpers.ts";
import { DEFAULT_FONT, FONTS, fontCss } from "../src/fonts.ts";

const css = async () => (await getPublic("/blyg/style.css")).text();
const settings = (cookie: string, body: unknown) => apiJson(cookie, "PATCH", "/api/settings", body);

describe("reading typeface", () => {
  it("defaults to the stylesheet's own stack and writes nothing", async () => {
    const cookie = await login();
    const { json } = await apiJson(cookie, "GET", "/api/settings");
    expect(json.font).toBe(DEFAULT_FONT);
    expect(await css()).not.toContain("/* typeface:");
  });

  it("a chosen typeface redefines --serif only", async () => {
    const cookie = await login();
    const res = await settings(cookie, { font: "humanist" });
    expect(res.status).toBe(200);
    const sheet = await css();
    expect(sheet).toContain("/* typeface: Humanist sans");
    expect(sheet).toContain(`--serif: ${FONTS.humanist.stack};`);
    const override = sheet.slice(sheet.indexOf("/* typeface:"));
    expect(override).not.toContain("--sans");
    await settings(cookie, { font: DEFAULT_FONT });
  });

  it("works alongside a theme", async () => {
    const cookie = await login();
    await settings(cookie, { theme: "nord", font: "slab" });
    const sheet = await css();
    expect(sheet).toContain("/* theme: Nord");
    expect(sheet).toContain("/* typeface: Slab serif");
    await settings(cookie, { theme: "auto", font: DEFAULT_FONT });
  });

  it("refuses an unknown font, including CSS smuggled in as one", async () => {
    const cookie = await login();
    for (const bad of ["comic-sans", "Georgia", "x; } body { display:none", "constructor"]) {
      expect((await settings(cookie, { font: bad })).status).toBe(400);
    }
    expect((await apiJson(cookie, "GET", "/api/settings")).json.font).toBe(DEFAULT_FONT);
  });

  it("no stack downloads anything", () => {
    for (const id of Object.keys(FONTS)) {
      const out = fontCss(id);
      expect(out).not.toMatch(/@font-face|url\(|@import|https?:/i);
    }
    expect(fontCss("unknown")).toBe("");
  });
});
