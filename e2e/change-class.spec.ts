import { fixtureJson } from './api-fixture';
import { test, expect } from "./fixture";

// The optional change classifier's chip in the Version N dialog (session 49).
// The classify route is fulfilled here: what is under test is what the dialog
// does with an answer, and what it sends at publish.
const CLEF = "@cf/cloudflare/clef-flash";

test.describe("change classifier", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/studio/login");
    await page.locator('[name="password"]').fill("test-password");
    await page.getByRole("button", { name: "log in", exact: true }).click();
    await expect(page.locator("#composer-text")).toBeVisible();
  });

  const apiFor = (page: import("@playwright/test").Page) => (m: string, p: string, d?: unknown) =>
    page.evaluate(fixtureJson, { method: m, path: '/api' + p, body: d }).then(result => result.json);

  test("the chip writes the category into the note, the author can change it, and publish carries the choice", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const api = apiFor(page);
    await api("PATCH", "/settings", { aiModelClassify: CLEF });
    try {
      await page.route("**/classify", (route) => route.fulfill({ json: { version: 2, category: "minor", model: CLEF, probability: 0.83 } }));
      const publishes: any[] = [];
      page.on("request", (r) => { if (r.url().endsWith("/publish")) publishes.push(r.postDataJSON()); });
      const id = (await api("POST", "/items", { contentMd: `Classifier fixture ${Date.now()}` })).id;
      await api("POST", `/items/${id}/publish`, {});
      await page.goto(`/studio/edit/${id}`);
      const input = page.locator("#md-input");
      await input.fill(`${await input.inputValue()} Teh end.`);

      await page.locator("#publish-btn").click();
      const minor = page.locator('#change-category [data-category="minor"]');
      await expect(minor).toHaveAttribute("aria-checked", "true");
      await expect(minor).toContainText("83%");
      // An empty note becomes the bare word, which is the machine's text.
      await expect(page.locator("#note-confirm-text")).toHaveValue("minor");
      await expect(page.locator("#note-confirm-generated")).toBeVisible();

      // The author overrides: the note follows, and is no longer generated.
      await page.locator('#change-category [data-category="typo"]').click();
      await expect(page.locator("#note-confirm-text")).toHaveValue("typo");
      await expect(page.locator("#note-confirm-generated")).toHaveCount(0);
      // A note of their own keeps the prefix in front of it.
      await page.locator("#note-confirm-text").fill("typo: Fixed a word.");
      await page.locator('#change-category [data-category="minor"]').click();
      await expect(page.locator("#note-confirm-text")).toHaveValue("minor: Fixed a word.");
      await page.locator("#note-confirm-ok").click();
      await expect(page.locator('[data-action="view-version"]')).toHaveCount(2);
      expect(publishes.at(-1)).toMatchObject({ note: "minor: Fixed a word.", noteGenerated: false, changeCategory: "minor" });
      expect(errors).toEqual([]);
    } finally {
      await api("PATCH", "/settings", { aiModelClassify: "" });
    }
  });

  test("a classifier that gives no answer leaves the note alone and publishes with no category", async ({ page }) => {
    const api = apiFor(page);
    await api("PATCH", "/settings", { aiModelClassify: CLEF });
    try {
      await page.route("**/classify", (route) => route.fulfill({ json: { version: 2, category: null, model: null, probability: null, reason: "upstream unavailable" } }));
      const id = (await api("POST", "/items", { contentMd: `Classifier failure fixture ${Date.now()}` })).id;
      await api("POST", `/items/${id}/publish`, {});
      await page.goto(`/studio/edit/${id}`);
      const input = page.locator("#md-input");
      await input.fill(`${await input.inputValue()} More.`);
      const published = page.waitForRequest((r) => r.url().endsWith(`/items/${id}/publish`));
      await page.locator("#publish-btn").click();
      await expect(page.locator("#change-category-none")).toContainText("upstream unavailable");
      await expect(page.locator("#note-confirm-text")).toHaveValue("");
      await page.locator("#note-confirm-ok").click();
      expect((await published).postDataJSON()).toMatchObject({ note: "", noteGenerated: false, changeCategory: null });
    } finally {
      await api("PATCH", "/settings", { aiModelClassify: "" });
    }
  });
});
