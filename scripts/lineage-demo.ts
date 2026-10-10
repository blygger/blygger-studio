// A local, throwaway studio seeded with a small conversation across four
// blygs, for trying the lineage-glyph extension (glyph, hex view and action
// ring) by hand. It builds the Studio with that extension compiled in and
// enables it, so it leaves build/ in that state: run `npm run build` after.
//
//   node --import tsx scripts/lineage-demo.ts     → http://127.0.0.1:8790/studio (password: demo)
//
// In-memory D1 and R2; nothing is fetched or sent (outbound requests get 503).
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { Miniflare } from "miniflare";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";

const PORT = Number(process.env.PORT ?? 8790);
execFileSync("npm", ["run", "build"], { stdio: "inherit", env: { ...process.env, BLYG_EXTENSIONS: "lineage-glyph" } });
const output = await build({ entryPoints: ["src/index.ts"], bundle: true, platform: "neutral", conditions: ["workerd"], external: ["cloudflare:*", "node:*"], mainFields: ["module", "main"], format: "esm", target: "es2022", loader: { ".txt": "text" }, write: false });
const mf = new Miniflare({ modules: [{ type: "ESModule", path: "worker.mjs", contents: output.outputFiles[0].text }], compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"], host: "127.0.0.1", port: PORT, bindings: { OWNER_PASSWORD: "demo", COOKIE_SECRET: "lineage-demo-cookie-secret", MOUNT: "" }, d1Databases: ["DB"], r2Buckets: ["MEDIA"], outboundService: () => new Response(null, { status: 503 }) });
const db = await mf.getD1Database("DB");
for (const migration of await readD1Migrations("./migrations")) await db.batch(migration.queries.map((sql) => db.prepare(sql)));

const MIRA = "https://mira.example/blyg/", JUN = "https://jun.example/", ANA = "https://ana.example/b/", LEE = "https://lee.example/";
await db.prepare(`INSERT INTO subscriptions (id, kind, origin, feed_url, title, created) VALUES
  ('mira', 'blyg', ?, ?, 'Mira Okafor', '2026-09-20T00:00:00Z'),
  ('jun', 'blyg', ?, ?, 'Jun Park', '2026-09-20T00:00:00Z'),
  ('ana', 'blyg', ?, ?, 'Ana Lima', '2026-09-20T00:00:00Z')`).bind(MIRA, `${MIRA}feed.xml`, JUN, `${JUN}feed.xml`, ANA, `${ANA}feed.xml`).run();

const id = (n: number) => `0000000000000000000000${String(n).padStart(4, "0")}`;
const J1 = id(1), M1 = id(2), M2 = id(3), A1 = id(4), A2 = id(5), J2 = id(6);
const quote = (origin: string, ref: string, text: string, partial = false) =>
  `<blockquote class="blyg-transclusion${partial ? " blyg-partial" : ""}" data-blyg-id="${ref}" data-blyg-version="1" data-blyg-origin="${origin}"><p>${text}</p></blockquote>`;
const items: [string, string, string, "fragment" | "thread", string, Record<string, unknown>][] = [
  ["jun", J1, "2026-09-24T09:00:00Z", "fragment", "<h1>Protocols are boring on purpose</h1><p>The best protocols are the ones nobody argues about, because there is so little in them to argue about.</p>", {}],
  ["mira", M1, "2026-09-25T09:00:00Z", "fragment", "<h1>Notes on Webmention</h1><p>A mention is a postcard: it says “I wrote about you” and leaves the reading to you.</p>", {}],
  ["mira", M2, "2026-09-27T09:00:00Z", "thread",
    `<h1>The thin layer</h1>${quote(JUN, J1, "The best protocols are the ones nobody argues about.")}<p>Protocols win by being the thinnest thing two strangers can agree on. Everything else — the reader, the editor, the taste — belongs to the client.</p>${quote(MIRA, M1, "A mention is a postcard.")}<p>Which is why a mention should carry as little as it can.</p>`,
    { stub_of: { origin: JUN, id: J1, version: 1 }, transclusions: [{ origin: JUN, id: J1, version: 1 }, { id: M1, version: 1 }] }],
  ["ana", A1, "2026-09-29T09:00:00Z", "thread",
    `<h1>Weekly reading #41</h1><p>Three things worth your time this week. First, Mira on thin protocols:</p>${quote(MIRA, M2, "Protocols win by being the thinnest thing two strangers can agree on.", true)}<p>More next week.</p>`,
    { transclusions: [{ origin: MIRA, id: M2, version: 1, selector: { exact: "Protocols win by being the thinnest thing two strangers can agree on." } }] }],
  ["ana", A2, "2026-09-30T09:00:00Z", "thread",
    `<h1>Thin isn't simple</h1>${quote(MIRA, M2, "Everything else — the reader, the editor, the taste — belongs to the client.", true)}<p>Agreed on thin. But pushing everything to the client means every client re-solves the hard parts.</p>`,
    { stub_of: { origin: MIRA, id: M2, version: 1 }, transclusions: [{ origin: MIRA, id: M2, version: 1, selector: { exact: "Everything else — the reader, the editor, the taste — belongs to the client." } }] }],
  ["jun", J2, "2026-10-01T09:00:00Z", "fragment", "<h1>The thin layer (annotated)</h1><p>Mira's post, with my notes in the margins. Protocols win by being the thinnest thing… [mine: and the most boring]</p>",
    { forked_from: { origin: MIRA, id: M2, version: 1 } }],
];
for (const [sub, remote, at, kind, html, refs] of items) {
  await db.prepare(`INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, created, updated, observed_at, content_md, content_html, l0, stub_of_json, forked_from_json, transclusions_json)
    VALUES (?, ?, ?, 'current', 1, ?, ?, ?, '', ?, 0, ?, ?, ?)`)
    .bind(sub, remote, kind, at, at, at, html, refs.stub_of ? JSON.stringify(refs.stub_of) : null, refs.forked_from ? JSON.stringify(refs.forked_from) : null, refs.transclusions ? JSON.stringify(refs.transclusions) : null).run();
}

await mf.ready;
const base = `http://127.0.0.1:${PORT}`;
const login = await mf.dispatchFetch(`${base}/studio/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=demo", redirect: "manual" });
const cookie = login.headers.get("set-cookie")!.split(";")[0];
const api = async (method: string, path: string, body?: unknown) => {
  const res = await mf.dispatchFetch(`${base}/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return res.json() as Promise<any>;
};
await api("PATCH", "/settings", { site_title: "Demo", extensions: ["lineage-glyph"] });
// Our own response to Mira — a real stub thread, so it shows as one of hers' descendants.
const reply = await api("POST", "/items", { mode: "response", source: { subscription_id: "mira", remote_id: M2 } });
await api("PATCH", `/items/${reply.id}`, { content_md: `![[${M2}]]\n\nThin, yes — but someone still has to decide what “thin” leaves out.` });
await api("POST", `/items/${reply.id}/publish`, {});
// An own fragment someone we don't follow has responded to (a verified mention).
const own = await api("POST", "/items", { content_md: "# A note on protocol taste\n\nTaste is what you leave out of a spec." });
await api("POST", `/items/${own.id}/publish`, {});
await db.prepare(`INSERT INTO mentions_in (id, source, target, target_item_id, status, relation, source_origin, source_id, source_kind, source_version, source_author_json, source_page, first_seen, last_seen, verified_at)
  VALUES ('demo-lee', ?, ?, ?, 'verified', 'stub', ?, 'lee0000000000000000000001', 'thread', 1, ?, ?, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')`)
  .bind(`${LEE}t/lee0000000000000000000001/`, `${base}/f/${own.id}/`, own.id, LEE, JSON.stringify({ name: "Lee Chen" }), `${LEE}t/lee0000000000000000000001/`).run();

console.log(`Lineage demo ready: ${base}/studio/reading?sub=mira  (password: demo)`);
process.on("SIGTERM", async () => { await mf.dispose(); process.exit(0); });
process.on("SIGINT", async () => { await mf.dispose(); process.exit(0); });
