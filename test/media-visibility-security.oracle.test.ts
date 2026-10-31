import { testRevisionBody } from './helpers.ts';
import { testItemRevision } from './helpers.ts';
/**
 * Owner ruling: uploads are private until publication uses them. Protocol §5.4:
 * a published media URL MUST always serve the same bytes, and §9 withdrawal does
 * not cascade, so withdrawal never retracts published media. Draft permission
 * cannot create anonymous publication authority.
 * OWASP requires authorization at every resource endpoint, including static bytes:
 * https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
 * Model: draft/unattached -> owner-only; referenced publication -> anonymous;
 * later versions and withdrawal -> still anonymous; an upload no publication ever
 * showed -> owner-only, even on a withdrawn item. Private
 * responses cannot enter a shared cache. Attachment append and inline placement
 * are distinct publication paths. Avatar selection is an owner-managed public use.
 * Driver: actual multipart upload, owner publish/pin and anonymous R2-serving
 * handler. No production visibility helper supplies expectations.
 * Limits: named lifecycle witnesses; not a claim that old public caches can be
 * recalled, nor a proof of every media reference syntax.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { makeApp } from '../src/index.ts';
const app = makeApp('/blyg');
async function receive(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request('https://media-review.example.test' + path, init), env, ctx);
  await waitOnExecutionContext(ctx); return response;
}
async function fixture() {
  const login = await receive('/blyg/studio/login', { method: 'POST', headers: { 'CF-Connecting-IP': 'fd00:' + crypto.randomUUID().replaceAll('-', '').match(/.{4}/g)!.slice(0,7).join(':') }, body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
  expect(login.status).toBe(302); const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const owner = async (path: string, method = 'GET', body?: unknown) => { body = await testRevisionBody(method, path, body); return receive(path, { method, headers: { cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); };
  const upload = async (item?: string, inline = false, bytes = 'private fixture bytes') => {
    const form = new FormData(); form.set('file', new File([bytes], 'private.png', { type: 'image/png' }));
    if (item) (form.set('item_id', item), form.set('expectedRevision', String(await testItemRevision(item)))); if (inline) form.set('inline', 'true');
    const response = await receive('/blyg/api/media', { method: 'POST', headers: { cookie }, body: form });
    expect(response.status).toBe(201); return response.json() as Promise<{id:string;url:string}>;
  };
  return { owner, cookie, upload };
}
it('unattached uploads stay private while owner previews remain usable', async () => {
  const f = await fixture(), media = await f.upload();
  expect((await receive('/blyg/' + media.url)).status, 'draft bytes are not anonymous publications').toBe(404);
  const preview = await receive('/blyg/' + media.url, { headers: { cookie: f.cookie } });
  expect(preview.status).toBe(200); expect(await preview.text()).toBe('private fixture bytes');
  expect(preview.headers.get('cache-control'), 'private bytes cannot enter a shared cache').toBe('no-store');
});
it.each([false, true])('publication releases its actually visible media (inline=%s)', async inline => {
  const f = await fixture();
  const created = await f.owner('/blyg/api/items', 'POST', { content_md: 'Media lifecycle' }); expect(created.status).toBe(201);
  const { id } = await created.json() as {id:string}, media = await f.upload(id, inline);
  const path = '/blyg/' + media.url;
  expect((await receive(path)).status).toBe(404);
  if (inline) expect((await f.owner('/blyg/api/items/' + id, 'PATCH', { content_md: `![image](/blyg/${media.url})` })).status).toBe(200);
  expect((await f.owner('/blyg/api/items/' + id + '/publish', 'POST')).status).toBe(200);
  expect((await receive(path)).status, 'publication makes visible attachment bytes public').toBe(200);
  expect((await f.owner(`/blyg/api/items/${id}/versions/1/pin`, 'PUT')).status).toBe(200);
  expect((await f.owner('/blyg/api/items/' + id, 'PATCH', { content_md: 'New version without inline image' })).status).toBe(200);
  expect((await f.owner('/blyg/api/items/' + id + '/publish', 'POST')).status).toBe(200);
  expect((await receive(path)).status, 'a public pin keeps its required media available').toBe(200);
  expect((await f.owner('/blyg/api/items/' + id + '/withdraw', 'POST', {})).status).toBe(200);
  expect((await receive(path)).status, 'published media survives withdrawal (§5.4)').toBe(200);
});
// §9: withdrawal does not cascade. Snapshots elsewhere still hold these URLs.
it.each([false, true])('withdrawal keeps published media and leaves later uploads private (inline=%s)', async inline => {
  const f = await fixture();
  const created = await f.owner('/blyg/api/items', 'POST', { content_md: 'Withdrawn media' }); expect(created.status).toBe(201);
  const { id } = await created.json() as {id:string}, media = await f.upload(id, inline);
  const path = '/blyg/' + media.url;
  if (inline) expect((await f.owner('/blyg/api/items/' + id, 'PATCH', { content_md: `![image](/blyg/${media.url})` })).status).toBe(200);
  expect((await f.owner('/blyg/api/items/' + id + '/publish', 'POST')).status).toBe(200);
  expect((await receive(path)).status).toBe(200);
  expect((await f.owner('/blyg/api/items/' + id + '/withdraw', 'POST', {})).status).toBe(200);
  const after = await receive(path);
  expect(after.status, 'a published media URL keeps serving after withdrawal').toBe(200);
  expect(await after.text(), 'the same bytes').toBe('private fixture bytes');
  // Attaching to an ever-published item is itself a publish act (publish scope);
  // an inline upload is public only once published text shows it.
  if (inline) {
    // Other bytes: the same file again would be the published row (studio#7).
    const later = await f.upload(id, true, 'later fixture bytes');
    expect((await receive('/blyg/' + later.url)).status, 'an inline upload no published text showed stays private on a withdrawn item').toBe(404);
  }
});
it('an inline upload not placed in published text remains private', async () => {
  const f = await fixture(); const created = await f.owner('/blyg/api/items', 'POST', { content_md: 'No image' });
  const {id} = await created.json() as {id:string}, media = await f.upload(id, true);
  expect((await f.owner('/blyg/api/items/' + id + '/publish', 'POST')).status).toBe(200);
  expect((await receive('/blyg/' + media.url)).status, 'an unused inline attachment is not published').toBe(404);
});

it('private bytes require live read authority, not merely a draft token', async () => {
  const f = await fixture(), media = await f.upload(), path = '/blyg/' + media.url;
  const credentials: {authorization:{id:string};access_token:string}[] = [];
  for (const scope of ['owner:read','owner:draft']) {
    const minted = await f.owner('/blyg/api/authorizations','POST',{name:'Private media '+scope,scope:[scope],resource:'api'});
    expect(minted.status).toBe(200); credentials.push(await minted.json() as typeof credentials[number]);
  }
  const read = await receive(path,{headers:{Authorization:'Bearer '+credentials[0].access_token}});
  expect(read.status).toBe(200);expect(read.headers.get('cache-control')).toBe('no-store');
  expect((await receive(path,{headers:{Authorization:'Bearer '+credentials[1].access_token}})).status).toBe(404);
  for (const headers of <Record<string,string>[]>[{Authorization:'Bearer '+credentials[0].access_token}, {cookie:f.cookie}]) {
    const ctx = createExecutionContext();
    const cleartext = await app.fetch(new Request('http://media-review.example.test'+path,{headers}),env,ctx);
    await waitOnExecutionContext(ctx);
    expect(cleartext.status,'private bytes cannot be read over non-loopback cleartext transport').toBe(404);
  }
  expect((await f.owner('/blyg/api/authorizations/'+credentials[0].authorization.id,'DELETE')).status).toBe(200);
  expect((await receive(path,{headers:{Authorization:'Bearer '+credentials[0].access_token}})).status,'revocation also denies private media bytes').toBe(404);
});
// Bytes owned by one item and shown in another stay public through both
// withdrawals: each published version holds the URL.
it('media shown by two items survives both withdrawals', async () => {
  const f = await fixture();
  const owner = await f.owner('/blyg/api/items', 'POST', { content_md: 'Owner of the bytes' }); expect(owner.status).toBe(201);
  const { id: ownerId } = await owner.json() as {id:string}, media = await f.upload(ownerId, true);
  const path = '/blyg/' + media.url;
  expect((await f.owner('/blyg/api/items/' + ownerId, 'PATCH', { content_md: `![image](/blyg/${media.url})` })).status).toBe(200);
  expect((await f.owner('/blyg/api/items/' + ownerId + '/publish', 'POST')).status).toBe(200);
  const borrower = await f.owner('/blyg/api/items', 'POST', { content_md: `Borrowed ![image](/blyg/${media.url})` }); expect(borrower.status).toBe(201);
  const { id: borrowerId } = await borrower.json() as {id:string};
  expect((await f.owner('/blyg/api/items/' + borrowerId + '/publish', 'POST')).status).toBe(200);
  expect((await f.owner('/blyg/api/items/' + ownerId + '/withdraw', 'POST', {})).status).toBe(200);
  expect((await receive(path)).status, 'another live page still shows the bytes').toBe(200);
  expect((await f.owner('/blyg/api/items/' + borrowerId + '/withdraw', 'POST', {})).status).toBe(200);
  expect((await receive(path)).status, 'published bytes survive every withdrawal').toBe(200);
});
// Owner ruling: the avatar is public on every page, so choosing it is a publish
// act. A draft+manage token can upload but cannot publish bytes through it.
it('choosing the avatar requires publish scope over REST and MCP', async () => {
  const { flow } = await import('./oauth-flow-driver.ts');
  const f = await flow();
  const mint = async (scope: string[], resource: string) => {
    const minted = await f.request('/blyg/api/authorizations', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'avatar ' + scope.join('+') + ' ' + resource, scope, resource }) });
    expect(minted.status).toBe(200); return (await minted.json() as { access_token: string }).access_token;
  };
  const without = await mint(['owner:draft', 'owner:manage'], 'api'), withPublish = await mint(['owner:draft', 'owner:manage', 'owner:publish'], 'api');
  const form = new FormData(); form.set('file', new File(['avatar fixture bytes'], 'avatar.png', { type: 'image/png' }));
  const uploaded = await f.request('/blyg/api/media', { method: 'POST', headers: { Authorization: 'Bearer ' + without }, body: form });
  expect(uploaded.status).toBe(201);
  const { id, url } = await uploaded.json() as { id: string; url: string };
  const choose = (token: string, value: string) => f.request('/blyg/api/settings', { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar_media_id: value }) });
  expect((await choose(without, id)).status, 'draft+manage cannot publish bytes as the avatar').toBe(403);
  expect((await f.request('/blyg/' + url)).status, 'the refused avatar stays private').toBe(404);
  expect((await f.request('/blyg/api/settings', { method: 'PATCH', headers: { Authorization: 'Bearer ' + without, 'Content-Type': 'application/json' }, body: JSON.stringify({ site_title: 'Still manageable' }) })).status, 'other settings stay manage-only').toBe(200);
  const mcp = await mint(['owner:draft', 'owner:manage'], 'mcp');
  const viaMcp = await f.request('/blyg/studio/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + mcp, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'updateSettings' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'updateSettings', arguments: { body: { avatar_media_id: id } }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  const mcpText = JSON.stringify(await viaMcp.json());
  expect((await f.request('/blyg/' + url)).status, 'MCP cannot publish bytes as the avatar without publish scope: ' + mcpText.slice(0, 200)).toBe(404);
  expect((await choose(withPublish, id)).status, 'publish scope may choose the avatar').toBe(200);
  expect((await f.request('/blyg/' + url)).status, 'the chosen avatar is public').toBe(200);
  expect((await f.request('/blyg/api/settings', { method: 'PATCH', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar_media_id: '' }) })).status).toBe(200);
});
