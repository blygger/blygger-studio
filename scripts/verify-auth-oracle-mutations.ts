/**
 * Mutation and replay must preserve the same violated authorization/storage law.
 * Contract: docs/oracle-tests.md ORC-006/007/010 and docs/auth-oracles.md.
 * Model: a baseline passes; a selected broken defense fails at the named checkpoint.
 * For captured generated failures, direct seed/path replay must retain that
 * checkpoint and the same reduced counterexample, without normal campaigns first.
 * Driver: disposable source copies with scope enforcement, password-session/token separation
 * or exclusive expiry changed. Repository source paths include untracked candidate
 * files; ignored credentials are not copied by that path inventory.
 * Refinement: distinguish setup/timeout failures from semantic RED, then retain
 * captured and replayed records. Source mutations never change this checkout.
 * Limits: these three controls do not certify every security law or replay every
 * possible campaign; verify-auth-security-mutations.ts owns additional controls.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// The candidate's new oracle/source files may still be untracked. Copy only
// repository source/test paths plus tracked files, never ignored credentials.
const root = resolve('.'), temporary = mkdtempSync(join(tmpdir(), 'blygger-auth-mutations-'));
const controls = [
  { name: 'delegated scope enforcement omitted', file: 'src/operation-runner.ts', from: "if (context.access !== null && required.some(scope => !context.access!.scope.includes(scope)))", to: 'if (false)', test: 'test/authorization.oracle.test.ts', pattern: 'distinguishes root invalidation', target: 'authorization', captureSeed: 20261016, checkpoint: 'authorization API decision' },
  { name: 'password reset revokes delegated grants', file: 'src/oauth.ts', from: "return hashCredential(JSON.stringify([env.COOKIE_SECRET, epoch]));", to: "return hashCredential(JSON.stringify([env.COOKIE_SECRET, env.OWNER_PASSWORD, epoch]));", test: 'test/owner-reset.oracle.test.ts', pattern: 'preserves API and MCP grants', checkpoint: 'password reset must preserve delegated access' },
  { name: 'expiry boundary remains readable', file: 'src/oauth-storage.ts', from: 'expires > ?', to: 'expires >= ?', test: 'test/oauth-storage.oracle.test.ts', pattern: 'reconstructs overwrite', target: 'oauth-storage', captureSeed: 20261002, checkpoint: 'OAuth storage prefix pages' },
];
try {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const source = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'test', 'migrations'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of new Set([...tracked, ...source])) {
    const destination = join(temporary, file); mkdirSync(dirname(destination), { recursive: true }); cpSync(join(root, file), destination);
  }
  cpSync(join(root, 'sdk/dist'), join(temporary, 'sdk/dist'), { recursive: true });
  cpSync(join(root, 'build'), join(temporary, 'build'), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
  const execute = (control: typeof controls[number], replay?: { seed: number; path: string }) => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', control.test, '-t', replay ? `${control.target}: replay$` : control.pattern], { cwd: temporary, encoding: 'utf8', timeout: 90000, env: { ...process.env, WRANGLER_LOG_PATH: join(temporary, 'wrangler.log'), ORACLE_TARGET: replay ? control.target : undefined, ORACLE_SEED: replay ? String(replay.seed) : undefined, ORACLE_PATH: replay?.path, NO_COLOR: '1' } });
  const semanticFailure = (result: ReturnType<typeof execute>, control: typeof controls[number]) => {
    assert.equal(result.error, undefined, 'Runner error: ' + control.name);
    assert.equal(result.signal, null, 'Timeout/signal: ' + control.name);
    assert.notEqual(result.status, 0, 'Survived: ' + control.name);
    const output = result.stdout + '\n' + result.stderr;
    assert.ok(output.includes('Error: ' + control.checkpoint), `Did not reach semantic checkpoint: ${control.name}\n${output}`);
    return output;
  };
  const replayCapturedFailure = (control: typeof controls[number]) => {
    // Search bounded seed inputs, without changing the campaign's eight-run budget.
    // Capture and replay the real generated property through the Vite registry.
    const firstSeed = control.captureSeed ?? 20261001;
    for (let seed = firstSeed; seed < firstSeed + 20; seed++) {
      const captured = execute(control, { seed, path: '' });
      assert.equal(captured.error, undefined, 'Capture runner error: ' + control.name);
      assert.equal(captured.signal, null, 'Capture timeout/signal: ' + control.name);
      if (captured.status === 0) continue;
      const output = semanticFailure(captured, control);
      const inputs = output.match(/seed: (-?\d+), path: "([^"]*)"/);
      const witness = output.match(/Counterexample: ([^\n]+)/)?.[1];
      assert.ok(inputs && witness, 'Missing captured seed/path/counterexample: ' + control.name);
      const replay = { seed: Number(inputs[1]), path: inputs[2] };
      const repeated = semanticFailure(execute(control, replay), control);
      assert.ok(repeated.includes(`oracle ${control.target} replay: started`), 'Replay target did not execute');
      assert.equal(repeated.match(/Counterexample: ([^\n]+)/)?.[1], witness, 'Replay changed the reduced counterexample');
      assert.ok(!repeated.includes(`oracle ${control.target} fixed: started`) && !repeated.includes(`oracle ${control.target} random: started`), 'Replay ran a normal campaign first');
      writeFileSync(join(root, 'build', `auth-replay-${control.target}.log`), output + '\nDIRECT REPLAY\n' + repeated);
      writeFileSync(join(root, 'build', `auth-replay-${control.target}.json`), JSON.stringify({ target: control.target, ...replay, checkpoint: control.checkpoint, counterexample: witness, outcome: 'assertion failure reproduced' }, null, 2) + '\n');
      console.log(`Replayed ${control.target} seed=${replay.seed} path=${replay.path} at ${control.checkpoint}`);
      return;
    }
    throw new Error('No generated semantic failure in bounded seed search: ' + control.name);
  };
  for (const control of controls) {
    const baseline = execute(control); assert.equal(baseline.status, 0, `Baseline failed: ${baseline.stdout}\n${baseline.stderr}`);
  }
  for (const control of controls) {
    const file = join(temporary, control.file), original = readFileSync(file, 'utf8');
    assert.ok(original.includes(control.from), 'Missing mutation anchor: ' + control.name);
    writeFileSync(file, original.replaceAll(control.from, control.to));
    try {
      const result = execute(control), output = result.stdout + '\n' + result.stderr;
      writeFileSync(join(root, 'build', `auth-mutation-${controls.indexOf(control)}.log`), output);
      semanticFailure(result, control);
      console.log(`Caught ${control.name} at ${control.checkpoint}`);
      if (control.target) replayCapturedFailure(control);
    } finally { writeFileSync(file, original); }
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
