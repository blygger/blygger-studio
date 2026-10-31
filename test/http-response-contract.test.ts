import { testItemRevision } from './helpers.ts';
import { SELF, env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { makeApp } from '../src/index.ts';
import type { Env } from '../src/types.ts';
import { BASE, STUDIO, apiJson, createAndPublish, login } from './helpers.ts';
import { flow } from './oauth-flow-driver.ts';

const READER = 'https://reader.example.test';
const AUTH = `${STUDIO}/auth`;
const request = (path: string, init: RequestInit = {}) => SELF.fetch(new URL(path, BASE), { redirect: 'manual', ...init });
const headerTokens = (response: Response, name: string) => (response.headers.get(name) ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);

async function publishedFixture() {
  const cookie = await login();
  expect((await apiJson(cookie, 'PATCH', '/blyg/api/settings', { site_url: `${BASE}/blyg/` })).status).toBe(200);
  const id = await createAndPublish(cookie, 'HTTP response contract body');
  return { cookie, id };
}

async function assertValidates(path: string, etag: string, preserved: Headers) {
  const head = await request(path, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('etag')).toBe(etag);
  expect(head.headers.get('cache-control')).toBe(preserved.get('cache-control'));
  expect(await head.text()).toBe('');
  for (const method of ['GET', 'HEAD']) {
    for (const validator of [etag, etag.replace(/^W\//, ''), `"another-document", ${etag}`, '*']) {
      const response = await request(path, { method, headers: { 'If-None-Match': validator, Origin: READER } });
      expect(response.status, `${method} ${path} ${validator}`).toBe(304);
      expect(await response.text()).toBe('');
      for (const header of ['etag', 'cache-control', 'access-control-allow-origin', 'access-control-expose-headers']) {
        expect(response.headers.get(header), `${method} ${path} ${header}`).toBe(preserved.get(header));
      }
    }
  }
  const changed = await request(path, { headers: { 'If-None-Match': '"a-different-document"' } });
  expect(changed.status).toBe(200);
  expect(changed.headers.get('etag')).toBe(etag);
  await changed.arrayBuffer();
}

describe('public HTTP response contract', () => {
  it.each(['/blyg/style.css', `${STUDIO}/app.js`, `${STUDIO}/app.css`, `${STUDIO}/manifest.webmanifest`, `${STUDIO}/sw.js`, `${STUDIO}/icon.svg`, `${STUDIO}/icon-180.png`])('validates stable asset URL %s without an immutable promise', async path => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).not.toContain('immutable');
    const etag = response.headers.get('etag')!;
    expect(etag).toBeTruthy();
    await response.arrayBuffer();
    await assertValidates(path, etag, response.headers);
    if (path.endsWith('/sw.js')) {
      const validated = await request(path, { headers: { 'If-None-Match': etag } });
      expect(validated.headers.get('service-worker-allowed')).toBe(STUDIO);
    }
  });

  it('revalidates legacy public media URLs and keeps the same bytes', async () => {
    const { cookie, id } = await publishedFixture();
    const form = new FormData();
    form.set('file', new File(['fixed image bytes'], 'public.png', { type: 'image/png' }));
    (form.set('item_id', id), form.set('expectedRevision', String(await testItemRevision(id))));
    const uploaded = await request('/blyg/api/media', { method: 'POST', headers: { cookie }, body: form });
    expect(uploaded.status).toBe(201);
    const media = await uploaded.json<{ url: string }>();
    expect((await apiJson(cookie, 'POST', `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    const path = `/blyg/${media.url}`;
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, no-cache');
    const etag = response.headers.get('etag')!;
    expect(etag).toBeTruthy();
    expect(await response.text()).toBe('fixed image bytes');
    await assertValidates(path, etag, response.headers);
  });

  it('validates complete public JSON documents on GET and HEAD', async () => {
    const { cookie, id } = await publishedFixture();
    expect((await apiJson(cookie, 'PUT', `/blyg/api/items/${id}/versions/1/pin`)).status).toBe(200);
    for (const path of ['/blyg/blyg.json', '/blyg/items/index.json', `/blyg/items/${id}.json`, `/blyg/items/${id}/v1.json`]) {
      const response = await request(path, { headers: { Origin: READER } });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(headerTokens(response, 'access-control-expose-headers')).toContain('etag');
      const etag = response.headers.get('etag')!;
      expect(etag).toMatch(/^W\/"[^\"]+"$/);
      await response.json();
      await assertValidates(path, etag, response.headers);
    }
  });

  it('changes a live item validator when pinning changes only its changelog', async () => {
    const { cookie, id } = await publishedFixture();
    const path = `/blyg/items/${id}.json`;
    const first = await request(path);
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const before = await first.json<{ content_hash: string; changelog: Array<{ pinned?: boolean }> }>();
    expect(before.changelog[0].pinned).toBeUndefined();
    expect((await apiJson(cookie, 'PUT', `/blyg/api/items/${id}/versions/1/pin`)).status).toBe(200);
    const next = await request(path, { headers: { 'If-None-Match': etag } });
    expect(next.status).toBe(200);
    expect(next.headers.get('etag')).not.toBe(etag);
    const after = await next.json<typeof before>();
    expect(after.changelog[0].pinned).toBe(true);
    expect(after.content_hash).toBe(before.content_hash);
  });

  it('revalidates pinned metadata instead of treating its markdown hash as document identity', async () => {
    const { cookie, id } = await publishedFixture();
    expect((await apiJson(cookie, 'PUT', `/blyg/api/items/${id}/versions/1/pin`)).status).toBe(200);
    const path = `/blyg/items/${id}/v1.json`;
    const first = await request(path);
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const before = await first.json<{ content_md: string; content_hash: string; author: { name: string; url: string }; origin: string }>();
    expect((await apiJson(cookie, 'PATCH', '/blyg/api/settings', {
      author_name: 'Updated HTTP Author', author_url: 'https://author.example.test/', site_url: 'https://new-origin.example.test/notes/',
    })).status).toBe(200);
    const response = await request(path, { headers: { 'If-None-Match': etag } });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).not.toBe(etag);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    const after = await response.json<typeof before>();
    expect(after.content_md).toBe(before.content_md);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.author).toEqual({ name: 'Updated HTTP Author', url: 'https://author.example.test/' });
    expect(after.origin).toBe('https://new-origin.example.test/notes/');
    await assertValidates(path, response.headers.get('etag')!, response.headers);
  });

  it('keeps changing public absence uncached and readable across origins', async () => {
    const { cookie, id } = await publishedFixture();
    const draft = await apiJson(cookie, 'POST', '/blyg/api/items', { content_md: 'Private working copy' });
    expect(draft.status).toBe(201);
    for (const path of [`/blyg/items/${draft.json.id}.json`, '/blyg/items/http-contract-missing.json', `/blyg/items/${id}/v1.json`, '/blyg/blogroll.opml']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await request(path, { method, headers: { Origin: READER, 'If-None-Match': '*' } });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.headers.get('etag')).toBeNull();
        if (method === 'HEAD') expect(await response.text()).toBe('');
        else await response.arrayBuffer();
      }
    }
    expect((await apiJson(cookie, 'PUT', `/blyg/api/items/${id}/versions/1/pin`)).status).toBe(200);
    const available = await request(`/blyg/items/${id}/v1.json`, { headers: { Origin: READER } });
    expect(available.status).toBe(200);
    await available.arrayBuffer();
  });

  it('permits explicit browser validators and exposes the response ETag', async () => {
    const { id } = await publishedFixture();
    for (const path of ['/blyg/blyg.json', '/blyg/items/index.json', `/blyg/items/${id}.json`, '/blyg/feed.xml', '/blyg/blogroll.opml']) {
      const preflight = await request(path, {
        method: 'OPTIONS', headers: { Origin: READER, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'if-none-match' },
      });
      expect(preflight.status, path).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(headerTokens(preflight, 'access-control-allow-methods')).toEqual(expect.arrayContaining(['get', 'head']));
      expect(headerTokens(preflight, 'access-control-allow-headers')).toContain('if-none-match');
      expect(await preflight.text()).toBe('');
      const response = await request(path, { headers: { Origin: READER } });
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      // Empty OPML remains a readable 404; successful responses expose their validators.
      if (response.ok) {
        expect(response.headers.get('etag')).toBeTruthy();
        expect(headerTokens(response, 'access-control-expose-headers')).toContain('etag');
      }
      await response.arrayBuffer();
    }
  });
});

describe('private HTTP response contract', () => {
  it('serves private media to an explicit bearer reader with browser CORS and no-store', async () => {
    const cookie = await login();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const form = new FormData();
    form.set('file', new File([bytes], 'http-contract.png', { type: 'image/png' }));
    const uploaded = await request('/blyg/api/media', { method: 'POST', headers: { cookie }, body: form });
    expect(uploaded.status).toBe(201);
    const media = await uploaded.json<{ url: string }>();
    const grant = await apiJson(cookie, 'POST', '/blyg/api/authorizations', { name: 'HTTP media reader', scope: ['owner:read'], resource: 'api' });
    expect(grant.status).toBe(200);
    const path = `/blyg/${media.url}`;
    const preflight = await request(path, { method: 'OPTIONS', headers: { Origin: READER, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(headerTokens(preflight, 'access-control-allow-headers')).toContain('authorization');
    await preflight.arrayBuffer();
    const response = await request(path, { headers: { Authorization: `Bearer ${grant.json.access_token}`, Origin: READER } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const denied = await request(path, { headers: { Authorization: 'Bearer invalid-http-fixture', Origin: READER, 'If-None-Match': '*' } });
    expect(denied.status).toBe(404);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(denied.headers.get('access-control-allow-origin')).toBe('*');
    await denied.arrayBuffer();
  });

  it('sets no-store even when body limits reject before authentication or dispatch', async () => {
    const app = makeApp('/blyg');
    const cases: Array<{ path: string; body: string; bindings: Env }> = [
      { path: '/blyg/api/items', body: 'x'.repeat(33), bindings: { ...env, API_BODY_LIMIT: '32' } },
      { path: `${AUTH}/oauth2/register`, body: 'x'.repeat(1024 * 1024 + 1), bindings: env },
    ];
    for (const { path, body, bindings } of cases) {
      const ctx = createExecutionContext();
      const response = await app.fetch(new Request(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length), Origin: READER }, body }), bindings, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status, path).toBe(413);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
      await response.arrayBuffer();
    }
  });

  it('reports allowed API, authorization-management, OpenAPI and MCP methods', async () => {
    const cookie = await login();
    const grant = await apiJson(cookie, 'POST', '/blyg/api/authorizations', { name: 'HTTP MCP method fixture', scope: ['owner:read'], resource: 'mcp' });
    expect(grant.status).toBe(200);
    const cases: Array<{ path: string; method: string; expected: string[]; headers: Record<string, string> }> = [
      { path: '/blyg/api/settings', method: 'POST', expected: ['get', 'head', 'patch'], headers: { cookie } },
      { path: '/blyg/api/authorizations', method: 'PATCH', expected: ['delete', 'get', 'head', 'post'], headers: { cookie } },
      { path: '/blyg/api/authorizations/http-contract-missing', method: 'POST', expected: ['delete'], headers: { cookie } },
      { path: '/blyg/api/openapi.json', method: 'POST', expected: ['get', 'head'], headers: { cookie } },
      { path: `${STUDIO}/mcp`, method: 'PUT', expected: ['post'], headers: { Authorization: `Bearer ${grant.json.access_token}` } },
    ];
    for (const { path, method, expected, headers } of cases) {
      const response = await request(path, { method, headers });
      expect(response.status, path).toBe(405);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
      expect(headerTokens(response, 'allow').filter(value => value !== 'options').sort(), path).toEqual(expected);
      await response.arrayBuffer();
    }
    const missing = await request('/blyg/api/openapiXjson', { method: 'POST', headers: { cookie } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('allow')).toBeNull();
    await missing.arrayBuffer();
  });
});

describe('OAuth HTTP response contract', () => {
  it('revalidates JWKS with a public policy', async () => {
    const response = await request(`${AUTH}/jwks`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, no-cache');
    const etag = response.headers.get('etag')!;
    expect(etag).toBeTruthy();
    await response.json();
    await assertValidates(`${AUTH}/jwks`, etag, response.headers);
  });

  it('retains public metadata cache policy while applying CORS to native discovery responses', async () => {
    for (const path of [`${AUTH}/.well-known/openid-configuration`, `${AUTH}/.well-known/oauth-authorization-server`]) {
      const response = await request(path, { headers: { Origin: READER } });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('cache-control')).toContain('public');
      expect(response.headers.get('cache-control')).toMatch(/max-age=\d+/);
      expect((await response.json<{ issuer: string }>()).issuer).toBe(`${BASE}${AUTH}`);
      await assertValidates(path, response.headers.get('etag')!, response.headers);
    }
  });

  it('applies CORS and no-store to native token success and native invalid-grant responses', async () => {
    const f = await flow();
    const decision = await f.decide('browser-a', true);
    expect(decision.status).toBe(302);
    const code = new URL(decision.headers.get('location')!).searchParams.get('code')!;
    await decision.arrayBuffer();
    const exchange = (value: string) => f.request(`${f.issuer}/oauth2/token`, {
      method: 'POST', headers: { Origin: READER, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: value, client_id: f.client.client_id, redirect_uri: f.redirect, resource: `${f.base}/blyg/api`, code_verifier: f.verifier }),
    });
    const response = await exchange(code);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const tokens = await response.json<{ access_token: string }>();
    expect(tokens.access_token).toBeTruthy();
    const invalid = await exchange('nonexistent-http-contract-code');
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('cache-control')).toBe('no-store');
    expect(invalid.headers.get('access-control-allow-origin')).toBe('*');
    expect((await invalid.json<{ error: string }>()).error).toBe('invalid_grant');
  });

  it('never enables CORS on authorization, including trailing slash and preflight', async () => {
    for (const suffix of ['', '/']) {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const response = await request(`${AUTH}/oauth2/authorize${suffix}`, {
          method, headers: { Origin: READER, ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'GET' } : {}) },
        });
        expect(response.headers.get('cache-control')).toBe('no-store');
        for (const header of ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-allow-credentials']) {
          expect(response.headers.get(header), `${method} ${suffix} ${header}`).toBeNull();
        }
        await response.arrayBuffer();
      }
    }
  });
});
