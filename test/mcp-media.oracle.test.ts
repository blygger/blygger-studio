/**
 * MCP upload must preserve REST bytes and reject oversized input before writes.
 * Base64 expansion must not silently reduce the inclusive five-MiB file limit.
 *
 * Contract: the existing REST media contract and decision #52 define types, sizes,
 * attachment metadata and separate drafting/publication capabilities. Draft
 * attachment is permitted; attachment to an already published item also needs
 * owner:publish. Discovery describes base capabilities; REST checks item state. MCP tools use structured inputs:
 * https://modelcontextprotocol.io/specification/2025-11-25/server/tools
 * These exact size limits are Blygger policy, not MCP requirements.
 * Model: literal bytes/types/limits and expected storage absence; no production
 * Base64 decoder, media classifier or scope inventory computes expected results.
 * History grammar: valid multipart/Base64 neighbors, exact file limit, malformed
 * encoding, unsupported types, oversized file/envelope and read-only direct calls.
 * Driver: raw MCP HTTP tool calls, Worker REST uploads, D1 and R2 observations.
 * Refinement: bytes, MIME and attachment parity; negative cases retain empty storage
 * or unchanged counts. Discovery exclusion and direct-call challenge are separate.
 * Limits: no exhaustive image decoder, decompression-bomb or production R2 audit.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { makeApp } from '../src/index.ts';

// Real owner login, real grant, real mounted MCP and canonical multipart REST.
// Expected MIME/size policy is stated independently from production constants.
async function driver(bindings = env) {
  const base = 'https://mcp-media.example.test', app = makeApp('/blyg');
  const edgeIP = '2001:db8:' + crypto.randomUUID().replaceAll('-', '').match(/.{4}/g)!.slice(0, 6).join(':');
  const fetch = async (path: string, init?: RequestInit) => {
    const request = new Request(base + path, init), ctx = createExecutionContext();
    request.headers.set('CF-Connecting-IP', edgeIP);
    const response = await app.fetch(request, bindings, ctx); await waitOnExecutionContext(ctx); return response;
  };
  const login = await fetch('/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
  expect(login.status).toBe(302);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const owner = (path: string, body: unknown) => fetch(path, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const credential = async (scope: string[]) => {
    const response = await owner('/blyg/api/authorizations', { name: 'MCP media oracle', scope, resource: 'mcp' });
    expect(response.status).toBe(200); return (await response.json() as any).access_token as string;
  };
  const mcp = (token: string, method: string, params: Record<string, unknown>) => fetch('/blyg/studio/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  const upload = (token: string, body: unknown) => mcp(token, 'tools/call', { name: 'uploadMedia', arguments: { body } });
  const restUpload = (bytes: Uint8Array, type: string, extra: Record<string, string> = {}) => {
    const form = new FormData(); form.set('file', new File([bytes], 'same-file.dat', { type }));
    for (const [name, value] of Object.entries(extra)) form.set(name, value);
    return fetch('/blyg/api/media', { method: 'POST', headers: { cookie }, body: form });
  };
  return { cookie, fetch, owner, credential, mcp, upload, restUpload };
}
function base64(bytes: Uint8Array) {
  let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
async function result(response: Response) {
  expect(response.status).toBe(200);
  const rpc = await response.json() as any;
  const text = rpc.result.content[0].text;
  let value; try { value = JSON.parse(text); } catch { value = text; }
  return { error: rpc.result.isError === true, value };
}
async function storedCount() {
  return { r2: (await env.MEDIA.list()).objects.length, rows: (await env.DB.prepare('SELECT count(*) AS n FROM media').first<{ n: number }>())!.n };
}
describe('MCP multipart media transport parity', () => {
  it('cannot use the draft upload tool to change published attachments', async () => {
    const d = await driver(), token = await d.credential(['owner:draft']);
    const item = await (await d.owner('/blyg/api/items', { content_md: 'Published MCP boundary' })).json() as { id: string };
    expect((await d.owner('/blyg/api/items/' + item.id + '/publish', {})).status).toBe(200);
    const before = await (await d.fetch('/blyg/items/' + item.id + '.json')).json();
    const denied = await result(await d.upload(token, { file: { filename: 'boundary.png', contentType: 'image/png', dataBase64: 'aW1hZ2U=' }, item_id: item.id }));
    expect(denied.error, 'MCP drafting cannot publish an attachment').toBe(true);
    expect(await (await d.fetch('/blyg/items/' + item.id + '.json')).json()).toEqual(before);
    expect(await storedCount()).toEqual({ r2: 0, rows: 0 });
    const permitted = await d.credential(['owner:draft', 'owner:publish']);
    const attached = await result(await d.upload(permitted, { file: { filename: 'boundary.png', contentType: 'image/png', dataBase64: 'aW1hZ2U=' }, item_id: item.id }));
    expect(attached.error).toBe(false);
    // The same file again under draft scope is the attached row (studio#7): returned, nothing written.
    const stored = await storedCount(), after = await (await d.fetch('/blyg/items/' + item.id + '.json')).json();
    const again = await result(await d.upload(token, { file: { filename: 'boundary.png', contentType: 'image/png', dataBase64: 'aW1hZ2U=' }, item_id: item.id }));
    expect(again.error).toBe(false); expect(again.value).toEqual({ ...attached.value, duplicate: true });
    expect(await storedCount()).toEqual(stored);
    expect(await (await d.fetch('/blyg/items/' + item.id + '.json')).json()).toEqual(after);
  });

  it('discovers uploadMedia for draft scopes', async () => {
    const d = await driver(), token = await d.credential(['owner:draft']);
    const response = await d.mcp(token, 'tools/list', {});
    expect(response.status).toBe(200);
    expect((await response.json() as any).result.tools.map((tool: any) => tool.name)).toContain('uploadMedia');
  });
  it('uses the same bytes, MIME types and attachment metadata as multipart REST', async () => {
    const d = await driver(), token = await d.credential(['owner:draft']);
    // One item per transport: the same file sent twice to one item is a
    // duplicate (studio#7) and would not exercise MCP's own write.
    const restItem = await (await d.owner('/blyg/api/items', { content_md: 'media parity (REST)' })).json() as any;
    const mcpItem = await (await d.owner('/blyg/api/items', { content_md: 'media parity (MCP)' })).json() as any;
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    for (const contentType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']) {
      const extra = { alt: 'a diagram', inline: 'true' };
      const rest = await d.restUpload(bytes, contentType, { item_id: restItem.id, ...extra }); expect(rest.status).toBe(201);
      const expected = await rest.json() as any;
      const observed = await result(await d.upload(token, { file: { filename: 'same-file.dat', contentType, dataBase64: base64(bytes) }, item_id: mcpItem.id, ...extra }));
      expect(observed.error).toBe(false); expect(observed.value.mime).toBe(expected.mime); expect(observed.value.duplicate).toBeUndefined();
      expect(observed.value.url.split('.').pop()).toBe(expected.url.split('.').pop());
      for (const [value, item] of [[expected, restItem], [observed.value, mcpItem]]) {
        expect((await d.fetch('/blyg/' + value.url)).status).toBe(404);
        const publicBytes = await d.fetch('/blyg/' + value.url, { headers: { cookie: d.cookie } }); expect(publicBytes.status).toBe(200);
        expect(publicBytes.headers.get('content-type')).toBe(contentType);
        expect(new Uint8Array(await publicBytes.arrayBuffer())).toEqual(bytes);
        expect(await env.DB.prepare('SELECT item_id, mime, alt, inline FROM media WHERE id = ?').bind(value.id).first()).toEqual({ item_id: item.id, mime: contentType, alt: 'a diagram', inline: 1 });
      }
    }
  });
  it('preserves the inclusive 5 MiB REST limit despite Base64 expansion', async () => {
    const d = await driver(), token = await d.credential(['owner:draft']);
    const bytes = new Uint8Array(5 * 1024 * 1024); bytes[0] = 17; bytes[bytes.length - 1] = 23;
    const rest = await d.restUpload(bytes, 'image/png'); expect(rest.status).toBe(201);
    const observed = await result(await d.upload(token, { file: { filename: 'big.png', contentType: 'image/png', dataBase64: base64(bytes) } }));
    expect(observed.error).toBe(false);
    const observedBytes = await (await d.fetch('/blyg/' + observed.value.url, { headers: { cookie: d.cookie } })).arrayBuffer();
    expect(observedBytes.byteLength).toBe(bytes.byteLength);
    expect(new Uint8Array(await crypto.subtle.digest('SHA-256', observedBytes))).toEqual(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  });
  it('rejects malformed encoding, unsupported types and over-limit files without R2 or row writes', async () => {
    const d = await driver(), token = await d.credential(['owner:draft']), before = await storedCount();
    for (const dataBase64 of ['%%%', 'A===', 'a', ' YQ==', 'YR==']) {
      expect((await result(await d.upload(token, { file: { filename: 'bad.png', contentType: 'image/png', dataBase64 } }))).error).toBe(true);
      expect(await storedCount()).toEqual(before);
    }
    const badType = await d.restUpload(new Uint8Array([1]), 'text/plain'); expect(badType.status).toBe(415);
    const observedType = await result(await d.upload(token, { file: { filename: 'bad.txt', contentType: 'text/plain', dataBase64: 'AQ==' } }));
    expect(observedType.error).toBe(true); expect(observedType.value).toEqual(await badType.json());
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    const restBig = await d.restUpload(big, 'image/png'); expect(restBig.status).toBe(413);
    const observedBig = await result(await d.upload(token, { file: { filename: 'big.png', contentType: 'image/png', dataBase64: base64(big) } }));
    expect(observedBig.error).toBe(true); expect(observedBig.value).toEqual(await restBig.json());
    expect(await storedCount()).toEqual(before);
  });
  it('bounds the expanded JSON envelope at 8 MiB before any media write', async () => {
    const d = await driver(), token = await d.credential(['owner:draft']), before = await storedCount();
    const response = await d.upload(token, { file: { filename: 'envelope.png', contentType: 'image/png', dataBase64: 'A'.repeat(8 * 1024 * 1024) } });
    expect(response.status).toBe(413); expect(await storedCount()).toEqual(before);
  });
  it('keeps read grants out of discovery and challenges direct upload calls with owner:draft', async () => {
    const d = await driver(), token = await d.credential(['owner:read']), before = await storedCount();
    const listed = await d.mcp(token, 'tools/list', {});
    expect((await listed.json() as any).result.tools.map((tool: any) => tool.name)).not.toContain('uploadMedia');
    const denied = await d.upload(token, { file: { filename: 'pic.png', contentType: 'image/png', dataBase64: 'AQ==' } });
    expect(denied.status).toBe(403); expect(denied.headers.get('www-authenticate')).toContain('scope="owner:draft"');
    expect(denied.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(await storedCount()).toEqual(before);
  });
});

it.each(['image/PNG', 'IMAGE/PNG', 'image/pNg'])('normalizes upload MIME like multipart File: %s', async contentType => {
  const d = await driver(), token = await d.credential(['owner:draft']);
  const rest = await d.restUpload(new Uint8Array([1, 2, 3]), contentType);
  expect(rest.status).toBe(201);
  const expected = await rest.json() as any;
  const uploaded = await result(await d.upload(token, { file: { filename: 'case.png', contentType, dataBase64: 'AQID' } }));
  expect(uploaded.error).toBe(false);
  expect(uploaded.value.mime).toBe('image/png');
  expect(uploaded.value.mime).toBe(expected.mime);
});
it('keeps the documented MCP envelope limit separate from the REST body cap', async () => {
  const d = await driver({ ...env, API_BODY_LIMIT: '128' }), token = await d.credential(['owner:draft']);
  const body = { content_md: 'x'.repeat(200) };
  expect((await d.owner('/blyg/api/items', body)).status).toBe(413);
  const value = await result(await d.mcp(token, 'tools/call', { name: 'createItem', arguments: { body } }));
  expect(value.error).toBe(false);
  expect(value.value.content_md).toBe(body.content_md);
});
