/**
 * A client's generated-span claims must align with the content it changes.
 * Rejecting one field while persisting another would publish a false provenance claim.
 *
 * Contract: decision #52 and AGENTS.md §5.9 define client-recorded TK provenance.
 * This is a Blygger content-integrity law, not an OAuth or MCP protocol requirement.
 * Model: two literal generated spans and two positional claims, including null.
 * History grammar: create, mismatched patch, aligned patch and publish.
 * Driver: SELF HTTP through owner login, REST writes and the public item projection.
 * Refinement: the invalid patch leaves the entire item unchanged; the published
 * claims align and rendered content omits TK delimiters at the response boundary.
 * Limits: fixed two-span witness, no claim that a client's attribution is truthful.
 * MCP parity is owned by mcp.oracle.test.ts rather than inferred from this REST test.
 */
import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BASE, STUDIO } from './helpers.ts';
import { atCheckpoint } from './oracle-campaign.ts';

// Authority: decision #52: client-recorded TK provenance and §5.9 sources.
// Independent model supplies two known generated spans and their claims.
// Driver uses REST; MCP receiving oracle asserts the same published projection.
it('keeps client claims aligned to generated spans and rejects a partial patch atomically', async () => {
  const ip = '2001:db8:b003:1::1';
  const login = await SELF.fetch(BASE + STUDIO + '/login', { method: 'POST', redirect: 'manual', headers: { 'cf-connecting-ip': ip }, body: new URLSearchParams({ password: 'test-password' }) });
  expect(login.status).toBe(302);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const source = { sources: [], model: 'oracle-agent', at: '2026-10-04T00:00:00Z' };
  const text = '[TK]first[=]First generated sentence.[/TK]\n\n[TK]second[=]Second generated sentence.[/TK]';
  const request = (path: string, method = 'GET', body?: unknown) => SELF.fetch(BASE + path, { method, headers: { cookie, 'cf-connecting-ip': ip, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const creation = await request('/api/items', 'POST', { content_md: text, provenance: [source, null] });
  atCheckpoint('client provenance creation', () => expect(creation.status).toBe(201));
  const draft = await creation.json() as { id: string };
  const before = await (await request('/api/items/' + draft.id)).json();
  const invalid = await request('/api/items/' + draft.id, 'PATCH', { content_md: text + '\nMust not persist.', provenance: [source] });
  atCheckpoint('client provenance alignment rejection', () => expect(invalid.status).toBe(400));
  const after = await (await request('/api/items/' + draft.id)).json();
  atCheckpoint('client provenance atomic rejection', () => expect(after).toEqual(before));
  const updated = await request('/api/items/' + draft.id, 'PATCH', { provenance: [source, source] });
  expect(updated.status).toBe(200);
  const published = await request('/api/items/' + draft.id + '/publish', 'POST', {});
  expect(published.status).toBe(200);
  const document = await (await SELF.fetch(BASE + '/blyg/items/' + draft.id + '.json')).json() as { generated: unknown; content_md: string };
  atCheckpoint('client provenance public claims', () => { expect(document.generated).toEqual([source, source]); expect(document.content_md).toContain('First generated sentence.'); expect(document.content_md).not.toContain('[TK]'); });
});
