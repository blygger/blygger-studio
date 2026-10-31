/** Standalone Worker smoke test: no Vitest runtime or root-route forwarding. */
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { getMigrations } from 'better-auth/db/migration';

const output = await build({
  stdin: { contents: `
    import { betterAuth } from 'better-auth';
    import { jwt } from 'better-auth/plugins';
    import { oauthProvider } from '@better-auth/oauth-provider';
    export default { async fetch(request, env) {
      const path = env.MOUNT + '/studio/auth';
      if (!new URL(request.url).pathname.startsWith(path + '/')) return new Response(null, { status: 404 });
      return betterAuth({ database: env.DB, baseURL: 'https://mounted.example.test', basePath: path,
        secret: 'smoke-test-secret-with-at-least-32-characters', disabledPaths: ['/token', '/sign-up/email', '/sign-in/email'],
        plugins: [jwt({ jwks: { keyPairConfig: { alg: 'RS256' } } }), oauthProvider({
          scopes: ['openid', 'offline_access', 'owner:read'],
          loginPage: env.MOUNT + '/studio/login', consentPage: env.MOUNT + '/studio/consent',
          allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true,
          grantTypes: ['authorization_code', 'refresh_token']
        })]
      }).handler(request);
    }};
  `, resolveDir: process.cwd(), sourcefile: 'mounted-oidc-worker.ts' },
  bundle: true, platform: 'neutral', conditions: ['workerd'], mainFields: ['module', 'main'],
  external: ['node:*'], format: 'esm', target: 'es2022', minify: true, write: false,
});
const script = output.outputFiles[0].text;
for (const mount of ['', '/blyg', '/nested/blyg']) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: [{ type: "ESModule", path: "worker.mjs", contents: script }], compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { MOUNT: mount }, outboundService: () => new Response(null, { status: 503 }) }));
  try {
    const db = await mf.getD1Database('DB');
    await (await getMigrations({ database: db, plugins: [jwt({ jwks: { keyPairConfig: { alg: 'RS256' } } }), oauthProvider({ loginPage: '/login', consentPage: '/consent', scopes: ['openid', 'offline_access', 'owner:read'] })] })).runMigrations();
    const issuer = 'https://mounted.example.test' + mount + '/studio/auth';
    const response = await mf.dispatchFetch(issuer + '/.well-known/openid-configuration');
    assert.equal(response.status, 200);
    const metadata = await response.json() as { issuer: string; jwks_uri: string; id_token_signing_alg_values_supported: string[] };
    assert.equal(metadata.issuer, issuer);
    assert.ok(metadata.jwks_uri.startsWith(issuer + '/'));
    assert.ok(metadata.id_token_signing_alg_values_supported.includes('RS256'));
    const keyResponse = await mf.dispatchFetch(metadata.jwks_uri);
    assert.equal(keyResponse.status, 200);
    const keys = await keyResponse.json() as { keys: Record<string, unknown>[] };
    assert.ok(keys.keys.some(key => key.kty === 'RSA'));
    assert.ok(keys.keys.every(key => !['d', 'p', 'q', 'dp', 'dq', 'qi'].some(field => field in key)));
    for (const kind of ['oauth-authorization-server', 'openid-configuration']) assert.equal((await mf.dispatchFetch('https://mounted.example.test/.well-known/' + kind + mount + '/studio/auth')).status, 404);
    console.log(`Mounted OIDC Worker: ${mount || '/'} passed`);
  } finally { await mf.dispose(); }
}
console.log(`Provider-only Worker bundle: ${Buffer.byteLength(script)} bytes; ${gzipSync(script).length} bytes gzip`);
