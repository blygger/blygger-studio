/**
 * A static collection walk must return every row once in its promised order.
 * Correct page lengths alone cannot detect duplicates, stale values or missed ties.
 *
 * Contract: docs/api.md defines collection envelopes; established signals ordering
 * is descending timestamp, then ascending subscription and remote ID. This local
 * ordering law does not come from a general REST pagination standard.
 * Model: independently sort the fixture array and slice it for each requested page.
 * No production SQL, comparator, page helper or resource projector predicts results.
 * History grammar: zero to twenty-five rows, three timestamps and widths one to ten.
 * Remote IDs are unique; repeated timestamps and subscriptions force tie-breaks.
 * Driver: insert fixture rows into real D1, then use the generated SDK through SELF.
 * Refinement: exact item values, order, total, offset and limit at each response;
 * concatenated pages must equal the complete reference, including exhaustion.
 * Limits: the table stays static during each walk. No concurrent snapshot, arbitrary
 * Unicode collation or query-cost guarantee. Campaigns sample bounded inputs;
 * fixed empty/tied witnesses and wrong-result controls protect key distinctions.
 */
import { SELF, env } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BlyggerApi, createBlyggerClient, unwrap } from "../sdk/dist/browser.js";
import { BASE, login } from "./helpers.ts";
import { atCheckpoint, campaign } from "./oracle-campaign.ts";

type Row = { subscription_id: string; remote_id: string; thumb: number; at: string };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
// The reference orders whole fixture records before slicing. Keep lexicographic
// tie-breaks explicit: sorting only timestamps could pass without page boundaries
// and fail when tied rows span pages. These fixtures use ASCII keys only.
const expectedRows = (rows: Row[]) => [...rows].sort((a, b) => compare(b.at, a.at) || compare(a.subscription_id, b.subscription_id) || compare(a.remote_id, b.remote_id));
const inputs = fc.record({ times: fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 25 }), width: fc.integer({ min: 1, max: 10 }) });
async function walk(times: number[], width: number) {
  // Each generated history owns this table. Delete only fixture state, not
  // returned rows: the provider must never supply paging progress for us.
  await env.DB.prepare("DELETE FROM signals").run();
  const rows = times.map((time, i) => ({ subscription_id: `s${i % 3}`, remote_id: `r${String(i).padStart(3, "0")}`, thumb: i % 2 ? 1 : -1, at: `2026-10-01T00:00:0${time}Z` }));
  if (rows.length) await env.DB.batch(rows.map(r => env.DB.prepare("INSERT INTO signals (subscription_id, remote_id, thumb, at) VALUES (?, ?, ?, ?)").bind(r.subscription_id, r.remote_id, r.thumb, r.at)));
  const client = createBlyggerClient({ baseUrl: BASE + '/blyg/api', headers: { cookie: await login() }, fetch: (input, init) => SELF.fetch(input instanceof Request ? input : new Request(input, init)) });
  const reference = expectedRows(rows), observed: Row[] = [];
  // Walk past the end as well as through full pages. Exact per-page envelopes catch
  // wrong totals and offsets; the ordered concatenation catches duplicates or loss
  // across pages. Never normalize observations to a Set.
  for (let offset = 0; offset <= rows.length + width; offset += width) {
    const page = await unwrap(BlyggerApi.listSignals({ client, query: { offset, limit: width } }));
    atCheckpoint("pagination page values and order", () => expect(page).toEqual({ items: reference.slice(offset, offset + width), offset, limit: width, total: rows.length }));
    observed.push(...page.items);
  }
  atCheckpoint("pagination complete walk", () => expect(observed).toEqual(reference));
}
describe("pagination oracle", () => {
  it("rejects duplicate, omitted, reordered, and stale rows", () => {
    const rows: Row[] = [0, 1, 2].map(i => ({ subscription_id: "s", remote_id: `r${i}`, thumb: 1, at: "same" }));
    for (const wrong of [[rows[0], rows[0], rows[2]], rows.slice(1), [...rows].reverse(), [{ ...rows[0], thumb: -1 }, ...rows.slice(1)]]) {
      expect(() => expect(wrong).toEqual(expectedRows(rows))).toThrow();
    }
  });
  it("walks ties over more than two pages and reaches exhaustion", () => walk(Array(11).fill(1), 3));
  it("handles an empty collection", () => walk([], 1));
  campaign("pagination", inputs, ({ times, width }) => walk(times, width));
});
