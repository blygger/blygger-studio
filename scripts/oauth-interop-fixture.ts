/** Disposable HTTPS Worker for external OAuth clients. No live bindings. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

export function fixtureCertificate(directory: string) {
  const key = join(directory, 'fixture.key'), cert = join(directory, 'fixture.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1'], { stdio: 'ignore' });
  return { key, cert };
}

export async function startOAuthFixture(mount: string, certificate: ReturnType<typeof fixtureCertificate>) {
  const output = await build({ stdin: { contents: `import worker from './src/index.ts'; export * from './src/index.ts'; export default { async fetch(request, env, ctx) { const original = await worker.fetch(request, env, ctx); const response = new Response(original.body, original); response.headers.set('X-Fixture-Fetch-Mode', request.headers.get('Sec-Fetch-Mode') ?? 'missing'); return response; } };`, resolveDir: process.cwd(), sourcefile: 'oauth-fixture.mjs' }, bundle: true, platform: 'neutral', conditions: ['workerd'], external: ['cloudflare:*', 'node:*'], mainFields: ['module', 'main'], format: 'esm', target: 'es2022', loader: { '.txt': 'text' }, write: false });
  const mf = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: output.outputFiles[0].text }], compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], bindings: { OWNER_PASSWORD: 'oauth-interop-fixture-password', COOKIE_SECRET: 'disposable-interop-signing-secret-not-production', MOUNT: mount, API_READ_LIMIT: '100000', API_WRITE_LIMIT: '100000' }, d1Databases: ['DB'], r2Buckets: ['MEDIA'], outboundService: () => new Response(null, { status: 503 }) });
  try {
    const db = await mf.getD1Database('DB');
    for (const migration of await readD1Migrations('./migrations')) await db.batch(migration.queries.map(sql => db.prepare(sql)));
    const server = createServer({ key: readFileSync(certificate.key), cert: readFileSync(certificate.cert) }, async (request, response) => {
      try {
        const bytes: Buffer[] = []; for await (const chunk of request) bytes.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && !['host', 'content-length', 'connection'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        // Undici replaces Sec-Fetch-Mode. Miniflare's documented bridge restores
        // the original browser value before the real Worker receives the request.
        const mode = headers.get('Sec-Fetch-Mode'); if (mode) headers.set('MF-Sec-Fetch-Mode', mode);
        const result = await mf.dispatchFetch('https://' + request.headers.host + request.url, { method: request.method, headers: Object.fromEntries(headers), redirect: 'manual', ...(bytes.length ? { body: Buffer.concat(bytes) } : {}) });
        if (mode) assert.equal(result.headers.get('X-Fixture-Fetch-Mode'), mode, 'Fixture must preserve browser navigation metadata');
        const outgoing = Object.fromEntries(result.headers), cookies = result.headers.getSetCookie(); delete outgoing['set-cookie'];
        if (cookies.length) response.setHeader('Set-Cookie', cookies);
        response.writeHead(result.status, outgoing);
        if (result.body) for await (const chunk of result.body) response.write(chunk);
        response.end();
      } catch { response.writeHead(500); response.end('OAuth fixture proxy failed'); }
    });
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
    const port = (server.address() as { port: number }).port, origin = 'https://localhost:' + port;
    return { mf, origin, mount, issuer: origin + mount + '/studio/auth', mcp: origin + mount + '/studio/mcp', async dispose() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await mf.dispose(); } };
  } catch (error) { await mf.dispose(); throw error; }
}

export function fixtureIP() {
  return 'fd00:' + crypto.randomUUID().replaceAll('-', '').match(/.{4}/g)!.slice(0, 7).join(':');
}
