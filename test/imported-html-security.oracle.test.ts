/**
 * Imported HTML is untrusted even after it has been stored. OWASP's XSS law is
 * that untrusted markup cannot execute code in the receiving page's authority:
 * https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
 * Contract/model: published/imported text is data; active URL schemes are never
 * an imported link capability. WHATWG URL parsing supplies an independent second
 * formulation for control-character normalization, not the production regex:
 * https://url.spec.whatwg.org/#concept-basic-url-parser
 * Grammar: fixed corpus in fixtures/imported-html-attacks.ts, no generated claim.
 * Driver: seed raw imported rows, then GET the real owner API with a valid cookie.
 * Refinement: surviving URL attributes cannot resolve to javascript/data schemes.
 * Safe links and protocol transclusion attributes remain positive neighbors.
 * Limits: this structural checkpoint does not prove browser inertness. The actual
 * React DOM reparse and click checkpoints live in e2e/imported-html-security.spec.ts.
 */
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { makeApp } from '../src/index.ts';
import { importedHtmlAttacks } from './fixtures/imported-html-attacks.ts';

async function request(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers); headers.set('CF-Connecting-IP', 'fd00:' + crypto.randomUUID().replaceAll('-', '').match(/.{4}/g)!.slice(0,7).join(':'));
  const response = await makeApp('/blyg').fetch(new Request('https://html-security.example.test' + path, { ...init, headers }), env, ctx);
  await waitOnExecutionContext(ctx); return response;
}
it.each(importedHtmlAttacks)('keeps imported URL authority inert: $id', async attack => {
  const login = await request('/blyg/studio/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  await env.DB.prepare("INSERT OR IGNORE INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES ('security','rss','https://publisher.example/','https://publisher.example/feed','Security','2026-10-01')").run();
  await env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_html,l0) VALUES ('security',?,'fragment','current',1,'2026-10-01',?,1)").bind(attack.id, attack.html).run();
  const response = await request('/blyg/api/imports/security/' + attack.id, { headers: { cookie } });
  expect(response.status, 'stored imported item must reach its real API reader').toBe(200);
  const item = await response.json() as { content_html: string };
  const urls: string[] = [];
  await new HTMLRewriter().on('*', { element(el) {
    for (const [name, value] of el.attributes) if (['href', 'src', 'xlink:href'].includes(name)) urls.push(value);
  } }).transform(new Response(item.content_html)).text();
  for (const url of urls) expect(['javascript:', 'data:'], 'imported URL must not retain active scheme').not.toContain(new URL(url, 'https://html-security.example.test').protocol);
});

// Public collections are another receiving path. A legacy-feed flag is a format
// distinction, not a trust grant. Raw feed bytes must be inert without login.
it('sanitizes legacy imported content on the public collection path', async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES ('security','rss','https://publisher.example/','https://publisher.example/feed','Security','2026-10-01')").run();
  await env.DB.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_html,l0) VALUES ('security','public-legacy','fragment','current',1,'2026-10-01',?,1)").bind('<p>Safe imported text</p><img src="/missing" onerror="document.documentElement.dataset.compromised=1">').run();
  await env.DB.prepare("INSERT INTO hoppers(id,name,slug,public,created) VALUES ('security-hopper','Security','security-hopper',1,'2026-10-01')").run();
  await env.DB.prepare("INSERT INTO hopper_items(hopper_id,subscription_id,remote_id,added_at) VALUES ('security-hopper','security','public-legacy','2026-10-01')").run();
  const response = await request('/blyg/h/security-hopper/'); expect(response.status).toBe(200);
  const html = await response.text(); expect(html).toContain('Safe imported text');
  expect(html, 'legacy collection content cannot bypass the receiving sanitizer').not.toContain('onerror=');
});
