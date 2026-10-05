// Custom theme: an author-defined palette with the same nine values as a
// preset, stored in settings and emitted through the same themeCss path.
// Colours only: anything that is not #rrggbb is refused before it is stored,
// so nothing but a colour ever reaches the stylesheet.
import { describe, expect, it } from "vitest";
import { apiJson, getPublic, login } from "./helpers.ts";
import { THEMES, contrastRatio, contrastWarnings, customFromPreset, parseCustomTheme, resolveTheme, validateCustomTheme } from "../src/themes.ts";
import { themeCss } from "../src/pages.ts";

const PALETTE = {
  dark: false,
  page: "#F4EFE6", // upper case on purpose: stored lower case
  paper: "#fffdf8",
  ink: "#1f2a2e",
  inkSoft: "#5b666a",
  rule: "#e3dccf",
  pencil: "#9c3d2e",
  genBg: "#f6eee0",
  genRule: "#dcc7a3",
};
const css = async () => (await getPublic("/blyg/style.css")).text();
const settings = (cookie: string, body: unknown) => apiJson(cookie, "PATCH", "/api/settings", body);

describe("custom theme: settings API", () => {
  it("starts with no palette", async () => {
    const cookie = await login();
    const { json } = await apiJson(cookie, "GET", "/api/settings");
    expect(json.custom_theme).toBeNull();
  });

  it("refuses theme=custom while no palette is set", async () => {
    const cookie = await login();
    await settings(cookie, { custom_theme: null, theme: "auto" });
    const res = await settings(cookie, { theme: "custom" });
    expect(res.status).toBe(400);
    expect((await apiJson(cookie, "GET", "/api/settings")).json.theme).toBe("auto");
  });

  it("stores a palette (lower-cased) and paints style.css with it", async () => {
    const cookie = await login();
    const res = await settings(cookie, { custom_theme: PALETTE, theme: "custom" });
    expect(res.status).toBe(200);
    expect(res.json.theme).toBe("custom");
    expect(res.json.custom_theme.page).toBe("#f4efe6");
    const sheet = await css();
    expect(sheet).toContain("/* theme: Custom");
    expect(sheet).toContain("--page: #f4efe6;");
    expect(sheet).toContain("--pencil: #9c3d2e;");
    expect(sheet).toContain("--gen-bg: #f6eee0;");
    // Both scheme blocks, like a preset: the author's choice doesn't flip with the reader's OS.
    expect(sheet.match(/--paper: #fffdf8;/g)?.length).toBe(2);
  });

  it("refuses anything that is not a #rrggbb colour, and stores nothing", async () => {
    const cookie = await login();
    await settings(cookie, { custom_theme: PALETTE, theme: "custom" });
    for (const bad of [
      { ...PALETTE, ink: "red" },
      { ...PALETTE, ink: "#123" },
      { ...PALETTE, ink: "#123456; } body { display:none" },
      { ...PALETTE, extra: "#000000" },
      { ...PALETTE, dark: "yes" },
    ]) {
      const res = await settings(cookie, { custom_theme: bad });
      expect(res.status).toBe(400);
    }
    expect((await apiJson(cookie, "GET", "/api/settings")).json.custom_theme.ink).toBe("#1f2a2e");
    expect(await css()).not.toContain("display:none");
  });

  it("can't clear the palette while it's the theme in use; can after switching away", async () => {
    const cookie = await login();
    await settings(cookie, { custom_theme: PALETTE, theme: "custom" });
    expect((await settings(cookie, { custom_theme: null })).status).toBe(400);
    const res = await settings(cookie, { theme: "nord", custom_theme: null });
    expect(res.status).toBe(200);
    expect(res.json.custom_theme).toBeNull();
    expect(await css()).toContain("/* theme: Nord");
  });

  it("keeps the palette when switching to a preset, so switching back restores it", async () => {
    const cookie = await login();
    await settings(cookie, { custom_theme: PALETTE, theme: "custom" });
    await settings(cookie, { theme: "cream" });
    expect(await css()).toContain("/* theme: Cream");
    const back = await settings(cookie, { theme: "custom" });
    expect(back.status).toBe(200);
    expect(await css()).toContain("--pencil: #9c3d2e;");
    await settings(cookie, { theme: "auto" });
  });
});

describe("custom theme: model", () => {
  it("validates, normalises and rejects", () => {
    const ok = validateCustomTheme(PALETTE);
    expect("theme" in ok && ok.theme.page).toBe("#f4efe6");
    expect(validateCustomTheme(null)).toEqual({ error: "a custom theme is an object" });
    expect(validateCustomTheme([])).toHaveProperty("error");
    expect(validateCustomTheme({ ...PALETTE, rule: undefined })).toEqual({ error: "rule must be a #rrggbb colour" });
  });

  it("an unreadable stored palette is no palette", () => {
    expect(parseCustomTheme(undefined)).toBeNull();
    expect(parseCustomTheme("")).toBeNull();
    expect(parseCustomTheme("{not json")).toBeNull();
    expect(parseCustomTheme(JSON.stringify({ ...PALETTE, ink: "url(x)" }))).toBeNull();
  });

  it("resolves custom only with a palette, and never a prototype key", () => {
    const palette = parseCustomTheme(JSON.stringify(PALETTE))!;
    expect(resolveTheme("custom", palette)?.label).toBe("Custom");
    expect(resolveTheme("custom", null)).toBeUndefined();
    expect(resolveTheme("constructor")).toBeUndefined();
    expect(resolveTheme("nord")).toBe(THEMES.nord);
    expect(themeCss("custom", null)).toBe("");
  });

  it("every preset converts to a valid custom palette", () => {
    for (const id of Object.keys(THEMES)) {
      const checked = validateCustomTheme(customFromPreset(id));
      expect("theme" in checked).toBe(true);
    }
  });

  it("contrast warnings follow WCAG ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    const ok = parseCustomTheme(JSON.stringify(PALETTE))!;
    expect(contrastWarnings(ok)).toEqual([]);
    const low = { ...ok, inkSoft: "#d0d0d0" };
    expect(contrastWarnings(low).map((w) => w.label)).toEqual(["Secondary text on paper"]);
  });
});

const DARK = {
  dark: true,
  page: "#12161c",
  paper: "#1a1f27",
  ink: "#e8eaee",
  inkSoft: "#a9b79c",
  rule: "#313b2d",
  pencil: "#f06bb8",
  genBg: "#2a2140",
  genRule: "#7b5cf0",
};

describe("custom theme: light/dark pair", () => {
  it("a pair follows the reader's preference: light in the base, dark in the media block", async () => {
    const cookie = await login();
    const res = await settings(cookie, { custom_theme: PALETTE, custom_theme_dark: DARK, theme: "custom" });
    expect(res.status).toBe(200);
    expect(res.json.custom_theme_dark.paper).toBe("#1a1f27");
    const sheet = await css();
    expect(sheet).toContain("/* theme: Custom (light and dark)");
    const override = sheet.slice(sheet.indexOf("/* theme: Custom (light and dark)"));
    const [base, media] = override.split("@media (prefers-color-scheme: dark)");
    expect(base).toContain("--paper: #fffdf8;");
    expect(base).toContain("color-scheme: light;");
    expect(media).toContain("--paper: #1a1f27;");
    expect(media).toContain("color-scheme: dark;");
    expect(base).not.toContain("#1a1f27");
    await settings(cookie, { theme: "auto", custom_theme_dark: null });
  });

  it("refuses an incoherent pair, and a companion with nothing to pair with", async () => {
    const cookie = await login();
    await settings(cookie, { theme: "auto", custom_theme_dark: null, custom_theme: null });
    expect((await settings(cookie, { custom_theme_dark: DARK })).status).toBe(400);
    expect((await settings(cookie, { custom_theme: PALETTE, custom_theme_dark: PALETTE })).status).toBe(400);
    expect((await settings(cookie, { custom_theme: DARK, custom_theme_dark: DARK })).status).toBe(400);
    const ok = await settings(cookie, { custom_theme: PALETTE, custom_theme_dark: DARK });
    expect(ok.status).toBe(200);
    // Clearing the light half while the dark one remains would orphan it.
    expect((await settings(cookie, { custom_theme: null })).status).toBe(400);
    expect((await settings(cookie, { custom_theme: null, custom_theme_dark: null })).status).toBe(200);
  });

  it("dropping the companion returns to a single, author-fixed palette", async () => {
    const cookie = await login();
    await settings(cookie, { custom_theme: PALETTE, custom_theme_dark: DARK, theme: "custom" });
    await settings(cookie, { custom_theme_dark: null });
    const sheet = await css();
    expect(sheet).toContain("/* theme: Custom —");
    expect(sheet.match(/--paper: #fffdf8;/g)?.length).toBe(2);
    await settings(cookie, { theme: "auto" });
  });

  it("resolveTheme picks the companion only for a dark preference", () => {
    const light = parseCustomTheme(JSON.stringify(PALETTE))!;
    const dark = parseCustomTheme(JSON.stringify(DARK))!;
    expect(resolveTheme("custom", light, dark, false)?.paper).toBe("#fffdf8");
    expect(resolveTheme("custom", light, dark, true)?.paper).toBe("#1a1f27");
    expect(resolveTheme("custom", light, null, true)?.paper).toBe("#fffdf8");
    expect(themeCss("custom", light, dark)).toContain("light and dark");
  });
});
