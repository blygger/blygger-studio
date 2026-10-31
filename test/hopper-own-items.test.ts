// The owner's own items in hoppers (session 47): membership under the "~own"
// subscription marker, shown on a public hopper page once published.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

async function publicHopper(cookie: string, name: string) {
  const hopper = (await apiJson(cookie, "POST", "/blyg/api/hoppers", { name })).json as { id: string; slug: string };
  expect((await apiJson(cookie, "PATCH", `/blyg/api/hoppers/${hopper.id}`, { public: true })).status).toBe(200);
  return (await apiJson(cookie, "GET", `/blyg/api/hoppers/${hopper.id}`)).json.hopper as { id: string; slug: string };
}

describe("own items in hoppers", () => {
  it("are added and removed with ~own, shown publicly only while published, and kept out of the reading log", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { author_name: "Ada <Writer>" });
    const hopper = await publicHopper(cookie, "My best");
    const post = await createAndPublish(cookie, "# Own post\n\nWritten here.");
    const draft = (await apiJson(cookie, "POST", "/blyg/api/items", { content_md: "still a draft" })).json.id as string;

    const add = (id: string) => apiJson(cookie, "PUT", `/blyg/api/hoppers/${hopper.id}/items/~own/${id}`);
    expect((await add(post)).status).toBe(200);
    expect((await add(draft)).status).toBe(200);
    expect((await add("nosuchitem")).status).toBe(404);
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM interactions WHERE kind = 'hopper_add'").first<{ n: number }>();

    const detail = (await apiJson(cookie, "GET", `/blyg/api/hoppers/${hopper.id}`)).json;
    expect(detail.total).toBe(2);
    expect(detail.source_count).toBe(0);
    expect(detail.memberships.map((m: { subscription_id: string }) => m.subscription_id)).toEqual(["~own", "~own"]);

    let page = await (await getPublic(`/blyg/h/${hopper.slug}/`)).text();
    expect(page).toContain(`/blyg/f/${post}/`);
    expect(page).toContain("Written here.");
    expect(page).not.toContain("still a draft");
    // The author is named, escaped, and nothing speaks in the first person.
    expect(page).toContain("1 item by Ada &lt;Writer&gt;");

    expect((await apiJson(cookie, "POST", `/blyg/api/items/${post}/withdraw`, {})).status).toBe(200);
    page = await (await getPublic(`/blyg/h/${hopper.slug}/`)).text();
    expect(page).not.toContain("Written here.");

    expect((await apiJson(cookie, "DELETE", `/blyg/api/hoppers/${hopper.id}/items/~own/${draft}`)).status).toBe(200);
    expect((await apiJson(cookie, "GET", `/blyg/api/hoppers/${hopper.id}`)).json.total).toBe(1);
    // Own items are not reading, so the interaction log gains nothing from them.
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM interactions WHERE kind IN ('hopper_add', 'hopper_remove')").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { author_name: "" });
  });
});
