// The studio is an installable PWA (phase 1 of the mobile redesign): a web
// app manifest and a service worker under the studio mount, both public (a
// manifest is fetched without credentials) and both free of owner data.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeApp } from "../src/index.ts";
import { studioPath } from "../src/util.ts";
import { BASE, STUDIO, login } from "./helpers.ts";

describe("studio PWA surface", () => {
  it("serves a manifest whose scope and start_url are the studio base", async () => {
    const res = await SELF.fetch(`${BASE}${STUDIO}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const manifest = await res.json() as { scope: string; start_url: string; icons: { src: string; type: string }[] };
    expect(manifest).toMatchObject({ scope: STUDIO, start_url: STUDIO, id: STUDIO, display: "standalone" });
    for (const icon of manifest.icons) {
      const got = await SELF.fetch(`${BASE}${icon.src}`);
      expect(got.status, icon.src).toBe(200);
      expect(got.headers.get("content-type")).toBe(icon.type);
    }
    const png = new Uint8Array(await (await SELF.fetch(`${BASE}${STUDIO}/icon-180.png`)).arrayBuffer());
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("serves the worker with a scope widened to the studio root itself", async () => {
    const res = await SELF.fetch(`${BASE}${STUDIO}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("service-worker-allowed")).toBe(STUDIO);
    const source = await res.text();
    // Boot metadata names the API, but the worker must never intercept it.
    expect(source).toContain(JSON.stringify([`${STUDIO}/app.js`, `${STUDIO}/app.css`, `${STUDIO}/icon.svg`]));
    let fetchHandler: (event: unknown) => void = () => { throw new Error('missing fetch handler'); };
    new Function('self', source)({
      location: { origin: BASE },
      addEventListener: (name: string, handler: typeof fetchHandler) => { if (name === 'fetch') fetchHandler = handler; },
    });
    for (const method of ['GET', 'POST']) {
      let intercepted = false;
      fetchHandler({ request: { method, url: `${BASE}/blyg/api/items`, mode: 'navigate' }, respondWith: () => { intercepted = true; } });
      expect(intercepted).toBe(false);
    }
  });

  it("links the manifest, icons and theme-color from both shells; login stays script-free", async () => {
    const loginPage = await (await SELF.fetch(`${BASE}${STUDIO}/login`)).text();
    const cookie = await login();
    const spa = await (await SELF.fetch(`${BASE}${STUDIO}`, { headers: { cookie } })).text();
    for (const html of [loginPage, spa]) {
      expect(html).toContain(`<link rel="manifest" href="${STUDIO}/manifest.webmanifest">`);
      expect(html).toContain(`<link rel="apple-touch-icon" href="${STUDIO}/icon-180.png">`);
      expect(html).toContain('<meta name="theme-color"');
      expect(html).toContain("viewport-fit=cover");
    }
    expect(loginPage).not.toContain("<script");
    expect(spa).toContain("<title>blyg studio</title>");
  });

  it.each(["", "/notes/b"])("follows the mount %s", async (mount) => {
    const app = makeApp(mount);
    const base = studioPath(mount);
    const { env } = await import("cloudflare:test");
    const res = await app.request(`${BASE}${base}/manifest.webmanifest`, {}, { ...(env as object), MOUNT: mount });
    expect(await res.json()).toMatchObject({ scope: base, start_url: base });
    const sw = await app.request(`${BASE}${base}/sw.js`, {}, { ...(env as object), MOUNT: mount });
    expect(sw.headers.get("service-worker-allowed")).toBe(base);
  });
});
