// The thread preview carries the lines the public page puts under its quotes.
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { createDraft, publish } from "../src/model.ts";
import { apiJson, login } from "./helpers.ts";

it("adds the provenance line under a quote, and none under an unresolved one", async () => {
  const cookie = await login();
  const source = await createDraft(env.DB, "Quoted words");
  await publish(env.DB, source, null, "https://me.example/blyg/");
  const good = await apiJson(cookie, "POST", "/blyg/api/preview", { kind: "thread", contentMd: `Before\n\n![[${source.id}]]\n` });
  expect(good.json.html).toContain('<p class="provenance">');
  expect(good.json.html).toContain(`/f/${source.id}/`);
  expect(good.json.html).toContain("Quoted words");
  const bad = await apiJson(cookie, "POST", "/blyg/api/preview", { kind: "thread", contentMd: `![[00000000000000000000000000]]\n\n![[${source.id}]]\n` });
  expect(bad.json.errors.length).toBeGreaterThan(0);
  expect(bad.json.html).not.toContain('<p class="provenance">');
});
