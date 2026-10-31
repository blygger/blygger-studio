import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readD1Migrations } from "@cloudflare/vitest-plugin";

// Child process used only by the release verifier; no production network or config.
const [worker, storage, initialize] = process.argv.slice(2);
const mf = new Miniflare(convertV4MiniflareOptions({ modules: [{ type: "ESModule", path: "worker.mjs", contents: readFileSync(join(worker, "worker.js"), "utf8") }], compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"], bindings: { MOUNT: "", OWNER_PASSWORD: "test", COOKIE_SECRET: "persistence-test-secret" }, d1Databases: ["DB"], r2Buckets: ["MEDIA"], resourcePersistencePath: storage, outboundService: () => new Response(null, { status: 503 }) }));
if (initialize === "initialize") {
  const db = await mf.getD1Database("DB");
  for (const migration of await readD1Migrations(join(worker, "migrations"))) await db.batch(migration.queries.map(sql => db.prepare(sql)));
}
process.on("message", async message => { if (message === "stop") { await mf.dispose(); process.exit(0); } });
process.send?.({ url: (await mf.ready).origin });
