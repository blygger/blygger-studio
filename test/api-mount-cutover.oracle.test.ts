/** Root installations expose /api; mounted installations expose {mount}/api.
 * The same address identifies SDK requests, discovery and REST audiences.
 *
 * ```ts
 * GET /notes/b/api/settings // → private resource at its advertised address
 * GET /api/settings // → 404 on a mounted installation
 * receive({ aud: origin + '/api' }) // → 401 on a mounted installation
 * refresh({ resource: currentApi }) // → cannot retarget a former-resource grant
 * ```
 * The two-release alias period in AGENTS.md 0.49.12 has ended. For every
 * enumerated mount, API routes and metadata agree with that mount and only its
 * current resource audience grants access. The independent model joins origin
 * and mount inputs; it imports no route builder, token verifier or audience rule.
 * Drivers record completed receiving responses and stable resource projections.
 * Opaque item identities are replaced by one local handle, preserving the
 * location/body identity relation without recording random IDs or credentials.
 * Limits: local factory/SDK/native-provider receiving paths at three mounts;
 * these histories establish neither deployed proxy rewriting nor every URL form.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { differs, oracleProperty, pass, type Observation } from '@tanstack/oracles';
import { decodeJwt } from 'jose';
import { makeApp } from '../src/index.ts';
import { authLocations, authorizationServer } from '../src/oauth.ts';
import { BlyggerApi, createBlyggerClient, unwrap } from '../sdk/dist/index.js';
import { flow } from './oauth-flow-driver.ts';
import { withOracleStorage } from './oracle-storage.ts';

type MountPlan = { origin: string; mount: string; text: string };
const plans: MountPlan[] = ['', '/blyg', '/notes/b'].map(mount => ({ origin: 'https://cutover.example.test', mount, text: 'mounted SDK' }));
type Fact = { checkpoint: string; value: unknown };
const completed = 'API mount history complete';
// A matching prefix is valid when a fixture/cleanup error interrupted its driver.
// Only a recorded completed history owes its final length. A wrong earlier public
// response still rejects, retaining any later cleanup diagnostics as its cause.
function check(_plan: unknown, trace: readonly Observation[], expected: Fact[]) {
  let index = 0;
  for (const entry of trace) {
    if (entry.checkpoint === completed) {
      const mismatch = differs(completed, 'canonical API boundary', { count: index, value: entry.value }, { count: expected.length, value: true });
      if (mismatch) return mismatch;
      continue;
    }
    const mismatch = differs(entry.checkpoint, 'canonical API boundary', entry, expected[index++]);
    if (mismatch) return mismatch;
  }
  return pass;
}
function mountModel(plan: MountPlan): Fact[] {
  const api = plan.origin + plan.mount + '/api';
  return [
    { checkpoint: 'SDK item round trip', value: plan.text },
    { checkpoint: 'API creation status', value: 201 },
    { checkpoint: 'created resource location', value: plan.mount + '/api/items/<created>' },
    { checkpoint: 'API capabilities', value: { api, contractVersion: '5.15.0' } },
    { checkpoint: 'API description', value: { servers: [{ url: api }], itemOperation: true, prefixedPath: false } },
    { checkpoint: 'API has no Studio route', value: 404 },
    { checkpoint: 'mounted Studio login', value: 200 },
    { checkpoint: 'Studio API address', value: plan.mount + '/api' },
    { checkpoint: 'private API challenge', value: { status: 401, metadata: plan.origin + plan.mount + '/studio/auth/resources/api', cache: 'no-store' } },
    { checkpoint: 'API preflight', value: { status: 204, origin: '*' } },
    ...(plan.mount ? ['/api', '/api/settings', '/api/openapi.json', '/api/authorizations'].flatMap(path => [
      { checkpoint: 'retired GET ' + path, value: 404 }, { checkpoint: 'retired OPTIONS ' + path, value: 404 },
    ]).concat([{ checkpoint: 'retired API creation', value: 404 }]) : [{ checkpoint: 'root API deprecation', value: null }]),
  ];
}
oracleProperty({
  id: 'api-mount-cutover',
  owns: ['src/index.ts#makeApp'],
  law: { statement: 'For every root or mounted installation, the SDK, private routes, discovery and Studio agree on its single advertised API address; mounted host-root aliases are absent.', authority: 'AGENTS.md 0.49.12 two-release alias sunset; maintainer direction 2026-11-18 to retire compatibility; docs/api.md canonical API address', limits: 'Root, /blyg and /notes/b local routes through Worker factory and SDK, not deployed proxy configuration.' },
  histories: plans, label: plan => 'uses one API address at mount ' + plan.mount, model: mountModel,
  driver: async (plan, observe) => {
    await withOracleStorage(async () => {
      const app = makeApp(plan.mount), api = plan.origin + plan.mount + '/api';
      const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const ctx = createExecutionContext(); const response = await app.fetch(new Request(input, init), env, ctx);
        await waitOnExecutionContext(ctx); return response;
      };
      const login = await fetch(plan.origin + plan.mount + '/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw new Error('API cutover fixture owner login failed: ' + login.status);
      const client = createBlyggerClient({ baseUrl: api, headers: { cookie }, fetch });
      const draft = await unwrap(BlyggerApi.createItem({ client, body: { contentMd: plan.text } }));
      observe('SDK item round trip', (await unwrap(BlyggerApi.getItem({ client, path: { id: draft.id } }))).contentMd);
      const created = await fetch(api + '/items', { method: 'POST', headers: { cookie } });
      observe('API creation status', created.status);
      const body = await created.json<{ id: string }>();
      observe('created resource location', created.headers.get('location')?.replace(body.id, '<created>'));
      const caps = await unwrap(BlyggerApi.getCapabilities({ client }));
      observe('API capabilities', { api: caps.endpoints.api, contractVersion: caps.contractVersion });
      const document = await (await fetch(api + '/openapi.json', { headers: { cookie } })).json<any>();
      observe('API description', { servers: document.servers, itemOperation: Boolean(document.paths['/items/{id}']), prefixedPath: Object.keys(document.paths).some(path => path.startsWith('/api')) });
      observe('API has no Studio route', (await fetch(api + '/studio/login', { headers: { cookie } })).status);
      observe('mounted Studio login', (await fetch(plan.origin + plan.mount + '/studio/login')).status);
      const page = await fetch(plan.origin + plan.mount + '/studio', { headers: { cookie } });
      observe('Studio API address', (await page.text()).match(/data-api-base="([^"]*)"/)?.[1]);
      const denied = await fetch(api + '/settings');
      observe('private API challenge', { status: denied.status, metadata: denied.headers.get('www-authenticate')?.match(/resource_metadata="([^"]+)"/)?.[1], cache: denied.headers.get('cache-control') });
      const preflight = await fetch(api + '/items', { method: 'OPTIONS', headers: { Origin: 'https://client.example', 'Access-Control-Request-Method': 'POST' } });
      observe('API preflight', { status: preflight.status, origin: preflight.headers.get('access-control-allow-origin') });
      if (plan.mount) {
        for (const path of ['/api', '/api/settings', '/api/openapi.json', '/api/authorizations']) {
          observe('retired GET ' + path, (await fetch(plan.origin + path, { headers: { cookie } })).status);
          observe('retired OPTIONS ' + path, (await fetch(plan.origin + path, { method: 'OPTIONS', headers: { Origin: 'https://client.example', 'Access-Control-Request-Method': 'GET' } })).status);
        }
        observe('retired API creation', (await fetch(plan.origin + '/api/items', { method: 'POST', headers: { cookie } })).status);
      } else observe('root API deprecation', (await fetch(plan.origin + '/api/settings')).headers.get('deprecation'));
    });
    observe(completed, true);
  }, check,
  calibrations: [{ name: 'mounted host-root alias remains', law: 'canonical API boundary', history: { enumerated: 1 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'retired GET /api/settings' ? { ...entry, value: 200 } : entry) }],
});
// This direct location observation reaches the address contract without login
// prerequisites. A failed location call is observed at the promised call itself,
// so oauth:M1 cannot earn a kill from a later fixture's null-cookie exception.
oracleProperty({
  id: 'api-mount-locations', owns: ['src/oauth.ts#authLocations'],
  law: { statement: 'For every enumerated deployment origin and mount, auth locations contain exactly its current Studio, issuer, REST and MCP addresses.', authority: 'docs/api.md mounted resource contract; docs/client-access.md audience/discovery addresses; existing API cutover fixture', limits: 'The three current valid installation mounts; no URL normalization or malformed mount claim.' },
  histories: plans, label: plan => 'current auth locations at ' + plan.mount,
  model: (plan: MountPlan) => [{ checkpoint: 'auth resource locations', value: { base: plan.origin + plan.mount + '/studio', issuer: plan.origin + plan.mount + '/studio/auth', api: plan.origin + plan.mount + '/api', mcp: plan.origin + plan.mount + '/studio/mcp' } }],
  driver: async (plan, observe) => {
    try { observe('auth resource locations', authLocations(plan.origin + plan.mount + '/api/settings', { ...env, MOUNT: plan.mount })); }
    catch (error) { observe('auth resource locations', error); }
    observe(completed, true);
  }, check,
  calibrations: [{ name: 'retired audience advertised', law: 'canonical API boundary', history: { enumerated: 1 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'auth resource locations' ? { ...entry, value: { ...(entry.value as object), api: plans[1].origin + '/api' } } : entry) }],
});
const audiencePlans = [{ mount: '/blyg', audiences: ['current', 'retired', 'foreign'] as const, refreshResource: 'current' as const }];
oracleProperty({
  id: 'api-mount-audiences', owns: ['src/oauth.ts#verifyBearer'],
  law: { statement: 'For every enumerated native REST grant, current audiences authorize their resource, retired and foreign audiences are denied, and refresh cannot retarget a stored former-resource grant.', authority: 'docs/client-access.md resource binding; RFC8707 §2; approved two-release audience sunset in AGENTS.md 0.49.12', limits: 'Signed native REST audience neighbors and stored refresh-resource constraint; root-resource REST routing is checked separately.' },
  histories: audiencePlans, label: () => 'rejects the retired REST audience and cannot retarget its stored refresh grant',
  model: (plan: typeof audiencePlans[number]) => [...plan.audiences.map(audience => ({ checkpoint: 'REST audience ' + audience, value: audience === 'current' ? 200 : 401 })), { checkpoint: 'retired audience root route', value: 404 }, { checkpoint: 'former grant retarget', value: 400 }, { checkpoint: 'current grant remains usable', value: 200 }],
  driver: async (plan, observe) => {
    await withOracleStorage(async () => {
      const f = await flow(), approval = await f.decide('browser-a', true);
      const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
      const tokens = await (await f.token(code)).json<{ access_token: string; refresh_token: string }>();
      const server = await authorizationServer(f.issuer, env);
      const receive = (token: string) => f.request(plan.mount + '/api/settings', { headers: { Authorization: 'Bearer ' + token } });
      let former = '';
      for (const audience of plan.audiences) {
        const token = audience === 'current' ? tokens.access_token : (await server.api.signJWT({ body: { payload: { ...decodeJwt(tokens.access_token), aud: f.base + (audience === 'retired' ? '/api' : '/elsewhere/api') } } })).token;
        observe('REST audience ' + audience, (await receive(token)).status);
        if (audience === 'retired') former = token;
      }
      observe('retired audience root route', (await f.request('/api/settings', { headers: { Authorization: 'Bearer ' + former } })).status);
      const context = await server.$context;
      for (const model of ['oauthRefreshToken', 'oauthConsent']) await context.adapter.updateMany({ model, where: [{ field: 'clientId', value: f.client.client_id }], update: { resources: [f.base + '/api'] } });
      const renewed = await f.request(f.issuer + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: f.client.client_id, refresh_token: tokens.refresh_token, resource: f.base + plan.mount + '/api' }) });
      observe('former grant retarget', renewed.status);
      observe('current grant remains usable', (await receive(tokens.access_token)).status);
    });
    observe(completed, true);
  }, check,
  calibrations: [{ name: 'retired REST audience accepted', law: 'canonical API boundary', history: { enumerated: 0 }, corrupt: trace => trace.map(entry => entry.checkpoint === 'REST audience retired' ? { ...entry, value: 200 } : entry) }],
});
