/**
 * Published history moves forward; restoring an old version changes the draft.
 * A pin keeps its published snapshot even after editing, withdrawal and restoration.
 * A final-content-only assertion could miss a rewound counter or rewritten history.
 *
 * Contract: docs/api.md defines restore-without-publish and permanent pins. The
 * established restore-version acceptance tests define the forward-only counter.
 * These are local content laws, not HTTP or OAuth requirements.
 * Model: working copy content, status, dirty flag, authored kind and immutable versions.
 * Withdrawal appends an empty withdrawn snapshot; restore copies text without
 * removing any version; restoring the current version is discard and leaves the copy clean. Pinning changes visibility of one existing snapshot.
 * History grammar: fragment/thread, plain text including empty strings and at most ten generated
 * choices. Legal operations depend on model state; restore/pin target normal
 * published snapshots. A fixed history forces repeated pin and restore-after-withdraw.
 * Driver: named generated SDK operations through SELF to the real Worker and D1.
 * Refinement: after creation and every awaited action, compare owner working state,
 * ordered history, public current projection, pin visibility and pinned wire bytes.
 * Limits: no TK, transclusions, forks, deletion, concurrent publication or arbitrary
 * Markdown rendering. Retaining first pin bytes is a metamorphic check, not an
 * independent expected encoding. docs/testing.md records this bounded domain.
 */
import { SELF } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BlyggerApi, createBlyggerClient, unwrap } from "../sdk/dist/browser.js";
import { BASE, login } from "./helpers.ts";
import { atCheckpoint, campaign } from "./oracle-campaign.ts";

type Snapshot = { content: string; pinned: boolean; kind: "fragment" | "thread" | "withdrawn" };
type Model = { content: string; status: "draft" | "public" | "withdrawn"; dirty: boolean; kind: "fragment" | "thread"; versions: Snapshot[] };
type Action = { op: "edit" | "publish" | "withdraw" | "restore" | "pin"; value?: string; version?: number };
// History is append-only. Publication and withdrawal add snapshots; restore never
// rewinds the counter. Working copy content and public status remain separate because an
// edit or restore can leave the latest published snapshot unchanged.
// Pinned flags affect visibility, not snapshot content. Retaining both facts lets
// later public reads distinguish a restored draft from rewritten history.
function step(model: Model, action: Action) {
  if (action.op === "edit") { model.content = action.value!; model.dirty = true; }
  if (action.op === "publish") { model.versions.push({ content: model.content, pinned: false, kind: model.kind }); model.status = "public"; model.dirty = false; }
  if (action.op === "withdraw") { model.versions.push({ content: "", pinned: false, kind: "withdrawn" }); model.status = "withdrawn"; model.dirty = true; }
  if (action.op === "restore") { model.content = model.versions[action.version! - 1].content; model.dirty = action.version !== model.versions.length; }
  if (action.op === "pin") model.versions[action.version! - 1].pinned = true;
}
const instruction = fc.record({ choice: fc.nat(30), version: fc.nat(30), text: fc.integer({ min: 0, max: 999 }) });
const histories = fc.record({ kind: fc.constantFrom("fragment" as const, "thread" as const), instructions: fc.array(instruction, { minLength: 1, maxLength: 10 }) });

async function run(kind: Model["kind"], actions?: Action[], instructions?: { choice: number; version: number; text: number }[]) {
  const client = createBlyggerClient({ baseUrl: BASE + '/blyg/api', headers: { cookie: await login() }, fetch: (input, init) => SELF.fetch(input instanceof Request ? input : new Request(input, init)) });
  const created = await unwrap(BlyggerApi.createItem({ client, body: { kind, content_md: "initial" } }));
  const id = created.id, model: Model = { content: "initial", status: "draft", dirty: true, kind, versions: [] };
  const pinnedSnapshots = new Map<number, string>();
  // Observe all promised views at the same settled-action boundary. Checking only
  // owner text would miss a wrong public projection; checking only the latest public
  // version would miss a changed old pin. Keep the first pin response as an immutable
  // baseline while the model independently checks its content, kind and visibility.
  async function compare() {
    const owner = await unwrap(BlyggerApi.getItem({ client, path: { id } }));
    atCheckpoint("lifecycle owner working copy", () => expect({ content: owner.content_md, status: owner.status, dirty: owner.dirty, version: owner.version, kind: owner.authored_kind }).toEqual({ content: model.content, status: model.status, dirty: model.dirty, version: model.versions.length, kind }));
    atCheckpoint("lifecycle immutable history", () => expect(owner.versions.map(v => ({ content: v.content_md, pinned: v.pinned, kind: v.kind }))).toEqual(model.versions));
    const current = await SELF.fetch(`${BASE}/blyg/items/${id}.json`);
    atCheckpoint("lifecycle public visibility", () => expect(current.status).toBe(model.versions.length ? 200 : 404));
    if (model.versions.length) {
      const latest = model.versions.at(-1)!;
      const body = await current.json();
      atCheckpoint("lifecycle public current version", () => expect(body).toMatchObject({ version: model.versions.length, kind: latest.kind, content_md: latest.content }));
    }
    for (const [i, snapshot] of model.versions.entries()) {
      const pinned = await SELF.fetch(`${BASE}/blyg/items/${id}/v${i + 1}.json`);
      atCheckpoint("lifecycle pin visibility", () => expect(pinned.status, `pin ${i + 1}`).toBe(snapshot.pinned ? 200 : 404));
      if (snapshot.pinned) {
        const bytes = await pinned.text(), body = JSON.parse(bytes);
        atCheckpoint("lifecycle pinned content", () => expect(body).toMatchObject({ version: i + 1, content_md: snapshot.content, kind: snapshot.kind }));
        if (!pinnedSnapshots.has(i + 1)) pinnedSnapshots.set(i + 1, bytes);
        // Keep the first response, never overwrite it with a later observation.
        // This relation protects the entire wire snapshot as well as modeled text.
        atCheckpoint("lifecycle immutable pinned bytes", () => expect(bytes).toBe(pinnedSnapshots.get(i + 1)));
      }
    }
  }
  await compare();
  const queue = actions ?? instructions!.map(() => null);
  for (const [index, supplied] of queue.entries()) {
    const restorable = model.versions.flatMap((v, i) => v.kind !== "withdrawn" ? [i + 1] : []);
    // Choose operations from model state, not production eligibility helpers.
    // Withdrawal requires a public item; restore/pin require a publication snapshot.
    // Modulo selection bounds choices without skipping failed production actions.
    // This grammar excludes restoring withdrawal tombstones and malformed versions.
    const legal: Action["op"][] = ["edit", "publish", ...(model.status === "public" ? ["withdraw" as const] : []), ...(restorable.length ? ["restore" as const, "pin" as const] : [])];
    const token = instructions?.[index];
    const action = supplied ?? { op: legal[token!.choice % legal.length], value: token!.text % 4 === 0 ? "" : `text ${token!.text}`, version: restorable[token!.version % restorable.length] };
    if (!legal.includes(action.op)) throw new Error("Illegal lifecycle history");
    if (action.op === "edit") await unwrap(BlyggerApi.updateItem({ client, path: { id }, body: { content_md: action.value } }));
    if (action.op === "publish") await unwrap(BlyggerApi.publishItem({ client, path: { id } }));
    if (action.op === "withdraw") await unwrap(BlyggerApi.withdrawItem({ client, path: { id } }));
    if (action.op === "restore") await unwrap(BlyggerApi.restoreItem({ client, path: { id }, body: { version: action.version! } }));
    if (action.op === "pin") {
      const result = await unwrap(BlyggerApi.pinItem({ client, path: { id, version: action.version! } }));
      expect(result.already).toBe(model.versions[action.version! - 1].pinned);
    }
    step(model, action);
    await compare();
  }
}
describe("item lifecycle oracle", () => {
  it.each(["fragment", "thread"] as const)("preserves a pinned history through restore and withdrawal: %s", async kind => {
    await run(kind, [{ op: "publish" }, { op: "pin", version: 1 }, { op: "pin", version: 1 }, { op: "edit", value: "second" }, { op: "publish" }, { op: "withdraw" }, { op: "restore", version: 1 }, { op: "publish" }]);
  });
  it.each(["fragment", "thread"] as const)("keeps empty publications distinct from withdrawals: %s", async kind => {
    await run(kind, [{ op: "edit", value: "" }, { op: "publish" }, { op: "pin", version: 1 }, { op: "withdraw" }, { op: "restore", version: 1 }, { op: "publish" }, { op: "pin", version: 3 }, { op: "withdraw" }]);
  });
  it("rejects a rewound version and a changed pinned snapshot in its checker", () => {
    const model: Model = { content: "one", status: "draft", dirty: true, kind: "thread", versions: [] };
    step(model, { op: "publish" }); step(model, { op: "pin", version: 1 }); step(model, { op: "withdraw" }); step(model, { op: "restore", version: 1 }); step(model, { op: "publish" });
    expect(() => expect(model.versions).toEqual([{ content: "one", pinned: true, kind: "thread" }])).toThrow();
    expect(() => expect([{ ...model.versions[0], content: "changed" }, ...model.versions.slice(1)]).toEqual(model.versions)).toThrow();
  });
  campaign("item-lifecycle", histories, ({ kind, instructions }) => run(kind, undefined, instructions));
});
