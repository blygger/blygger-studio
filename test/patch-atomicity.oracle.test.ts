/**
 * Rejecting a patch must leave all its requested changes unapplied.
 * A successful patch changes only supplied mutable fields. Status alone cannot
 * show that validation prevented a partial write.
 *
 * Contract: docs/api.md defines partial-edit fields, domain checks and guarded409.
 * RFC5789 §2 requires atomic application of the entire patch:
 * https://www.rfc-editor.org/rfc/rfc5789.html#section-2
 * Exact mutable fields and status choices are Blygger policy, not an RFC schema.
 * Model: rejection preserves the complete before projection; acceptance replaces
 * only requested fields. Controlled domain races preserve the concurrent writer's
 * complete projection, not the stale projection read before that writer ran.
 * History grammar: subsets of text/kind/response/stub-clear fields, plus one invalid
 * response enum, malformed citation, immutable field or fragment-stub combination.
 * Fixed races change kind, stub, withdrawal or provenance-validation text before the write.
 * Driver: generated SDK through SELF for ordinary patches. Race probes call ownerApi
 * with a D1 proxy that runs a real competing update at the guarded SQL boundary.
 * Refinement: exact status and subsequent owner GET; the race seam must run once.
 * Accepted content/kind/clear patches may change updated time, which this model
 * normalizes. Other fields remain exact. Normalization does not prove clock behavior.
 * Limits: no general concurrent text revision control, every field combination,
 * provider-failure rollback or proof about GET visibility during an in-flight write.
 */
import { SELF, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BlyggerApi, createBlyggerClient, unwrap } from "../sdk/dist/browser.js";
import { ownerApi } from "../src/owner-api.ts";
import type { Env } from "../src/types.ts";
import { BASE, login } from "./helpers.ts";
import { atCheckpoint, campaign } from "./oracle-campaign.ts";

// Four booleans select supplied fields independently. The invalid axis overrides
// one selected field, so a rejected patch can still contain valid sibling changes.
// A fragment-stub case exercises domain rejection beyond JSON shape validation.
// Sampling does not exhaust all eighty boolean/rejection cells.
const input = fc.record({ text: fc.boolean(), kind: fc.boolean(), responses: fc.boolean(), clear: fc.boolean(), invalid: fc.constantFrom("none", "responses", "stub", "immutable", "domain") });
const clientFor = (cookie: string) => createBlyggerClient({ baseUrl: BASE, headers: { cookie }, fetch: (request, init) => SELF.fetch(request instanceof Request ? request : new Request(request, init)) });
async function patch(input: { text: boolean; kind: boolean; responses: boolean; clear: boolean; invalid: string }) {
  const client = clientFor(await login());
  const draft = await unwrap(BlyggerApi.createItem({ client, body: { kind: input.invalid === "domain" ? "fragment" : "thread", content_md: "before" } }));
  const before = await unwrap(BlyggerApi.getItem({ client, path: { id: draft.id } }));
  const body: Record<string, unknown> = {};
  if (input.text) body.content_md = "after";
  if (input.kind) body.kind = "fragment";
  if (input.responses) body.responses = "hide";
  if (input.clear) body.stub_of = null;
  if (input.invalid === "responses") body.responses = "off";
  if (input.invalid === "stub") body.stub_of = { url: "not a URL" };
  if (input.invalid === "immutable") body.forked_from = null;
  if (input.invalid === "domain") body.stub_of = { url: "https://valid.example/" };
  const result = await BlyggerApi.updateItem({ client, path: { id: draft.id }, body: body as never });
  atCheckpoint("PATCH acceptance", () => expect(result.response!.status).toBe(input.invalid === "none" ? 200 : 400));
  const after = await unwrap(BlyggerApi.getItem({ client, path: { id: draft.id } }));
  // On rejection compare the entire owner projection, including timestamps.
  // On acceptance normalize only updated when this patch may change it. The expected
  // object then replaces explicit requested fields; omitted fields stay unchanged.
  if (input.invalid !== "none") atCheckpoint("PATCH rejection preserves all fields", () => expect(after).toEqual(before));
  else atCheckpoint("PATCH changes only requested fields", () => expect(input.text || input.kind || input.clear ? { ...after, updated: before.updated } : after).toEqual({ ...before, ...(input.text ? { content_md: "after" } : {}), ...(input.kind ? { kind: "fragment", authored_kind: "fragment" } : {}), ...(input.responses ? { responses: "hide" } : {}) }));
}
describe("PATCH atomicity oracle", () => {
  it.each([false, true])("guards stored text only when provenance validation used it (replacement text: %s)", async replacement => {
    const cookie = await login();
    const draft = await unwrap(BlyggerApi.createItem({ client: clientFor(cookie), body: { content_md: "[TK]instruction[=]output[/TK]" } }));
    let reached = 0;
    let concurrent: unknown;
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith("UPDATE items SET")) return statement;
        return { bind: (...values: Parameters<D1PreparedStatement["bind"]>) => {
          const bound = statement.bind(...values);
          return { first: async () => {
            reached++;
            await unwrap(BlyggerApi.updateItem({ client: clientFor(cookie), path: { id: draft.id }, body: { content_md: "no scopes remain" } }));
            concurrent = await unwrap(BlyggerApi.getItem({ client: clientFor(cookie), path: { id: draft.id } }));
            return bound.first();
          } };
        } } as D1PreparedStatement;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const context = createExecutionContext();
    const body = { provenance: [{ sources: [], model: "client-model" }], ...(replacement ? { content_md: "[TK]replacement[=]new output[/TK]" } : {}) };
    const response = await ownerApi.fetch(new Request(`${BASE}/items/${draft.id}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
    }), { ...env, DB: db } as Env, context);
    await waitOnExecutionContext(context);

    expect(reached).toBe(1);
    expect(response.status).toBe(replacement ? 200 : 409);
    const after = await unwrap(BlyggerApi.getItem({ client: clientFor(cookie), path: { id: draft.id } }));
    if (replacement) expect(after).toMatchObject(body);
    else expect(after).toEqual(concurrent);
  });
  it("exercises every field and each rejection branch", async () => {
    for (const invalid of ["none", "responses", "stub", "immutable", "domain"]) await patch({ text: true, kind: true, responses: true, clear: true, invalid });
  });
  it("rejects a partly applied result in its checker", () => {
    const before = { content_md: "before", responses: "show" };
    expect(() => expect({ ...before, content_md: "after" }).toEqual(before)).toThrow();
  });
  // The race starts after request validation and before the guarded write executes.
  // A real competing request changes a premise. The stale patch must return409 and
  // leave exactly that concurrent result. Counting the seam rules out a vacuous race.
  // This direct ownerApi witness does not exercise top-level forwarding middleware.
  it.each(["kind", "stub", "withdraw"])("rejects the complete patch when a concurrent %s change invalidates its premise", async boundary => {
    const cookie = await login(), client = clientFor(cookie);
    const draft = await unwrap(BlyggerApi.createItem({ client, body: { kind: "thread", content_md: "before" } }));
    if (boundary === "withdraw") await unwrap(BlyggerApi.publishItem({ client, path: { id: draft.id } }));
    let reached = 0;
    let concurrent: unknown;
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith("UPDATE items SET")) return statement;
        return { bind: (...values: Parameters<D1PreparedStatement["bind"]>) => {
          const bound = statement.bind(...values);
          return { first: async () => {
            reached++;
            if (boundary === "withdraw") await unwrap(BlyggerApi.withdrawItem({ client, path: { id: draft.id } }));
            else await unwrap(BlyggerApi.updateItem({ client, path: { id: draft.id }, body: boundary === "kind" ? { kind: "fragment" } : { stub_of: { url: "https://other.example/" } } }));
            concurrent = await unwrap(BlyggerApi.getItem({ client, path: { id: draft.id } }));
            return bound.first();
          } };
        } } as D1PreparedStatement;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const context = createExecutionContext();
    const response = await ownerApi.fetch(new Request(`${BASE}/items/${draft.id}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ content_md: "must not persist", responses: "hide" }) }), { ...env, DB: db } as unknown as Env, context);
    await waitOnExecutionContext(context);
    expect(reached).toBe(1); expect(response.status).toBe(409);
    expect(await unwrap(BlyggerApi.getItem({ client, path: { id: draft.id } }))).toEqual(concurrent);
  });
  campaign("patch-atomicity", input, patch);
});
