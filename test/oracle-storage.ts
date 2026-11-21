/** Preserve the test fixture across calibration and determinism reruns.
 * The Worker pool isolates files, while oracleProperty repeats witnesses inside
 * one test. Snapshot and restore only its disposable D1/R2 bindings. Triggers
 * are suspended while restoring so cleanup cannot manufacture change revisions.
 * No production binding or operator credentials are available to this helper.
 */
import { env } from 'cloudflare:test';
import { withOracleCleanup } from './oracle-cleanup.ts';
const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
type Schema = { name: string; type: string; sql: string };
export async function withOracleStorage(operation: () => Promise<void>) {
  const database = env.DB;
  // Native provider instances cache initialization by DB identity. A new test
  // handle pairs that cache with the restored fixture instead of a prior run.
  env.DB = new Proxy(database, { get(target, key) { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  try { await snapshot(operation); } finally { env.DB = database; }
}
async function snapshot(operation: () => Promise<void>) {
  const schema = (await env.DB.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<Schema>()).results;
  // FTS virtual and shadow tables are derived, and D1 forbids shadow writes.
  // table_info omits generated columns, which cannot be inserted on restore.
  const regularTables = async () => new Set((await env.DB.prepare('PRAGMA table_list').all<{ name: string; type: string }>()).results.filter(row => row.type === 'table').map(row => row.name));
  const regular = await regularTables();
  const tables = schema.filter(entry => entry.type === 'table' && regular.has(entry.name));
  const columns = await env.DB.batch<{ name: string }>(tables.map(table => env.DB.prepare('PRAGMA table_info(' + identifier(table.name) + ')')));
  const rows = await env.DB.batch<Record<string, unknown>>(tables.map((table, index) => env.DB.prepare('SELECT ' + columns[index].results.map(column => identifier(column.name)).join(',') + ' FROM ' + identifier(table.name))));
  const fullText = schema.filter(entry => entry.type === 'table' && /USING fts5\s*\(/i.test(entry.sql) && /content\s*=\s*'[^']+'/i.test(entry.sql));
  const objects = await env.MEDIA.list();
  if (objects.truncated) throw new Error('Oracle fixture snapshot requires an unpaginated R2 fixture');
  const media = await Promise.all(objects.objects.map(async object => {
    const value = await env.MEDIA.get(object.key);
    if (!value) throw new Error('R2 fixture disappeared before its oracle history');
    return { key: object.key, body: await value.arrayBuffer(), httpMetadata: value.httpMetadata, customMetadata: value.customMetadata };
  }));
  await withOracleCleanup(operation, [async () => {
    const current = (await env.DB.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<Schema>()).results;
    const statements = [env.DB.prepare('PRAGMA defer_foreign_keys = ON')];
    for (const trigger of current.filter(entry => entry.type === 'trigger')) statements.push(env.DB.prepare('DROP TRIGGER ' + identifier(trigger.name)));
    const currentRegular = await regularTables();
    for (const table of current.filter(entry => entry.type === 'table' && currentRegular.has(entry.name))) statements.push(env.DB.prepare('DELETE FROM ' + identifier(table.name)));
    for (let index = 0; index < tables.length; index++) {
      for (const row of rows[index].results) {
        const columns = Object.keys(row);
        statements.push(env.DB.prepare('INSERT INTO ' + identifier(tables[index].name) + ' (' + columns.map(identifier).join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')').bind(...columns.map(column => Array.isArray(row[column]) ? new Uint8Array(row[column] as number[]) : row[column])));
      }
    }
    for (const table of current.filter(entry => entry.type === 'table' && currentRegular.has(entry.name) && !tables.some(before => before.name === entry.name))) statements.push(env.DB.prepare('DROP TABLE ' + identifier(table.name)));
    for (const table of fullText) statements.push(env.DB.prepare('INSERT INTO ' + identifier(table.name) + '(' + identifier(table.name) + ") VALUES('rebuild')"));
    for (const trigger of schema.filter(entry => entry.type === 'trigger')) statements.push(env.DB.prepare(trigger.sql));
    await env.DB.batch(statements);
  }, async () => {
    const current = await env.MEDIA.list();
    if (current.truncated) throw new Error('Oracle cleanup requires an unpaginated R2 fixture');
    if (current.objects.length) await env.MEDIA.delete(current.objects.map(object => object.key));
    for (const object of media) await env.MEDIA.put(object.key, object.body, { httpMetadata: object.httpMetadata, customMetadata: object.customMetadata });
  }]);
}
