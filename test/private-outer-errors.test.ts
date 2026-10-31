import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { makeApp } from '../src/index.ts';

it.each(['', '/notes/blyg'])('uses private error envelopes for outer HTTPS denials at mount %s', async mount => {
  const app = makeApp(mount);
  for (const path of ['/api', '/api/settings', '/studio/mcp', '/studio/mcp/']) {
    const response = await app.fetch(new Request('http://outer-errors.example' + mount + path), env);
    expect(response.status, path).toBe(400);
    expect(response.headers.get('cache-control'), path).toBe('no-store');
    expect(await response.json(), path).toEqual({ code: 'invalid-input', message: 'HTTPS required' });
  }
  for (const path of ['/studio/login', '/studio/auth/resources/api']) {
    const response = await app.fetch(new Request('http://outer-errors.example' + mount + path), env);
    expect(response.status, path).toBe(400);
    expect(await response.json(), path).toEqual({ error: 'HTTPS required' });
  }
});

it.each(['', '/notes/blyg'])('sanitizes outer failures without changing native or public envelopes at mount %s', async mount => {
  const app = makeApp(mount), bindings = { ...env };
  // Fail in the outer middleware before a child router can handle the error.
  Object.defineProperty(bindings, 'outerFailure', {
    enumerable: true,
    get() { throw new Error('outer-fixture-detail'); },
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const [path, privateError] of [
      ['/api', true], ['/api/settings', true], ['/studio/mcp', true], ['/studio/mcp/', true],
      ['/studio/login', false], ['/studio/auth/resources/api', false], ['/blyg.json', false],
    ] as const) {
      const ctx = createExecutionContext();
      const response = await app.fetch(new Request('https://outer-errors.example' + mount + path), bindings, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status, path).toBe(500);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
      expect(await response.json(), path).toEqual(privateError
        ? { code: 'internal', message: 'internal server error' }
        : { error: 'internal server error' });
    }
  } finally { log.mockRestore(); }
});
