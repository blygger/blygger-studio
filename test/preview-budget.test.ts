// The editor's live preview stores nothing and is sent on every pause in
// typing. 0.28 counted it against the owner's 120-a-minute write budget,
// which throttled ordinary editing ("API budget exceeded", session 36).
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import { makeApp } from "../src/index.ts";
import { BASE, STUDIO } from "./helpers.ts";

it("previews spend the read budget, not the write budget", async () => {
  const app = makeApp("/blyg");
  const bindings = { ...env, API_WRITE_LIMIT: "2", API_READ_LIMIT: "100000" };
  const call = async (path: string, init: RequestInit = {}) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(BASE + path, init), bindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  const login = await call(STUDIO + "/login", { method: "POST", redirect: "manual", headers: { "CF-Connecting-IP": "2001:db8:b0d6::1" }, body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const post = (path: string, body: unknown) => call(path, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (let i = 0; i < 10; i++) expect((await post("/blyg/api/preview", { content_md: `typing ${i}` })).status).toBe(200);
  // Real writes are still bounded by the write budget.
  const writes = [];
  for (let i = 0; i < 3; i++) writes.push((await post("/blyg/api/items", { content_md: `draft ${i}` })).status);
  expect(writes).toEqual([201, 201, 429]);
});
