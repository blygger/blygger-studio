/**
 * A delegated credential grants only its approved scopes at its approved resource.
 * Revocation and expiry must change the next receiving decision, even when the JWT
 * signature remains valid. One successful request cannot distinguish these laws.
 *
 * Contract: decision #52 and docs/auth-oracles.md define four non-implicative owner
 * scopes and a thirty-day manual grant. RFC6750 §3 distinguishes invalid credentials
 * from insufficient scope; RFC8707 §2 binds a grant to a resource:
 * https://www.rfc-editor.org/rfc/rfc6750.html#section-3
 * https://www.rfc-editor.org/rfc/rfc8707.html#section-2
 * Model: AuthorizationModel stores scope, resource, expiry and revocation only.
 * Its generation changes on signing-secret rotation or revoke-all. Decision #31
 * and the user ruling preserve delegated credentials on owner-password reset.
 * History grammar: three slots, all nonempty scope masks, API/MCP audiences,
 * issuance, operations, revocation, password/secret rotation and deadline neighbors.
 * Every history first issues a live credential. Generated histories are bounded;
 * fixed witnesses force rare deadline and independent-grant distinctions.
 * Driver: real mounted Worker routes, owner login and native manual issuance.
 * Refinement: compare each completed API decision and denied-response challenge.
 * A permitted missing-item publish returns404, which witnesses authorization past
 * the guard; it does not prove a successful publish. Audience denial reaches MCP,
 * but successful MCP behavior belongs to mcp.oracle.test.ts.
 * Limits: eight histories per fixed/random campaign are sampling, not exhaustion.
 * Replay uses the same grammar and named checkpoint through oracle-campaign.ts.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { makeApp } from '../src/index.ts';
import type { Env } from '../src/types.ts';
import { AuthorizationModel, OAuthModel, type Scope, type Resource } from './auth-oracle-model.ts';
import { atCheckpoint, campaign } from './oracle-campaign.ts';

const scopeNames: Scope[] = ['owner:read', 'owner:draft', 'owner:publish', 'owner:manage'];
const scopes = (mask: number) => scopeNames.filter((_, index) => mask & 1 << index);
type Instruction = { op: 'mint' | 'read' | 'draft' | 'publish' | 'manage' | 'wrong-resource' | 'revoke' | 'revoke-all' | 'rotate' | 'password-reset' | 'advance'; slot: number; mask: number; resource: Resource; seconds: number };
// The grammar keeps slot reuse and root reset in one history: a new mint replaces
// only that slot. Signing-secret rotation and revoke-all invalidate earlier
// generations. Password reset changes the owner session, not credential state.
// Deadline neighbors distinguish > from >=. The short bounded domain deliberately
// omits arbitrary malformed scope names, which protocol suites cover separately.
const instruction = fc.record({ op: fc.constantFrom<Instruction['op']>('mint', 'read', 'draft', 'publish', 'manage', 'wrong-resource', 'revoke', 'revoke-all', 'rotate', 'password-reset', 'advance'), slot: fc.integer({ min: 0, max: 2 }), mask: fc.integer({ min: 1, max: 15 }), resource: fc.constantFrom<Resource>('api', 'mcp'), seconds: fc.constantFrom(0, 1, 2591999, 2592000, 2592001) });
const histories = fc.array(instruction, { minLength: 1, maxLength: 14 });

let browserSequence = 0;
async function run(instructions: Instruction[]) {
  const ip = `2001:db8:${(++browserSequence).toString(16)}::1`;
  const model = new AuthorizationModel();
  let currentEnv: Env = { ...env };
  const app = makeApp('/blyg');
  const base = 'https://oracle.example.test';
  const tokens = new Map<number, { token: string; id: string }>();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => 1800000000000 + model.now * 1000);
  const request = async (path: string, options: RequestInit = {}) => {
    const ctx = createExecutionContext();
    const headers = new Headers(options.headers); headers.set('cf-connecting-ip', ip);
    const response = await app.fetch(new Request(base + path, { ...options, headers }), currentEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  let ownerSession: { cookie: string; secret: string; password: string; at: number } | undefined;
  const owner = async (path: string, method: string, body?: unknown) => {
    // A history is one browser. Reuse its session until expiry or rotation.
    if (!ownerSession || ownerSession.secret !== currentEnv.COOKIE_SECRET || ownerSession.password !== currentEnv.OWNER_PASSWORD || model.now - ownerSession.at >= 2592000) {
      const login = await request('/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: currentEnv.OWNER_PASSWORD }) });
      expect(login.status).toBe(302);
      ownerSession = { cookie: login.headers.get('set-cookie')!.split(';')[0], secret: currentEnv.COOKIE_SECRET, password: currentEnv.OWNER_PASSWORD, at: model.now };
    }
    const cookie = ownerSession.cookie;
    return request(path, { method, headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  async function mint(slot: number, mask: number, resource: Resource) {
    const response = await owner('/blyg/api/authorizations', 'POST', { name: `oracle-${slot}`, scope: scopes(mask), resource });
    atCheckpoint('authorization issuance', () => expect(response.status).toBe(200));
    const value = await response.json() as { access_token: string; expires_in: number; authorization: { id: string; scope: string[]; resource: string } };
    atCheckpoint('authorization lifetime and consent', () => {
      expect(value.expires_in).toBe(2592000);
      expect(value.authorization.scope).toEqual(scopes(mask));
      expect(value.authorization.resource).toBe(resource === 'api' ? base + '/blyg/api' : base + '/blyg/studio/mcp');
    });
    tokens.set(slot, { token: value.access_token, id: value.authorization.id });
    model.mint(slot, scopes(mask), resource, 2592000);
  }
  // Every history starts with a usable credential: revocation and expiry have
  // a reached premise even if generated instructions start with those actions.
  try {
    await mint(0, 15, 'api');
    for (const action of instructions) {
      if (action.op === 'mint') { await mint(action.slot, action.mask, action.resource); continue; }
      if (action.op === 'advance') { model.advance(action.seconds); continue; }
      if (action.op === 'rotate') { currentEnv = { ...currentEnv, COOKIE_SECRET: currentEnv.COOKIE_SECRET + '-rotated' }; model.revokeAll(); }
      else if (action.op === 'password-reset') { currentEnv = { ...currentEnv, OWNER_PASSWORD: currentEnv.OWNER_PASSWORD + '-reset' }; }
      else if (action.op === 'revoke-all') { expect((await owner('/blyg/api/authorizations', 'DELETE')).status).toBe(200); model.revokeAll(); }
      else if (action.op === 'revoke') { const token = tokens.get(action.slot); if (token) expect((await owner('/blyg/api/authorizations/' + token.id, 'DELETE')).status).toBe(200); model.revoke(action.slot); }
      if (action.op === 'wrong-resource') {
        const audience = model.credentials.get(action.slot)?.resource;
        const target = audience === 'api' ? '/blyg/studio/mcp' : '/blyg/api/settings';
        const response = await request(target, { method: audience === 'api' ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + (tokens.get(action.slot)?.token ?? 'invalid-token') } });
        atCheckpoint('authorization wrong audience', () => expect(response.status).toBe(401));
        continue;
      }
      const operation = action.op === 'draft' ? { path: '/blyg/api/items', method: 'POST', body: { content_md: 'oracle draft' }, scope: 'owner:draft' as Scope, success: 201 }
        : action.op === 'publish' ? { path: '/blyg/api/items/missing/publish', method: 'POST', body: {}, scope: 'owner:publish' as Scope, success: 404 }
        : action.op === 'manage' ? { path: '/blyg/api/settings', method: 'PATCH', body: {}, scope: 'owner:manage' as Scope, success: 200 }
        : { path: '/blyg/api/settings', method: 'GET', body: undefined, scope: 'owner:read' as Scope, success: 200 };
      const slot = action.op === 'revoke-all' || action.op === 'rotate' ? 0 : action.slot;
      const token = tokens.get(slot)?.token ?? 'invalid-fixture-token';
      const response = await request(operation.path, { method: operation.method, headers: { Authorization: 'Bearer ' + token, ...(operation.body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(operation.body === undefined ? {} : { body: JSON.stringify(operation.body) }) });
      const expected = model.judge(slot, 'api', [operation.scope]);
      atCheckpoint('authorization API decision', () => expect(response.status).toBe(expected === 200 ? operation.success : expected));
      if (expected !== 200) atCheckpoint('authorization challenge', () => {
        expect(response.headers.get('www-authenticate')).toContain('resource_metadata="' + base + '/blyg/studio/auth/resources/api"');
        if (expected === 403) expect(response.headers.get('www-authenticate')).toContain('insufficient_scope');
      });
    }
  } finally { clock.mockRestore(); }
}
describe('delegated authorization oracle', () => {
  it('distinguishes the exact expiry boundary and another live credential after individual revocation', async () => {
    const action = (op: Instruction['op'], slot = 0, seconds = 0): Instruction => ({ op, slot, seconds, mask: 15, resource: 'api' });
    await run([action('mint', 1), action('advance', 0, 2591999), action('read'), action('revoke'), action('read', 1), action('advance', 0, 1), action('read', 1)]);
  });
  it('distinguishes root invalidation, scope denial, and audience denial', async () => {
    await run([{ op: 'mint', slot: 1, mask: 1, resource: 'api', seconds: 0 }, { op: 'draft', slot: 1, mask: 1, resource: 'api', seconds: 0 }, { op: 'mint', slot: 2, mask: 15, resource: 'mcp', seconds: 0 }, { op: 'wrong-resource', slot: 2, mask: 15, resource: 'mcp', seconds: 0 }, { op: 'rotate', slot: 0, mask: 15, resource: 'api', seconds: 0 }]);
  });
  it('preserves delegated tokens after password reset with the signing key unchanged', async () => {
    await run([{ op: 'password-reset', slot: 0, mask: 15, resource: 'api', seconds: 0 }]);
  });
  it('calibrates the judgment against plausible wrong results', () => {
    const model = new AuthorizationModel(); model.mint(0, ['owner:draft'], 'api', 10);
    expect(model.judge(0, 'api', ['owner:read'])).toBe(403);
    expect(() => expect(200).toBe(model.judge(0, 'api', ['owner:read']))).toThrow();
    model.advance(10);
    expect(() => expect(200).toBe(model.judge(0, 'api', ['owner:draft']))).toThrow();
    const oauth = new OAuthModel(); oauth.consent('handle', 'browser-a', ['owner:read']);
    expect(oauth.decide('handle', 'browser-b', true)).toBe('rejected');
    expect(oauth.decide('handle', 'browser-a', false)).toBe('denied');
    expect(oauth.decide('handle', 'browser-a', true)).toBe('rejected');
    expect(() => model.advance(-1)).toThrow();
    expect(() => model.mint(1, [], 'api', 1)).toThrow();
  });
  campaign('authorization', histories, run);
});
