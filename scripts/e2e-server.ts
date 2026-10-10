import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { createServer } from "node:http";
import { importedHtmlAttacks } from "../test/fixtures/imported-html-attacks.ts";
const output = await build({ entryPoints: ["src/index.ts"], bundle: true, platform: "neutral", conditions: ["workerd"], external: ["cloudflare:*", "node:*"], mainFields: ["module", "main"], format: "esm", target: "es2022", loader: { ".txt": "text" }, write: false });
const mf = new Miniflare({ modules: [{ type: "ESModule", path: "worker.mjs", contents: output.outputFiles[0].text }], compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"], host: "127.0.0.1", port: 8787, bindings: { OWNER_PASSWORD: "test-password", COOKIE_SECRET: "browser-test-cookie-secret", MOUNT: "", API_READ_LIMIT: "10000", API_WRITE_LIMIT: "10000" }, d1Databases: ["DB"], r2Buckets: ["MEDIA"], outboundService: () => new Response(null, { status: 503 }) });
const db = await mf.getD1Database("DB");
for (const migration of await readD1Migrations("./migrations")) {
  await db.batch(migration.queries.map((sql) => db.prepare(sql)));
}
// Seed only this disposable browser-test database. No fixture route is shipped.
await db.prepare("INSERT INTO subscriptions (id, kind, origin, feed_url, title, created) VALUES ('parity-native', 'blyg', 'https://source.example/', 'https://source.example/feed.xml', 'Native source', '2026-10-01T00:00:00Z'), ('parity-rss', 'rss', 'https://legacy.example/', 'https://legacy.example/feed', 'Legacy source', '2026-10-01T00:00:00Z')").run();
for (const [sub, id, state, pin, l0, md, html, page] of [
  ['parity-native', '00000000000000000000000001', 'current', null, 0, '# Native title\n\nFrozen source text.', '<h1>Native title</h1><p>Frozen source text.</p><blockquote class="blyg-transclusion">Frozen quote from a prior version.</blockquote>', 'native'],
  ['parity-native', '00000000000000000000000002', 'tombstone', 1, 0, 'Pinned retained text.', '<p>Pinned retained text.</p>', 'retained'],
  ['parity-rss', 'l0-parity', 'current', null, 1, '[Legacy title](https://legacy.example/post)', '<p><a href="https://legacy.example/post">Legacy title</a></p><p>Legacy body.</p>', 'https://legacy.example/post'],
] as const) await db.prepare('INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html, pinned_version_retained, l0, page) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)').bind(sub, id, 'fragment', state, '2026-10-01T00:00:00Z', md, html, pin, l0, page).run();
// Lineage (the lineage-glyph extension): the native item quotes its sibling and stubs a plain URL.
await db.prepare("UPDATE imported_items SET transclusions_json = ?, stub_of_json = ? WHERE subscription_id = 'parity-native' AND remote_id = '00000000000000000000000001'").bind(JSON.stringify([{ id: '00000000000000000000000002', version: 1 }]), JSON.stringify({ url: 'https://news.example/story', cited: { source: 'News site', url: 'https://news.example/story', retrieved: '2026-10-01T00:00:00Z' } })).run();
await db.prepare("INSERT INTO hoppers (id, name, slug, created) VALUES ('parity-hopper', 'Frozen hopper', 'frozen-hopper', '2026-10-01T00:00:00Z')").run();
await db.prepare("INSERT INTO hopper_items (hopper_id, subscription_id, remote_id, added_at) VALUES ('parity-hopper', 'parity-native', '00000000000000000000000001', '2026-10-01T00:00:00Z')").run();
await mf.ready;
// Verified pointers for the mentions view; source prose remains imported-only.
const fixtureLogin = await mf.dispatchFetch('http://localhost/studio/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=test-password', redirect: 'manual' });
const fixtureCookie = fixtureLogin.headers.get('set-cookie')!.split(';')[0];
const targetResponse = await mf.dispatchFetch('http://localhost/api/items', { method: 'POST', headers: { cookie: fixtureCookie, 'content-type': 'application/json' }, body: JSON.stringify({ content_md: 'Mention target fixture', kind: 'thread' }) });
const target = await targetResponse.json() as { id: string };
await mf.dispatchFetch(`http://localhost/api/items/${target.id}/publish`, { method: 'POST', headers: { cookie: fixtureCookie } });
for (const [id, origin, remoteId, hidden] of [['parity-held', 'https://source.example/', '00000000000000000000000001', 0], ['parity-stranger', 'https://stranger.example/', '00000000000000000000000003', 1]] as const) {
  await db.prepare("INSERT INTO mentions_in (id, source, target, target_item_id, status, relation, source_origin, source_id, source_kind, source_version, source_author_json, source_page, first_seen, last_seen, verified_at, hidden) VALUES (?, ?, ?, ?, 'verified', 'stub', ?, ?, 'fragment', 1, ?, ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', ?)").bind(id, origin + remoteId, `http://localhost/t/${target.id}/`, target.id, origin, remoteId, JSON.stringify({ name: 'Source author' }), origin + 'post', hidden).run();
}
await db.prepare("INSERT INTO mentions_out (id, item_id, version, target, status, attempts, next_attempt_at, created) VALUES ('parity-outbound', ?, 1, 'https://recipient.example/post', 'pending', 1, '2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z')").bind(target.id).run();
// Hostile raw imports belong to a separate disposable receiving database.
// Functional UI counts and pagination fixtures must not absorb the attack corpus.
const security = new Miniflare({ modules: [{ type: "ESModule", path: "worker.mjs", contents: output.outputFiles[0].text }], compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"], host: "127.0.0.1", port: 8791, bindings: { OWNER_PASSWORD: "test-password", COOKIE_SECRET: "security-browser-test-cookie-secret", MOUNT: "" }, d1Databases: ["DB"], r2Buckets: ["MEDIA"], outboundService: () => new Response(null, { status: 503 }) });
const securityDb = await security.getD1Database("DB");
for (const migration of await readD1Migrations("./migrations")) await securityDb.batch(migration.queries.map(sql => securityDb.prepare(sql)));
await securityDb.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES ('security-html','rss','https://security-publisher.example/','https://security-publisher.example/feed','Security HTML','2020-01-01')").run();
for (const attack of importedHtmlAttacks) await securityDb.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_md,content_html,l0,page) VALUES ('security-html',?,'fragment','current',1,'2020-01-01','Security fixture',?,1,'https://security-publisher.example/post')").bind(attack.id, '<h2>Security ' + attack.id + '</h2>' + attack.html).run();
await securityDb.prepare("INSERT INTO hoppers(id,name,slug,public,created) VALUES ('security-imports','Security imports','security-imports',1,'2020-01-01')").run();
await securityDb.prepare("INSERT INTO hopper_items(hopper_id,subscription_id,remote_id,added_at) VALUES ('security-imports','security-html','svg-event','2020-01-01')").run();
// Native imports exercise bake/provenance paths as well as the legacy reader.
// Harmless local attack tries to mint a named fixture grant. No live service,
// exfiltration destination or real credential is involved.
const authorityAttack = "fetch('/api/authorizations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'XSS authority marker',scope:['owner:read','owner:draft','owner:publish','owner:manage'],resource:'api'})}).then(r=>{if(r.ok)document.documentElement.dataset.importScript='yes'})";
await securityDb.prepare("INSERT INTO subscriptions(id,kind,origin,feed_url,title,created) VALUES ('security-native','blyg','https://native-publisher.example/','https://native-publisher.example/feed','Native security','2020-01-01')").run();
await securityDb.prepare("INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at,content_html,l0,page) VALUES ('security-native','00000000000000000000000001','fragment','current',1,'2020-01-01',?,0,?)")
  .bind('<p>Native quoted safety marker</p><img src="/missing" onerror="' + authorityAttack + '">', 'post"><img src="/missing" onerror="' + authorityAttack + '">').run();
await securityDb.prepare("INSERT INTO hoppers(id,name,slug,public,created) VALUES ('security-native-hopper','Native security collection','security-native',1,'2020-01-01')").run();
await securityDb.prepare("INSERT INTO hopper_items(hopper_id,subscription_id,remote_id,added_at) VALUES ('security-native-hopper','security-native','00000000000000000000000001','2020-01-01')").run();
// A pre-upgrade pinned bake remains raw on the immutable protocol JSON path.
await securityDb.prepare("INSERT INTO items(id,kind,status,created,updated,version,content_md) VALUES ('00000000000000000000000003','thread','public','2020-01-01','2020-01-02',2,'Safe latest')").run();
for (const version of [1,2]) await securityDb.prepare("INSERT INTO versions(item_id,version,content_md,content_hash,published_at,content_html,transclusions,pinned,note) VALUES ('00000000000000000000000003',?,'Snapshot','fixture','2020-01-01',?,'[]',?,?)")
  .bind(version, version===1 ? '<p>Legacy pin safety marker</p><img src="/missing" onerror="'+authorityAttack+'">' : '<p>Safe latest safety marker</p>', version===1?1:0,version===1?'Old pin note':'Latest note').run();
await security.ready;
// A separate mounted instance behind the documented forwarding ranges. The
// proxy rejects host-root assets rather than letting a permissive fixture hide
// a deployment dependency. Its database and cookies belong to this host only.
const mounted = new Miniflare({ modules: [{ type: "ESModule", path: "worker.mjs", contents: output.outputFiles[0].text }], compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"], bindings: { OWNER_PASSWORD: "test-password", COOKIE_SECRET: "mounted-browser-test-cookie-secret", MOUNT: "/notes/b" }, d1Databases: ["DB"], r2Buckets: ["MEDIA"], outboundService: () => new Response(null, { status: 503 }) });
const mountedDb = await mounted.getD1Database("DB");
for (const migration of await readD1Migrations("./migrations")) await mountedDb.batch(migration.queries.map(sql => mountedDb.prepare(sql)));
await mountedDb.prepare("INSERT INTO subscriptions (id, kind, origin, feed_url, title, created) VALUES ('browser-source', 'rss', 'https://source.example/', 'https://source.example/feed', 'Browser source', '2026-10-01T00:00:00Z')").run();
await mountedDb.prepare("INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, observed_at, content_md, content_html, l0) VALUES ('browser-source', 'remote', 'fragment', 'current', 1, '2026-10-01T00:00:00Z', '[Remote title](https://source.example/post)', '<p><a href=\"https://source.example/post\">Remote title</a></p>', 1)").run();
const proxy = createServer(async (request, response) => {
  try {
    const path = new URL(request.url!, "http://127.0.0.1:8789").pathname;
    // Disposable hostile ancestor on a real local origin. A mocked document
    // loses its address-space classification and triggers Chromium's unrelated
    // local-network guard before the frame policy can be observed.
    if (path === "/notes/b/hostile-frame") {
      const target = new URL(request.url!, "http://127.0.0.1:8789").searchParams.get("target") ?? "";
      if (!target.startsWith("http://127.0.0.1:8787/studio/")) { response.writeHead(400); response.end(); return; }
      const escaped = target.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<iframe src="' + escaped + '"></iframe>');
      return;
    }
    if (!path.startsWith("/notes/b/") && !path.startsWith("/api/")) { response.writeHead(404); response.end("outside forwarding ranges"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && !["host", "content-length", "connection"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    const upstream = await mounted.dispatchFetch(`http://127.0.0.1:8789${request.url}`, { redirect: "manual", method: request.method, headers: Object.fromEntries(headers), ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) { console.error(error); response.writeHead(500); response.end("fixture proxy error"); }
});
await new Promise<void>(resolve => proxy.listen(8789, "127.0.0.1", resolve));
console.log("Browser fixture ready at http://127.0.0.1:8787");
process.on("SIGTERM", async () => { proxy.close(); await Promise.all([mf.dispose(), mounted.dispose(), security.dispose()]); process.exit(0); });
