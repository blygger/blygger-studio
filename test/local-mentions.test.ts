// Local mentions (session 50): a public page lists this blyg's own live items
// that stub, quote or fork it, so a transclusion is walkable both ways.
import { describe, expect, it } from "vitest";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";
import { newId } from "../src/util.ts";

const OURS = "https://example.com/blyg/";
const section = (html: string) => /<section class="responses local-mentions">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? null;
const page = async (id: string, kind = "f") => (await getPublic(`/blyg/${kind}/${id}/`)).text();
const publishThread = async (cookie: string, content_md: string, extra: Record<string, unknown> = {}) => {
  const created = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: content_md, kind: "thread", ...extra });
  expect(created.status).toBe(201);
  expect((await apiJson(cookie, "POST", `/blyg/api/items/${created.json.id}/publish`, {})).status).toBe(200);
  return created.json.id as string;
};

describe("local mentions on a public page", () => {
  it("lists own stubs, quotes, passage quotes and forks, linked back, and nothing else", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "The target. It has two sentences.");
    expect(section(await page(target)), "no section until something points here").toBeNull();

    await publishThread(cookie, `# A whole quote\n\n![[${target}]]`);
    await publishThread(cookie, `# A passage\n\n![[${target}]]\n> It has two sentences.`);
    const stub = await publishThread(cookie, `# My stub\n\n![[${target}]]\n\nAgreed.`, { stubOf: { origin: OURS, id: target, version: 1 } });
    expect((await apiJson(cookie, "PUT", `/blyg/api/items/${target}/versions/1/pin`)).status).toBe(200);
    const fork = await apiJson(cookie, "POST", "/blyg/api/items", { mode: "fork", source: { origin: OURS, id: target, version: 1 } });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${fork.json.id}/publish`, {})).status).toBe(200);
    // A remote item that shares the id is not this item.
    await publishThread(cookie, `# Unrelated\n\nNothing quoted.`, { stubOf: { url: `https://elsewhere.example/${target}` } });

    const list = section(await page(target))!;
    expect(list).toContain("A whole quote</a> <span class=\"rel\">&middot; quoted this");
    expect(list).toContain("A passage</a> <span class=\"rel\">&middot; quoted a passage");
    expect(list).toContain(`href="/blyg/t/${stub}/">My stub</a> <span class="rel">&middot; stubbed this`);
    expect(list).toContain("forked this");
    expect(list).not.toContain("Unrelated");
    expect((list.match(/<li>/g) ?? []).length).toBe(4);
  });

  it("follows the live version: an edited-out quote and a withdrawn quoter leave", async () => {
    const cookie = await login();
    const target = await createAndPublish(cookie, "Quoted, then not.");
    const edited = await publishThread(cookie, `# Edited\n\n![[${target}]]`);
    const withdrawn = await publishThread(cookie, `# Withdrawn\n\n![[${target}]]`);
    expect((section(await page(target)) ?? "").match(/<li>/g)?.length).toBe(2);
    await apiJson(cookie, "PATCH", `/blyg/api/items/${edited}`, { contentMd: "# Edited\n\nNo quote now." });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${edited}/publish`, {})).status).toBe(200);
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${withdrawn}/withdraw`, {})).status).toBe(200);
    expect(section(await page(target))).toBeNull();
  });

  it("shows on a thread page too, and not for a stranger's id", async () => {
    const cookie = await login();
    const thread = await publishThread(cookie, "# Quoted thread\n\nBody.");
    await publishThread(cookie, `# Quoting the thread\n\n![[${thread}]]`);
    expect(section(await page(thread, "t"))).toContain("Quoting the thread");
    expect(section(await page(await createAndPublish(cookie, `unrelated ${newId()}`)))).toBeNull();
  });
});
