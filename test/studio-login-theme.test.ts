// The login page wears the install's theme (settings.theme), as the studio does
// once settings load. Before a session the server paints it, from the same
// tokens src/ui/theme.ts applies (src/studio-theme.ts).
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { putSettings } from "../src/model.ts";
import { BASE, STUDIO } from "./helpers.ts";

const page = async (init?: RequestInit) => (await SELF.fetch(`${BASE}${STUDIO}/login`, init)).text();

describe("studio login theme", () => {
  afterEach(() => putSettings(env.DB, { theme: "auto", custom_theme: "", custom_theme_dark: "" }));

  it("leaves auto to the stylesheet's own light/dark pair", async () => {
    await putSettings(env.DB, { theme: "auto" });
    const html = await page();
    expect(html).toContain('data-theme="auto"');
    expect(html).not.toContain("<style>");
  });

  it("paints a named theme's studio tokens and accent", async () => {
    await putSettings(env.DB, { theme: "nord" });
    const html = await page();
    expect(html).toContain('data-theme="fixed"');
    expect(html).toContain("--page:#242933;");
    expect(html).toContain("--pencil:#88c0d0;");
    expect(html).toContain("color-scheme:dark}");
    expect(html).toContain('<meta name="theme-color" content="#88c0d0">');
    // One palette, chosen by the author: the reader's preference does not override it.
    expect(html).not.toContain("prefers-color-scheme");
  });

  it("paints the wrong-password page too", async () => {
    await putSettings(env.DB, { theme: "nord" });
    const html = await page({ method: "POST", body: new URLSearchParams({ password: "not-it" }) });
    expect(html).toContain("Wrong password.");
    expect(html).toContain("--page:#242933;");
  });
});
