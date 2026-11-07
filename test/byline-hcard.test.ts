// tn-6 section 5.4: an item's page is an h-entry whose byline is a p-author h-card.
import { SELF, env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { createDraft, getItem, pinVersion, publish, putSettings, withdraw } from "../src/model.ts";
import { asHEntry } from "../src/pages.ts";
import type { Settings } from "../src/types.ts";
import { BASE } from "./helpers.ts";

const page = async (path: string) => (await SELF.fetch(`${BASE}/blyg/${path}`)).text();
const item = async (md: string, kind: "fragment" | "thread" = "fragment") => {
  const draft = await createDraft(env.DB, md, kind);
  await publish(env.DB, draft, null, `${BASE}/blyg/`);
  return draft.id;
};

beforeEach(async () => {
  await putSettings(env.DB, { author_name: "Ada <Ruiz>", author_url: "https://ada.example/" });
});

it("marks a fragment's page, escaping the name, and keeps it out of the item document", async () => {
  const id = await item("Words");
  const html = await page(`f/${id}/`);
  expect(html).toMatch(/<article class="h-entry fragment/);
  expect(html).toContain('<div class="e-content item-content"');
  expect(html).toContain('<a class="p-author h-card" href="https://ada.example/" hidden>Ada &lt;Ruiz&gt;</a>');
  expect(html).toContain(`<a class="u-url" href="${BASE}/blyg/f/${id}/" hidden></a>`);
  expect(html).toMatch(/<time class="dt-published" datetime="\d{4}-/);
  const doc = await (await SELF.fetch(`${BASE}/blyg/items/${id}.json`)).text();
  expect(doc).not.toContain("h-entry");
  expect(doc).not.toContain("p-author");
});

it("marks a thread's page and a pinned version's page", async () => {
  const id = await item("Thread words", "thread");
  expect(await page(`t/${id}/`)).toMatch(/<article class="h-entry thread/);
  await pinVersion(env.DB, id, 1);
  const pinned = await page(`t/${id}/v1/`);
  expect(pinned).toMatch(/<article class="h-entry thread/);
  expect(pinned).toContain(`<a class="u-url" href="${BASE}/blyg/t/${id}/v1/" hidden></a>`);
});

it("uses the blyg's own address when no author URL is set, and omits the card with no name", async () => {
  await putSettings(env.DB, { author_url: "" });
  const id = await item("Words");
  expect(await page(`f/${id}/`)).toMatch(/class="p-author h-card" href="[^"]*\/blyg\/" hidden/);
  await putSettings(env.DB, { author_name: "" });
  const html = await page(`f/${id}/`);
  expect(html).not.toContain("p-author");
  expect(html).toContain("h-entry");
});

it("leaves feed cards and a withdrawn item alone", async () => {
  const id = await item("Words");
  expect(await page("")).not.toContain("h-entry");
  await withdraw(env.DB, (await getItem(env.DB, id))!, null);
  expect(await page(`f/${id}/`)).not.toContain("h-entry");
  const settings = { author_name: "A", author_url: "" } as Settings;
  const tomb = '<article class="fragment withdrawn"><p>gone</p></article>';
  expect(asHEntry(tomb, settings, "https://o.example/", "https://o.example/f/x/", "2026-01-01")).toBe(tomb);
});
