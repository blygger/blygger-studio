import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { apiError } from '../src/api-error.ts';
import { readState } from '../src/versions.ts';
import { retryAfterMs } from '../src/ui/opml.ts';

// Execute the actual receiving functions in this Node suite without mounting
// their unrelated React surfaces or starting the global polling collections.
function functions(path: string, names: string[]) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = names.map(name => {
    const node = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Missing receiving function: ${name}`);
    return node.getText(source).replace(/^export\s+/, '');
  }).join('\n');
  return ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
const updateSource = functions('../src/ui/components.tsx', ['useUpdateState']);
const opmlSource = functions('../src/ui/opml-import.tsx', ['errorText', 'attempt']);

test('Studio update-state receiver keeps the latest release and check date from the private DTO', () => {
  const row = { updateLatestSeen: '99.0.0', updateCheckedAt: '2026-10-31T00:00:00Z' };
  const useUpdateState = new Function('useLiveQuery', 'updates', 'readState', `${updateSource}\nreturn useUpdateState;`)(() => ({ data: [row] }), {}, readState);
  expect(useUpdateState()).toEqual({ latest: '99.0.0', behind: true, checkedAt: '2026-10-31T00:00:00Z' });
});

test('Studio update-state receiver retains empty and loading states', () => {
  const loaded = new Function('useLiveQuery', 'updates', 'readState', `${updateSource}\nreturn useUpdateState;`)(() => ({ data: [{}] }), {}, readState);
  const loading = new Function('useLiveQuery', 'updates', 'readState', `${updateSource}\nreturn useUpdateState;`)(() => ({}), {}, readState);
  expect(loaded()).toEqual({ latest: '', behind: false, checkedAt: '' });
  expect(loading()).toBeUndefined();
});

const attempt = new Function('retryAfterMs', `${opmlSource}\nreturn attempt;`)(retryAfterMs);
const response = (status: number, headers?: HeadersInit) => new Response(null, { status, headers });

test('OPML import receiver shows the private API failure message', async () => {
  expect(await attempt(Promise.resolve({ error: apiError('invalid-input', 'feed discovery failed'), response: response(400) })))
    .toEqual({ kind: 'failed', reason: 'feed discovery failed' });
});

test('OPML import receiver preserves the private API duplicate message', async () => {
  expect(await attempt(Promise.resolve({ error: apiError('conflict', 'already subscribed to this feed'), response: response(409) })))
    .toEqual({ kind: 'exists', message: 'already subscribed to this feed' });
});

test('OPML import receiver keeps throttling, unknown-error and network fallbacks', async () => {
  expect(await attempt(Promise.resolve({ error: apiError('rate-limit', 'slow down'), response: response(429, { 'Retry-After': '7' }) })))
    .toEqual({ kind: 'throttled', retryAfterMs: 7000 });
  expect(await attempt(Promise.resolve({ error: {}, response: response(502) })))
    .toEqual({ kind: 'failed', reason: 'request failed (502)' });
  expect(await attempt(Promise.resolve({ error: new Error('connection closed') })))
    .toEqual({ kind: 'failed', reason: 'connection closed' });
});
