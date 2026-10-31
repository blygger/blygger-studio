import { test, expect, type Page } from "./fixture";

// Images go where the author is writing, not at the end (session 30, Venkat):
// at the caret for the attach button, in place of a `/image` line, and where
// an image is pasted.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
const file = (name: string) => ({ name, mimeType: "image/svg+xml", buffer: Buffer.from(SVG) });
const IMG = String.raw`!\[\]\(http://127\.0\.0\.1:8787/media/[0-9a-z]+\.svg\)`;

async function login(page: Page) {
  await page.goto("/studio");
  await page.locator('[name="password"]').fill("test-password");
  await page.getByRole("button", { name: "log in", exact: true }).click();
  await expect(page.locator("#composer-text")).toBeVisible();
}

async function caretAt(page: Page, selector: string, at: number) {
  await page.locator(selector).evaluate((el, n) => {
    const t = el as HTMLTextAreaElement;
    t.focus();
    t.setSelectionRange(n, n);
  }, at);
}

test("the attach button inserts at the caret, as its own paragraph", async ({ page }) => {
  await login(page);
  const box = page.locator("#composer-text");
  await box.fill("first line\nsecond line");
  await caretAt(page, "#composer-text", "first line".length);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#composer-attach").click();
  await (await chooser).setFiles(file("caret.svg"));
  await expect(box).toHaveValue(new RegExp(`^first line\\n\\n${IMG}\\n\\nsecond line$`));
});

test("/image on its own line opens the picker and the image replaces it", async ({ page }) => {
  await login(page);
  await page.locator("#composer-full").click();
  const box = page.locator("#md-input");
  // An empty line between two paragraphs, which is where an author types it.
  await box.fill("intro\n\n\noutro");
  await caretAt(page, "#md-input", "intro\n\n".length);
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.type("/image");
  await (await chooser).setFiles(file("command.svg"));
  await expect(box).toHaveValue(new RegExp(`^intro\\n\\n${IMG}\\n\\noutro$`));
  await expect(box).not.toHaveValue(/\/image/);
});

test("/image inside a sentence is just text", async ({ page }) => {
  await login(page);
  const box = page.locator("#composer-text");
  let opened = false;
  page.on("filechooser", () => { opened = true; });
  await box.fill("");
  await box.focus();
  await page.keyboard.type("see /image here");
  await expect(box).toHaveValue("see /image here");
  expect(opened).toBe(false);
});

test("a pasted image is uploaded and inserted at the caret", async ({ page }) => {
  await login(page);
  const box = page.locator("#composer-text");
  await box.fill("before\n\nafter");
  await caretAt(page, "#composer-text", "before".length);
  const uploaded = page.waitForResponse((r) => r.url().endsWith("/api/media"));
  await box.evaluate((el, svg) => {
    const data = new DataTransfer();
    data.items.add(new File([svg], "pasted.svg", { type: "image/svg+xml" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, SVG);
  expect((await uploaded).status()).toBe(201);
  await expect(box).toHaveValue(new RegExp(`^before\\n\\n${IMG}\\n\\nafter$`));
});
