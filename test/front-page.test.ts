// A static front page (session 47, src/front-page.ts): one published thread at
// the mount root, the latest items at {mount}/{posts_path}/.

import { beforeEach, describe, expect, it } from "vitest";
import { postsPathError, RESERVED_PATHS } from "../src/front-page.ts";
import { publicHtmlRequest } from "../src/html-cache.ts";
import { postsPathFromPage } from "../scripts/export-lib.ts";
import { apiJson, BASE, createAndPublish, getPublic, login } from "./helpers.ts";

async function publishThread(cookie: string, contentMd: string): Promise<string> {
  const created = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: contentMd, kind: "thread" });
  const id = created.json.id as string;
  expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
  return id;
}

// Settings outlive a test in this pool, so each starts from the defaults.
beforeEach(async () => {
  await apiJson(await login(), "PATCH", "/blyg/api/settings", { frontPage: "", postsPath: "posts" });
});

const html = async (path: string) => {
  const res = await getPublic(path);
  return { status: res.status, text: await res.text() };
};

describe("the setting", () => {
  it("defaults to the latest items at /posts, and accepts only a published thread", async () => {
    const cookie = await login();
    const settings = (await apiJson(cookie, "GET", "/blyg/api/settings")).json;
    expect(settings.frontPage).toBe("");
    expect(settings.postsPath).toBe("posts");

    const fragment = await createAndPublish(cookie, "a fragment");
    const draft = (await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: "unpublished", kind: "thread" })).json.id as string;
    for (const id of [fragment, draft, "nosuchitem"]) {
      expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { frontPage: id })).status).toBe(400);
    }
    const thread = await publishThread(cookie, "# Welcome\n\nAbout this blyg.");
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { frontPage: thread })).status).toBe(200);
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { frontPage: "" })).status).toBe(200);
  });

  it("refuses a posts address the blyg already uses or that is not one segment", async () => {
    const cookie = await login();
    for (const bad of [...RESERVED_PATHS, "feed.xml", "Posts", "a/b", "", "-x", "x".repeat(41)]) {
      expect(postsPathError(bad), bad).not.toBeNull();
      expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { postsPath: bad })).status, bad).toBe(400);
    }
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { postsPath: "writing" })).status).toBe(200);
  });
});

describe("the public pages", () => {
  it("without a front page the root lists the items and /posts/ is the same list, canonical to the root", async () => {
    const cookie = await login();
    const item = await createAndPublish(cookie, "an ordinary post");
    const root = await html("/blyg/");
    expect(root.text).toContain(item);
    expect(root.text).not.toContain('class="posts-link"');
    expect(postsPathFromPage(root.text)).toBeNull();
    const posts = await html("/blyg/posts/");
    expect(posts.status).toBe(200);
    expect(posts.text).toContain(item);
    expect(posts.text).toContain(`<link rel="canonical" href="${BASE}/blyg/">`);
  });

  it("with a front page the root shows the thread, and the posts page lists everything else", async () => {
    const cookie = await login();
    const post = await createAndPublish(cookie, "a post that is not the front page");
    const front = await publishThread(cookie, "# Welcome\n\nThis is the front page text.");
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { frontPage: front });

    const root = await html("/blyg/");
    expect(root.text).toContain("This is the front page text.");
    expect(root.text).not.toContain(post);
    expect(root.text).toContain(`<link rel="canonical" href="${BASE}/blyg/">`);
    expect(root.text).toContain(`<a class="posts-link" href="/blyg/posts/">Posts</a>`);
    // Discovery still works from the root: the feed link and the item's JSON twin.
    expect(root.text).toContain(`href="${BASE}/blyg/feed.xml"`);
    expect(root.text).toContain(`href="${BASE}/blyg/items/${front}.json"`);

    const posts = await html("/blyg/posts/");
    expect(posts.text).toContain(post);
    expect(posts.text).not.toContain(`/t/${front}/`);
    expect(posts.text).not.toContain('rel="canonical"');

    // The permalink still serves the thread and names the root canonical.
    const permalink = await html(`/blyg/t/${front}/`);
    expect(permalink.status).toBe(200);
    expect(permalink.text).toContain(`<link rel="canonical" href="${BASE}/blyg/">`);

    // The static export finds the posts page from the root's header.
    expect(postsPathFromPage(root.text)).toBe("posts");

    // The wire is untouched: the thread is still a post in the feed.
    expect(await (await getPublic("/blyg/feed.xml")).text()).toContain(`/t/${front}/`);
  });

  it("the posts page follows its setting, and the old address stops answering", async () => {
    const cookie = await login();
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { postsPath: "writing" });
    expect((await html("/blyg/writing/")).status).toBe(200);
    expect((await html("/blyg/posts/")).status).toBe(404);
  });

  it("a withdrawn front page falls back to the latest items", async () => {
    const cookie = await login();
    const post = await createAndPublish(cookie, "still here");
    const front = await publishThread(cookie, "# Soon gone\n\nWithdrawn below.");
    await apiJson(cookie, "PATCH", "/blyg/api/settings", { frontPage: front });
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${front}/withdraw`, {})).status).toBe(200);
    const root = await html("/blyg/");
    expect(root.status).toBe(200);
    expect(root.text).toContain(post);
    expect(root.text).not.toContain("Withdrawn below.");
  });
});

describe("the edge cache", () => {
  const isPage = (path: string) => publicHtmlRequest(new Request(BASE + path), "/blyg");
  it("takes any free segment as a possible posts page, and never the studio's", () => {
    expect(isPage("/blyg/posts/")).toBe(true);
    expect(isPage("/blyg/writing")).toBe(true);
    expect(isPage("/blyg/studio")).toBe(false);
    expect(isPage("/blyg/feed.xml")).toBe(false);
    expect(isPage("/blyg/blyg.json")).toBe(false);
  });
});
