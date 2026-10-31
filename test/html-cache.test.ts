import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.ts';
import { htmlCacheResponse, publicHtmlKey, publicHtmlRequest, publicHtmlRevision } from '../src/html-cache.ts';
import { readChanges } from '../src/changes.ts';
import { BASE, login, createAndPublish, apiJson, getPublic } from './helpers.ts';
import { markInboundUnverified, markInboundVerified, setMentionHidden, upsertInbound } from '../src/mentions/store.ts';

const EDGE = 'public, max-age=60, stale-while-revalidate=300, stale-if-error=0';

describe('public HTML caching', () => {
  it('gives the homepage a stable ETag and separate browser/edge policies', async () => {
    const first = await SELF.fetch(`${BASE}/blyg/`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-cache');
    expect(first.headers.get('cloudflare-cdn-cache-control')).toBe(EDGE);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^W\/"[a-f0-9]{64}"$/);
    expect(await first.text()).toContain('<!doctype html>');
    const second = await SELF.fetch(`${BASE}/blyg/`);
    expect(second.headers.get('etag')).toBe(etag);
    await second.arrayBuffer();
  });

  it('validates weak, strong, list and wildcard ETags, including HEAD', async () => {
    const first = await SELF.fetch(`${BASE}/blyg/`);
    const etag = first.headers.get('etag')!;
    await first.arrayBuffer();
    for (const validator of [etag, etag.slice(2), `"other", ${etag}`, '*']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await SELF.fetch(`${BASE}/blyg/`, { method, headers: { 'if-none-match': validator } });
        expect(response.status).toBe(304);
        expect(response.headers.get('etag')).toBe(etag);
        expect(response.headers.get('cache-control')).toBe('no-cache');
        expect(await response.text()).toBe('');
      }
    }
    const head = await SELF.fetch(`${BASE}/blyg/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(etag);
    expect(await head.text()).toBe('');
  });

  it('changes the validator when generated HTML changes', async () => {
    const first = await SELF.fetch(`${BASE}/blyg/`);
    const etag = first.headers.get('etag')!;
    await first.arrayBuffer();
    await env.DB.prepare("INSERT INTO settings(key,value) VALUES('site_title','Changed cache title') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    const next = await SELF.fetch(`${BASE}/blyg/`, { headers: { 'if-none-match': etag } });
    expect(next.status).toBe(200);
    expect(next.headers.get('etag')).not.toBe(etag);
    expect(await next.text()).toContain('Changed cache title');
  });

  it('covers archives, permalinks and pinned HTML without caching missing pages', async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, 'HTML cache item');
    expect((await apiJson(cookie, 'PUT', `/blyg/api/items/${id}/versions/1/pin`)).status).toBe(200);
    for (const path of ['/archive/', `/f/${id}/`, `/f/${id}/v1/`]) {
      const response = await SELF.fetch(`${BASE}/blyg${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('etag'), path).toMatch(/^W\//);
      expect(response.headers.get('cloudflare-cdn-cache-control'), path).toBe(EDGE);
      await response.arrayBuffer();
    }
    for (const path of ['/f/missing/', '/h/missing/', `/t/${id}/`]) {
      const response = await SELF.fetch(`${BASE}/blyg${path}`, { headers: { 'if-none-match': '*' } });
      expect(response.status, path).toBe(404);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
      expect(response.headers.has('cloudflare-cdn-cache-control'), path).toBe(false);
      await response.arrayBuffer();
    }
  });

  it('leaves private and wire responses outside the HTML policy', async () => {
    for (const path of ['/blyg/api/settings', '/blyg/studio/login', '/blyg/blyg.json', '/blyg/style.css', '/blyg/feed.xml']) {
      const response = await SELF.fetch(`${BASE}${path}`);
      expect(response.headers.has('cloudflare-cdn-cache-control'), path).toBe(false);
      await response.arrayBuffer();
    }
  });

  it('preserves public response headers and excludes cookie-setting responses and errors', async () => {
    const response = await htmlCacheResponse(new Request(BASE), new Response('<p>public</p>', { headers: { 'content-type': 'text/html', Link: '</webmention>; rel="webmention"' } }));
    expect(response.headers.get('link')).toBe('</webmention>; rel="webmention"');
    await response.arrayBuffer();
    const excludedResponses = [
      new Response('error', { status: 500 }),
      new Response('private', { headers: { 'content-type': 'text/html', 'cache-control': 'private' } }),
      new Response('no-store', { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } }),
      new Response('login', { headers: { 'content-type': 'text/html', 'set-cookie': 'session=test' } }),
    ];
    for (const source of excludedResponses) {
      const response = await htmlCacheResponse(new Request(BASE), source);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.has('cloudflare-cdn-cache-control')).toBe(false);
      expect(response.headers.has('etag')).toBe(false);
      await response.arrayBuffer();
    }
  });
});

describe('cached entrypoint dispatch', () => {
  it.each(['', '/blyg', '/notes/b'])('routes only public HTML reads under mount %s', mount => {
    for (const page of ['', '/', '/archive/', '/f/id', '/t/id/v2/', '/h/collection']) {
      expect(publicHtmlRequest(new Request(`${BASE}${mount}${page}`), mount)).toBe(true);
    }
    // Any free single segment may be the posts page (its address is a setting),
    // so it enters; a wrong one renders a 404, which is never cached.
    expect(publicHtmlRequest(new Request(`${BASE}${mount}/unknown`), mount)).toBe(true);
    for (const page of ['/studio', '/studio/login', '/feed.xml', '/items/id.json', '/media/image.jpg', '/unknown/deeper', '/feed']) {
      expect(publicHtmlRequest(new Request(`${BASE}${mount}${page}`), mount)).toBe(false);
    }
    expect(publicHtmlRequest(new Request(`${BASE}/blyg/api/settings`), mount)).toBe(false);
    expect(publicHtmlRequest(new Request(`${BASE}${mount}/`, { method: 'POST' }), mount)).toBe(false);
    if (mount) expect(publicHtmlRequest(new Request(`${BASE}${mount}extra/`), mount)).toBe(false);
  });

  it('shares tracking-query and slash variants but separates hosts, schemes and paths', () => {
    expect(publicHtmlKey(new Request(`${BASE}/blyg/?utm_source=test`))).toBe(`${BASE}/blyg`);
    expect(publicHtmlKey(new Request(`${BASE}/blyg`))).toBe(`${BASE}/blyg`);
    expect(publicHtmlKey(new Request('https://other.example/blyg/'))).not.toBe(`${BASE}/blyg`);
    expect(publicHtmlKey(new Request('http://example.com/blyg/'))).not.toBe(`${BASE}/blyg`);
    expect(publicHtmlKey(new Request(`${BASE}/blyg/archive/`))).not.toBe(`${BASE}/blyg`);
  });

  it('validates reloads against cached bytes and shares GET/HEAD without forcing refresh', async () => {
    const headers = { 'content-type': 'text/html', etag: 'W/"saved"', 'cache-control': 'no-cache' };
    const ctx = { exports: { PublicHtml: { fetch: (req: Request) => {
      expect(req.method).toBe('GET');
      for (const name of ['cache-control', 'pragma', 'if-none-match', 'if-modified-since']) expect(req.headers.has(name), name).toBe(false);
      return Promise.resolve(new Response('saved HTML', { headers }));
    } } } } as unknown as ExecutionContext;
    for (const method of ['GET', 'HEAD']) {
      const response = await worker.fetch(new Request(`${BASE}/blyg/`, { method, headers: { 'cache-control': 'max-age=0', pragma: 'no-cache', 'if-none-match': '"saved"', 'if-modified-since': 'Tue, 06 Oct 2026 00:00:00 GMT' } }), env, ctx);
      expect(response.status).toBe(304);
      expect(await response.text()).toBe('');
    }
    const head = await worker.fetch(new Request(`${BASE}/blyg/`, { method: 'HEAD' }), env, ctx);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('ignores HTML ranges before browser validation, including HEAD', async () => {
    const ctx = { exports: { PublicHtml: { fetch: (req: Request) => {
      const headers = { 'content-type': 'text/html', etag: 'W/"saved"' };
      // Workers Cache can produce a range response before the gateway runs.
      if (req.headers.has('range')) {
        return Promise.resolve(new Response('saved', { status: 206, headers: { ...headers, 'content-range': 'bytes 0-4/10' } }));
      }
      expect(req.headers.has('if-range')).toBe(false);
      return Promise.resolve(new Response('saved HTML', { headers }));
    } } } } as unknown as ExecutionContext;
    for (const method of ['GET', 'HEAD']) {
      const matched = await worker.fetch(new Request(`${BASE}/blyg/`, {
        method, headers: { range: 'bytes=0-4', 'if-range': '"saved"', 'if-none-match': '"saved"' },
      }), env, ctx);
      expect(matched.status).toBe(304);
      expect(await matched.text()).toBe('');
      const unmatched = await worker.fetch(new Request(`${BASE}/blyg/`, {
        method, headers: { range: 'bytes=0-4', 'if-range': '"saved"' },
      }), env, ctx);
      expect(unmatched.status).toBe(200);
      expect(await unmatched.text()).toBe(method === 'HEAD' ? '' : 'saved HTML');
    }
  });

  it('passes the origin-specific key to the cache without rendering in the gateway', async () => {
    let seen: unknown;
    const cached = new Response('saved HTML');
    const ctx = { exports: { PublicHtml: { fetch: (req: Request, init: unknown) => { seen = { url: req.url, init }; return Promise.resolve(cached); } } } } as unknown as ExecutionContext;
    const response = await worker.fetch(new Request(`${BASE}/blyg/?utm_source=test`), env, ctx);
    expect(response).toBe(cached);
    const revision = publicHtmlRevision(await readChanges(env.DB));
    expect(seen).toEqual({ url: `${BASE}/blyg/?utm_source=test`, init: { cf: { cacheKey: `${BASE}/blyg?rev=${revision}` } } });
  });

  it('moves every page to a fresh cache entry when a publish or setting changes', async () => {
    const keys: string[] = [];
    const ctx = { exports: { PublicHtml: { fetch: (_req: Request, init: { cf: { cacheKey: string } }) => {
      keys.push(init.cf.cacheKey);
      return Promise.resolve(new Response('saved HTML'));
    } } } } as unknown as ExecutionContext;
    const keyFor = async (path: string) => {
      await (await worker.fetch(new Request(`${BASE}/blyg${path}`), env, ctx)).arrayBuffer();
      return keys.at(-1)!;
    };
    const before = await keyFor('/');
    expect(await keyFor('/')).toBe(before);
    expect(await keyFor('/archive/')).toMatch(/\/blyg\/archive\?rev=/);

    const cookie = await login();
    await createAndPublish(cookie, 'Shows without waiting for the edge');
    const afterPublish = await keyFor('/');
    expect(afterPublish).not.toBe(before);

    await env.DB.prepare("INSERT INTO settings(key,value) VALUES('site_title','Revision title') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    const afterSetting = await keyFor('/');
    expect(afterSetting).not.toBe(afterPublish);

    // The owner's private reading and thumbs never empty the public cache.
    await env.DB.prepare('UPDATE change_state SET reading=reading+1, signals=signals+1 WHERE id=1').run();
    expect(await keyFor('/')).toBe(afterSetting);
  });

  it('a verified response, a hide and a show move the key; a pending claim, its failure and outbound work do not', async () => {
    const keys: string[] = [];
    const ctx = { exports: { PublicHtml: { fetch: (_req: Request, init: { cf: { cacheKey: string } }) => {
      keys.push(init.cf.cacheKey);
      return Promise.resolve(new Response('saved HTML'));
    } } } } as unknown as ExecutionContext;
    const keyFor = async () => {
      await (await worker.fetch(new Request(`${BASE}/blyg/`), env, ctx)).arrayBuffer();
      return keys.at(-1)!;
    };
    const cookie = await login();
    const item = await createAndPublish(cookie, 'Responses roll the public key');
    const found = { relation: 'stub' as const, sourceOrigin: 'https://responder.example/', sourceId: 'r1', sourceKind: 'thread', sourceVersion: 1, authorJson: null, sourcePage: 't/r1/' };
    const start = await keyFor(), changesAt = await readChanges(env.DB);

    // Anyone can make a claim. Neither the claim nor its failure is public.
    const spam = await upsertInbound(env.DB, 'https://spam.example/x', `${BASE}/blyg/f/${item}/`, item);
    await markInboundUnverified(env.DB, spam.id, 'failed', 'no link');
    expect(await keyFor()).toBe(start);
    // The Studio lists only verified and gone rows, so its counter stays too.
    expect((await readChanges(env.DB)).domains.mentions).toBe(changesAt.domains.mentions);
    // Outbound sends are the Studio's business, never the public page's.
    await env.DB.prepare("INSERT INTO mentions_out(id,item_id,version,target,status,created) VALUES('out-key',?,1,'https://x.example/','pending','t')").bind(item).run();
    await env.DB.prepare("UPDATE mentions_out SET status='sent',attempts=1 WHERE id='out-key'").run();
    expect(await keyFor()).toBe(start);
    const outbound = await readChanges(env.DB);
    expect(outbound.domains.mentions).toBeGreaterThan(changesAt.domains.mentions);
    expect(outbound.domains.responses).toBe(changesAt.domains.responses);

    const claim = await upsertInbound(env.DB, 'https://responder.example/t/r1/', `${BASE}/blyg/f/${item}/`, item);
    expect(await keyFor()).toBe(start);
    await markInboundVerified(env.DB, claim.id, found);
    const verified = await keyFor();
    expect(verified).not.toBe(start);
    await setMentionHidden(env.DB, claim.id, true);
    const hidden = await keyFor();
    expect(hidden).not.toBe(verified);
    // Re-verifying a hidden row is invisible to readers.
    await upsertInbound(env.DB, 'https://responder.example/t/r1/', `${BASE}/blyg/f/${item}/`, item);
    await markInboundVerified(env.DB, claim.id, found);
    expect(await keyFor()).toBe(hidden);
    await setMentionHidden(env.DB, claim.id, false);
    expect(await keyFor()).not.toBe(hidden);
  });

  // The test pool has no persistent edge cache, so this witnesses what the page
  // renders; the key test above is what keeps a cached entry from outliving it.
  it('the item page renders a newly verified response and drops it when hidden', async () => {
    const cookie = await login();
    const item = await createAndPublish(cookie, 'Cached page awaiting a response');
    expect((await apiJson(cookie, 'PATCH', `/blyg/api/items/${item}`, { responses: 'show' })).status).toBe(200);
    const path = `/blyg/f/${item}/`;
    const first = await (await getPublic(path)).text();
    expect(first).not.toContain('responder.example');
    const claim = await upsertInbound(env.DB, 'https://responder.example/t/r2/', `${BASE}${path}`, item);
    await markInboundVerified(env.DB, claim.id, { relation: 'stub', sourceOrigin: 'https://responder.example/', sourceId: 'r2', sourceKind: 'thread', sourceVersion: 1, authorJson: JSON.stringify({ name: 'Prompt responder' }), sourcePage: 't/r2/' });
    expect(await (await getPublic(path)).text()).toContain('Prompt responder');
    await setMentionHidden(env.DB, claim.id, true);
    expect(await (await getPublic(path)).text()).not.toContain('Prompt responder');
  });

  it('still serves public HTML under the plain key when the revision cannot be read', async () => {
    let key: unknown;
    const ctx = { exports: { PublicHtml: { fetch: (_req: Request, init: { cf: { cacheKey: string } }) => {
      key = init.cf.cacheKey;
      return Promise.resolve(new Response('saved HTML'));
    } } } } as unknown as ExecutionContext;
    const broken = { ...env, DB: { prepare: () => { throw new Error('D1 down'); } } } as unknown as typeof env;
    const response = await worker.fetch(new Request(`${BASE}/blyg/`), broken, ctx);
    expect(await response.text()).toBe('saved HTML');
    expect(key).toBe(`${BASE}/blyg`);
  });
});
