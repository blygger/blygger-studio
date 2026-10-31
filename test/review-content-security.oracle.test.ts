import { testRevisionBody } from './helpers.ts';
/**
 * R01/R02: imported markup and attribution fields are data even when quoted by
 * the owner. OWASP XSS guidance requires safe HTML and attribute contexts:
 * https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
 * Model: a safe paragraph/link survives; script/event/active URL authority never
 * crosses preview -> published thread -> owner history. Attribution bytes cannot
 * create an extra element or an active-scheme link. Expectations do not call the
 * production sanitizer or escaping helper. The driver seeds raw native imports,
 * uses real owner REST create/publish/preview/history, then public page handlers.
 * Limits: fixed stored-input histories, complemented by actual browser execution;
 * this is not a proof of all HTML grammars or deployed CSP behavior.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { decodeHTMLAttribute } from 'entities';
import { makeApp } from '../src/index.ts';
const sourceId = '00000000000000000000000001';
const app = makeApp('/blyg'), base = 'https://review-content.example.test';
async function receive(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(base + path, init), env, ctx);
  await waitOnExecutionContext(ctx); return response;
}
async function setup(html: string, page = 'post') {
  await env.DB.prepare("DELETE FROM hopper_items WHERE hopper_id = 'review-hopper'").run();
  await env.DB.prepare("DELETE FROM hoppers WHERE id = 'review-hopper'").run();
  await env.DB.prepare("DELETE FROM imported_items WHERE subscription_id = 'review-native'").run();
  await env.DB.prepare("DELETE FROM subscriptions WHERE id = 'review-native'").run();
  const login = await receive('/blyg/studio/login', { method: 'POST', headers: { 'CF-Connecting-IP': 'fd00:' + crypto.randomUUID().replaceAll('-', '').match(/.{4}/g)!.slice(0,7).join(':') }, body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
  expect(login.status).toBe(302); const cookie = login.headers.get('set-cookie')!.split(';')[0];
  await env.DB.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES ('review-native','blyg','https://publisher.example/','https://publisher.example/feed','Publisher','2026-10-01')").run();
  await env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_html,l0,page) VALUES ('review-native',?,'fragment','current',1,'2026-10-01',?,0,?)").bind(sourceId, html, page).run();
  const owner = async (path: string, method = 'GET', body?: unknown) => { body = await testRevisionBody(method, path, body); return receive(path, { method, headers: { cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); };
  return { owner, cookie };
}
// Public pages carry their own trusted inline scripts, so script elements are
// judged only inside the article. Attributes are judged on the whole page: the
// masthead and navigation render delegated settings too. Values are decoded as
// a browser decodes them before the scheme is read.
async function inert(html: string, law: string, publicPage = false) {
  const violations: string[] = [];
  let depth = 0;
  await new HTMLRewriter().on('article', { element(el) { depth++; el.onEndTag(() => { depth--; }); } }).on('*', { element(el) {
    if ((!publicPage || depth > 0) && ['script','svg','iframe','math'].includes(el.tagName)) violations.push(el.tagName);
    for (const [key, value] of el.attributes) {
      if (/^on/i.test(key)) violations.push(key);
      if (!['href','src','xlink:href','action','formaction'].includes(key)) continue;
      let protocol = 'invalid:';
      try { protocol = new URL(decodeHTMLAttribute(value), base).protocol; } catch { /* unparseable URLs are not followable */ }
      if (['javascript:','data:','vbscript:'].includes(protocol)) violations.push(key + '=' + value.slice(0, 40));
    }
  } }).transform(new Response(html)).text();
  expect(violations, law).toEqual([]);
}
it.each(['preview', 'publication', 'history'])('keeps remote HTML inert in transclusion %s', async surface => {
  const f = await setup('<p>Safe quoted text <a href="https://safe.example/">safe link</a></p><img src="/missing" onerror="document.documentElement.dataset.compromised=1"><svg onload="document.documentElement.dataset.compromised=1"></svg>');
  const content_md = `![[${sourceId}]]`;
  const preview = await f.owner('/blyg/api/preview', 'POST', { kind: 'thread', content_md }); expect(preview.status).toBe(200);
  const p = await preview.json() as { html: string; errors: unknown[] };
  expect(p.errors).toEqual([]); expect(p.html).toContain('Safe quoted text');
  expect(p.html).toContain('href="https://safe.example/"');
  if (surface === 'preview') return inert(p.html, 'transclusion preview cannot execute imported HTML');
  const created = await f.owner('/blyg/api/items', 'POST', { kind: 'thread', content_md }); expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };
  expect((await f.owner(`/blyg/api/items/${id}/publish`, 'POST')).status).toBe(200);
  const publicPage = await receive(`/blyg/t/${id}/`); expect(publicPage.status).toBe(200);
  if (surface === 'publication') return inert(await publicPage.text(), 'published transclusion cannot execute imported HTML', true);
  const history = await f.owner(`/blyg/api/items/${id}/versions/1`); expect(history.status).toBe(200);
  const h = await history.json() as { content_html: string };
  await inert(h.content_html, 'history cannot execute imported HTML');
});
// §5.2/§10.2: publish bakes the target's content_html verbatim into the
// thread's content_html; sanitizing belongs to every render (above), never to
// the published bytes. The protocol JSON carries the source exactly.
it('bakes remote HTML verbatim into the published thread document', async () => {
  const source = '<p>Quoted <a href="https://safe.example/">link</a></p><picture><source srcset="https://publisher.example/a.webp"><img src="https://publisher.example/a.png" onerror="x()"></picture>';
  const f = await setup(source);
  const created = await f.owner('/blyg/api/items', 'POST', { kind: 'thread', content_md: `![[${sourceId}]]` }); expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };
  expect((await f.owner(`/blyg/api/items/${id}/publish`, 'POST')).status).toBe(200);
  const document = await (await receive(`/blyg/items/${id}.json`)).json() as { content_html: string };
  expect(document.content_html).toContain(`>\n${source}\n</blockquote>`);
});
it('remote attribution cannot inject elements into a public hopper', async () => {
  const f = await setup('<p>Safe quoted text</p>', 'post"><img src="/missing" onerror="document.documentElement.dataset.compromised=1">');
  await env.DB.prepare("INSERT INTO hoppers(id,name,slug,public,created) VALUES ('review-hopper','Review','review',1,'2026-10-01')").run();
  await env.DB.prepare("INSERT INTO hopper_items(hopper_id,subscription_id,remote_id,added_at) VALUES ('review-hopper','review-native',?,'2026-10-01')").bind(sourceId).run();
  const response = await receive('/blyg/h/review/'); expect(response.status).toBe(200);
  await inert(await response.text(), 'remote page must stay within its href attribute', true);
  expect((await f.owner('/blyg/api/settings')).status).toBe(200);
});
it('remote attribution cannot inject elements into public transclusion provenance', async () => {
  const f = await setup('<p>Safe quoted text</p>', 'post"><img src="/missing" onerror="document.documentElement.dataset.compromised=1">');
  const created = await f.owner('/blyg/api/items', 'POST', { kind: 'thread', content_md: `![[${sourceId}]]` }); expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };
  expect((await f.owner(`/blyg/api/items/${id}/publish`, 'POST')).status).toBe(200);
  const response = await receive(`/blyg/t/${id}/`); expect(response.status).toBe(200);
  await inert(await response.text(), 'provenance href cannot create attacker markup', true);
});

// Already-published bytes are immutable protocol history. Upgrade safety requires
// inert presentation of old bakes without silently rewriting their stored/wire
// snapshot. These witnesses seed the pre-fix shape, not a fresh safe publication.
it.each(['public', 'pin', 'history', 'detail', 'reading'])('renders legacy bakes inert in %s without changing their snapshot', async surface => {
  const f = await setup('<p>Safe quoted text</p>');
  const created = await f.owner('/blyg/api/items', 'POST', { kind: 'thread', content_md: `![[${sourceId}]]` });
  expect(created.status).toBe(201); const { id } = await created.json() as { id: string };
  expect((await f.owner(`/blyg/api/items/${id}/publish`, 'POST')).status).toBe(200);
  const legacy = '<blockquote class="blyg-transclusion" data-blyg-id="' + sourceId + '"><p>Legacy safe text</p><img src="/missing" onerror="document.documentElement.dataset.compromised=1"></blockquote>';
  await env.DB.prepare('UPDATE versions SET content_html=?, pinned=1 WHERE item_id=? AND version=1').bind(legacy, id).run();
  const paths = { public: `/blyg/t/${id}/`, pin: `/blyg/t/${id}/v1/`, history: `/blyg/api/items/${id}/versions/1`, detail: `/blyg/api/items/${id}`, reading: '/blyg/api/reading?sub=own' };
  const response = await f.owner(paths[surface as keyof typeof paths]); expect(response.status).toBe(200);
  let html: string;
  if (surface === 'public' || surface === 'pin') html = await response.text();
  else {
    const value = await response.json() as any;
    html = surface === 'history' ? value.content_html : surface === 'detail' ? value.versions[0].content_html : value.items.find((entry: any) => entry.own?.id === id).contentHtml;
  }
  expect(html).toContain('Legacy safe text');
  await inert(html, 'legacy snapshot cannot regain script authority during presentation', surface === 'public' || surface === 'pin');
  const wire = await receive(`/blyg/items/${id}/v1.json`); expect(wire.status).toBe(200);
  expect((await wire.json() as {content_html:string}).content_html).toBe(legacy);
  expect((await env.DB.prepare('SELECT content_html FROM versions WHERE item_id=? AND version=1').bind(id).first<{content_html:string}>())!.content_html).toBe(legacy);
});
// A draft-only token writes the citation. Only http(s) citations are data a
// reader can follow, so an active scheme is refused before anyone publishes it.
it.each([
  ['cited.url', { url: 'https://cited.example/p', cited: { source: 'Cited', url: 'javascript:document.documentElement.dataset.compromised=1', retrieved: '2026-10-01T00:00:00Z' } }],
  ['stub_of.url', { url: 'javascript:document.documentElement.dataset.compromised=1' }],
])('a delegated %s with an active scheme is refused', async (_field, stub_of) => {
  const { flow } = await import('./oauth-flow-driver.ts');
  const f = await flow();
  const minted = await f.request('/blyg/api/authorizations', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'citation drafter', scope: ['owner:draft'], resource: 'api' }) });
  expect(minted.status).toBe(200);
  const { access_token } = await minted.json() as { access_token: string };
  const draft = async (path: string, method: string, body: unknown) => f.request(path, { method, headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' }, body: JSON.stringify(await testRevisionBody(method, path, body)) });
  const created = await draft('/blyg/api/items', 'POST', { kind: 'thread', content_md: 'A response' });
  expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };
  expect((await draft('/blyg/api/items/' + id, 'PATCH', { stub_of })).status, 'active-scheme citations are refused at write').toBe(400);
  expect((await draft('/blyg/api/items/' + id, 'PATCH', { stub_of: { url: 'https://cited.example/p', cited: { source: 'Cited', url: 'https://cited.example/p', retrieved: '2026-10-01T00:00:00Z' } } })).status, 'an http(s) citation stays writable').toBe(200);
});
// Rows stored before the 0.27 write check reach the same anchors. Rendering
// must keep them inert on its own. Fork citations come from our own origin or
// a remote origin prefix today; the fork_cite case is defense in depth.
it.each([
  ['stub_cite.url', { stub_of: '{"url":"https://cited.example/p"}', stub_cite: '{"source":"S","url":"javascript:document.documentElement.dataset.compromised=1","retrieved":"2026-10-01T00:00:00Z"}' }, {}],
  ['stub_of.url', { stub_of: '{"url":"javascript:document.documentElement.dataset.compromised=1"}', stub_cite: null }, {}],
  ['fork_cite.url', {}, { forked_from: '{"origin":"https://fork.example/","id":"0000000000000000000000000f","version":1}', fork_cite: '{"source":"F","url":"javascript:document.documentElement.dataset.compromised=1","retrieved":"2026-10-01T00:00:00Z"}' }],
] as const)('a stored %s cannot become an active link on public pages', async (_field, version, item) => {
  const f = await setup('<p>unused</p>');
  const created = await f.owner('/blyg/api/items', 'POST', { kind: 'thread', content_md: 'A response' }); expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };
  expect((await f.owner(`/blyg/api/items/${id}/publish`, 'POST')).status).toBe(200);
  // Observe the seeded field itself: native D1 change counts also include
  // tracking writes, and null/no-op assignments deliberately do not track.
  for (const [column, value] of Object.entries(version)) expect(await env.DB.prepare(`UPDATE versions SET ${column}=? WHERE item_id=? AND version=1 RETURNING ${column} AS value`).bind(value, id).first()).toEqual({ value });
  for (const [column, value] of Object.entries(item)) expect(await env.DB.prepare(`UPDATE items SET ${column}=? WHERE id=? RETURNING ${column} AS value`).bind(value, id).first()).toEqual({ value });
  for (const path of [`/blyg/t/${id}/`, '/blyg/']) {
    const page = await receive(path); expect(page.status).toBe(200);
    const html = await page.text();
    expect(html, 'the stored citation reaches ' + path).toMatch(/stub-cite/);
    await inert(html, 'stored citation cannot create an active link on ' + path, true);
  }
});
// The contrast: the same stored path keeps a real citation followable, so a
// renderer that dropped every link could not pass the law above.
it('a stored https citation stays a working link', async () => {
  const f = await setup('<p>unused</p>');
  const created = await f.owner('/blyg/api/items', 'POST', { kind: 'thread', content_md: 'A response' }); expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };
  expect((await f.owner(`/blyg/api/items/${id}/publish`, 'POST')).status).toBe(200);
  await env.DB.prepare('UPDATE versions SET stub_of=?, stub_cite=? WHERE item_id=?').bind('{"url":"https://cited.example/p"}', '{"source":"S","url":"https://cited.example/p?a=1&b=2","retrieved":"2026-10-01T00:00:00Z"}', id).run();
  for (const path of [`/blyg/t/${id}/`, '/blyg/']) expect(await (await receive(path)).text(), 'a safe citation keeps its exact link on ' + path).toContain('href="https://cited.example/p?a=1&amp;b=2"');
});
// Author links render on every public page and travel in blyg.json. A
// manage-scoped token writes them; only followable schemes are data.
it('author links refuse active schemes on write and render inert from stored rows', async () => {
  // Sweeps write many times a minute; each starts with fresh work budgets.
  await env.DB.prepare('DELETE FROM security_budgets').run();
  const { flow } = await import('./oauth-flow-driver.ts');
  const f = await flow();
  const minted = await f.request('/blyg/api/authorizations', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'settings manager', scope: ['owner:manage'], resource: 'api' }) });
  expect(minted.status).toBe(200);
  const { access_token } = await minted.json() as { access_token: string };
  const manage = (author_links: unknown) => f.request('/blyg/api/settings', { method: 'PATCH', headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ author_links }) });
  for (const url of ['javascript:document.documentElement.dataset.compromised=1', ' JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>'])
    expect((await manage([{ label: 'me', url }])).status, 'active-scheme author links are refused at write').toBe(400);
  expect((await manage([{ label: 'me', url: 'https://me.example/' }, { label: 'mail', url: 'mailto:me@example.test' }])).status, 'followable author links stay writable').toBe(200);
  const kept = await (await f.request('/blyg/')).text();
  expect(kept, 'a safe author link keeps its exact href').toContain('href="https://me.example/"');
  await env.DB.prepare("UPDATE settings SET value=? WHERE key='author_links'").bind(JSON.stringify([{ label: 'me', url: 'javascript:document.documentElement.dataset.compromised=1' }])).run();
  for (const path of ['/blyg/', '/blyg/archive/']) {
    const page = await f.request(path); expect(page.status).toBe(200);
    await inert(await page.text(), 'stored author links cannot create an active link on ' + path, true);
  }
  const manifest = await (await f.request('/blyg/blyg.json')).json() as { author: { links: { url: string }[] } };
  expect(manifest.author.links.map(link => link.url), 'the manifest does not publish an active-scheme author link').toEqual([]);
});
// Inventory law, not a list of known sinks: every string a manage-scoped token
// can store is hostile data on every public HTML page. A baseline crawl fixes
// the page's own script count, so an injected script anywhere is caught too.
it('no manage-writable setting can activate markup on any public page', async () => {
  // Sweeps write many times a minute; each starts with fresh work budgets.
  await env.DB.prepare('DELETE FROM security_budgets').run();
  const { flow } = await import('./oauth-flow-driver.ts');
  const f = await flow();
  const minted = await f.request('/blyg/api/authorizations', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'settings sweep', scope: ['owner:manage'], resource: 'api' }) });
  expect(minted.status).toBe(200);
  const { access_token } = await minted.json() as { access_token: string };
  const owner = async (path: string, method: string, body?: unknown) => { body = await testRevisionBody(method, path, body); return f.request(path, { method, headers: { cookie: f.owner, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); };
  const fragment = await (await owner('/blyg/api/items', 'POST', { content_md: 'Sweep fragment' })).json() as { id: string };
  const thread = await (await owner('/blyg/api/items', 'POST', { kind: 'thread', content_md: 'Sweep thread' })).json() as { id: string };
  for (const id of [fragment.id, thread.id]) expect((await owner(`/blyg/api/items/${id}/publish`, 'POST')).status).toBe(200);
  expect((await owner(`/blyg/api/items/${fragment.id}/versions/1/pin`, 'PUT')).status).toBe(200);
  await env.DB.prepare("INSERT OR REPLACE INTO hoppers(id,name,slug,public,created) VALUES ('sweep-hopper','Sweep','sweep',1,'2026-10-01')").run();
  const pages = ['/blyg/', '/blyg/archive/', `/blyg/f/${fragment.id}/`, `/blyg/t/${thread.id}/`, `/blyg/f/${fragment.id}/v1/`, '/blyg/h/sweep/'];
  const scripts = async (html: string) => { let n = 0; await new HTMLRewriter().on('script', { element() { n++; } }).transform(new Response(html)).text(); return n; };
  const baseline = new Map<string, number>();
  for (const path of pages) { const page = await f.request(path); expect(page.status, path).toBe(200); baseline.set(path, await scripts(await page.text())); }
  const payloads = ['javascript:document.documentElement.dataset.compromised=1', '"><img src=/x onerror=document.documentElement.dataset.compromised=1>', "'><svg onload=document.documentElement.dataset.compromised=1>", '</script><script>document.documentElement.dataset.compromised=1</script>'];
  const keys = ['site_title', 'theme', 'author_name', 'author_bio', 'site_url', 'avatar_media_id', 'update_feed_url', 'timezone', 'ai_model_tk', 'ai_model_changelog', 'ai_model_feed', 'feed_prompt', 'ai_style_prompt'];
  for (const payload of payloads) {
    const stored: string[] = [];
    for (const key of keys) {
      const response = await f.request('/blyg/api/settings', { method: 'PATCH', headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: payload }) });
      expect(response.status, 'a hostile ' + key + ' is refused or stored, never a server error').toBeLessThan(500);
      if (response.ok) stored.push(key);
    }
    expect(stored.length, 'the sweep reaches stored settings').toBeGreaterThan(0);
    expect(stored, 'site_url accepts only an absolute http(s) URL').not.toContain('site_url');
    for (const path of pages) {
      const html = await (await f.request(path)).text();
      await inert(html, `stored settings [${stored.join(',')}] cannot activate markup on ${path}`, true);
      expect(await scripts(html), 'no setting adds a script element to ' + path).toBe(baseline.get(path));
    }
  }
  // A pre-0.27 row holds any string; reading it must not mint active links.
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES ('site_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(payloads[0]).run();
  for (const path of pages) await inert(await (await f.request(path)).text(), 'a stored legacy site_url cannot activate markup on ' + path, true);
  expect((await owner('/blyg/api/settings', 'PATCH', { site_title: 'Restored', theme: 'auto', timezone: 'UTC', site_url: '', avatar_media_id: '', author_name: '', author_bio: '' })).status).toBe(200);
});
// The same inventory law for the other delegated writers: draft-scoped item
// text and citation captions, and manage-scoped collection and blogroll names.
it('no delegated item, collection or blogroll text can activate markup on public pages', async () => {
  // Sweeps write many times a minute; each starts with fresh work budgets.
  await env.DB.prepare('DELETE FROM security_budgets').run();
  const { flow } = await import('./oauth-flow-driver.ts');
  const f = await flow();
  const token = async (scope: string) => {
    const minted = await f.request('/blyg/api/authorizations', { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'sweep ' + scope, scope: [scope], resource: 'api' }) });
    expect(minted.status).toBe(200); return (await minted.json() as { access_token: string }).access_token;
  };
  const draft = await token('owner:draft'), manage = await token('owner:manage');
  const as = (bearer: string, path: string, method: string, body: unknown) => f.request(path, { method, headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = '"><img src=/x onerror=document.documentElement.dataset.compromised=1><a href="javascript:document.documentElement.dataset.compromised=1">x</a>';
  await env.DB.prepare("INSERT OR REPLACE INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES ('sweep-sub','blyg','https://sweep.example/','https://sweep.example/feed.xml','Sweep','2026-10-01')").run();
  expect((await as(manage, '/blyg/api/subscriptions/sweep-sub', 'PATCH', { title: payload, in_blogroll: true })).status).toBe(200);
  const hopper = await as(manage, '/blyg/api/hoppers', 'POST', { name: payload }); expect(hopper.status).toBe(201);
  const { id: hopperId } = await hopper.json() as { id: string };
  const updated = await as(manage, '/blyg/api/hoppers/' + hopperId, 'PATCH', { public: true, description: payload.slice(0, 280) }); expect(updated.status).toBe(200);
  const { slug } = await updated.json() as { slug: string };
  const ids: string[] = [];
  for (const body of [{ content_md: payload }, { kind: 'thread', content_md: payload, stub_of: { url: 'https://cited.example/p', cited: { source: payload, author: payload, excerpt: payload, url: 'https://cited.example/p', retrieved: '2026-10-01T00:00:00Z' } } }]) {
    const created = await as(draft, '/blyg/api/items', 'POST', body); expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string }; ids.push(id);
    expect((await f.request(`/blyg/api/items/${id}/publish`, { method: 'POST', headers: { cookie: f.owner, 'Content-Type': 'application/json' }, body: JSON.stringify(await testRevisionBody('POST', `/blyg/api/items/${id}/publish`)) })).status).toBe(200);
  }
  for (const path of ['/blyg/', '/blyg/archive/', `/blyg/f/${ids[0]}/`, `/blyg/t/${ids[1]}/`, `/blyg/h/${slug}/`]) {
    const page = await f.request(path); expect(page.status, path).toBe(200);
    const html = await page.text();
    await inert(html, 'delegated text cannot activate markup on ' + path, true);
  }
  const home = await (await f.request('/blyg/')).text();
  expect(home, 'the sweep reaches the blogroll').toContain('sweep.example');
});
