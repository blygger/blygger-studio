// studio#113: on a free-plan D1 the reader's lookups read the whole of
// imported_items and hopper_items per call. Migration 0041 indexes the two
// shapes the primary keys could not serve; these plans pin that they are used.
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

async function plan(sql: string, ...binds: unknown[]): Promise<string[]> {
  return (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map(row => row.detail);
}

it('resolves an imported item by remote_id alone without scanning imported_items', async () => {
  // The shape of resolveTarget's imported lookup in src/transclusion.ts.
  const detail = await plan(`SELECT ii.*, s.origin AS sub_origin
    FROM imported_items ii JOIN subscriptions s ON s.id = ii.subscription_id
    WHERE ii.remote_id = ? AND s.hopper_feed IS NULL`, 'x');
  expect(detail.some(d => d.includes('SEARCH ii USING INDEX imported_items_remote'))).toBe(true);
  expect(detail.some(d => d.startsWith('SCAN ii'))).toBe(false);
});

it("lists a reading row's hoppers without scanning hopper_items", async () => {
  // The correlated subquery the reader inbox runs once per row.
  const detail = await plan(`SELECT i.remote_id,
      (SELECT json_group_array(hopper_id) FROM (SELECT hi.hopper_id FROM hopper_items hi
        WHERE hi.subscription_id = i.subscription_id AND hi.remote_id = i.remote_id ORDER BY hi.hopper_id)) AS hoppers_json
    FROM imported_items i
    WHERE (i.observed_at, i.subscription_id, i.remote_id) < (?, ?, ?)
    ORDER BY i.observed_at DESC, i.subscription_id DESC, i.remote_id DESC LIMIT ?`, '2026-11-04', 's', 'r', 100);
  expect(detail.some(d => d.includes('USING COVERING INDEX imported_reading_order'))).toBe(true);
  expect(detail.some(d => d.includes('SEARCH hi USING COVERING INDEX hopper_items_member'))).toBe(true);
  expect(detail.some(d => d.startsWith('SCAN hi'))).toBe(false);
});
