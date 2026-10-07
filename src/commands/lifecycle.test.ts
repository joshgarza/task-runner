import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('lifecycle CLI reports synchronous and asynchronous failures concisely and exits nonzero', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'lifecycle-cli-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const registryPath = join(cwd, 'state/lifecycle.sqlite');
  writeFileSync(join(cwd, 'task-runner.config.json'), JSON.stringify({ lifecycle: { registryPath } }));
  const cli = new URL('../cli.ts', import.meta.url).pathname;
  for (const [args, expected] of [
    [['adopt', 'JOS-1', '--project', 'fixture', '--started-at', '2026-01-01T00:00:00Z', '--reason', 'fixture', '--authorization-comment', 'fixture'], /Configure lifecycle.joshUserId/],
    [['disposition', 'JOS-1', '--action', 'invalid', '--reason', 'fixture', '--authorization-comment', 'fixture'], /Invalid disposition/],
  ] as const) {
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', cli, 'lifecycle', ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.match(output, expected);
    assert.ok(output.length < 600, output);
    assert.doesNotMatch(output, /at .*\.ts:|node_modules|Unhandled/);
    assert.equal(existsSync(registryPath), false);
  }
});
