import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { apiJson, BASE, createAndPublish, login } from "./helpers.ts";

  it("discarding changes restores the published text without publishing anything", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "the published wording");
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "a draft that will be thrown away" });
    const restored = await apiJson(cookie, "POST", `/blyg/api/items/${id}/restore`, { version: 1 });
    expect(restored.status).toBe(200);
    // Still v1 in public: nothing was published and no version was rewound.
    const json = (await (await SELF.fetch(`${BASE}/blyg/items/${id}.json`)).json()) as any;
    expect(json.version).toBe(1);
    expect(json.content_html).toContain("the published wording");
  });
