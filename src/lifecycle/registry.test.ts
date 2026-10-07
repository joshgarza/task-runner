import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Registry } from './registry.ts';

function fixture(t: any): string {
  const root = mkdtempSync(join(tmpdir(), 'registry-location-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}
function rejects(path: string): void {
  assert.throws(() => new Registry(path).update(() => {}), /outside Git|cannot be a symlink/);
  assert.equal(existsSync(path), false, 'unsafe location must not receive a database');
}

test('first write under empty ancestor markers persists state across registry instances', t => {
  const root = fixture(t);
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'coding/.git'), { recursive: true });
  const path = join(root, 'coding/state/project/lifecycle.sqlite');
  const registry = new Registry(path);
  assert.equal(existsSync(path), false);
  registry.update(s => { s.disk.reasons = ['durable']; });
  assert.deepEqual(new Registry(path).read().disk.reasons, ['durable']);
  assert.deepEqual(readdirSync(join(root, '.git')), []);
  assert.deepEqual(readdirSync(join(root, 'coding/.git')), []);
});

test('normal, linked and bare Git locations are rejected, including empty markers nested inside a checkout', t => {
  const root = fixture(t);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'fixture');
  rejects(join(repo, 'state/lifecycle.sqlite'));
  mkdirSync(join(repo, 'nested/.git'), { recursive: true });
  rejects(join(repo, 'nested/state/lifecycle.sqlite'));
  git(repo, 'worktree', 'add', '-b', 'linked', join(root, 'linked'));
  rejects(join(root, 'linked/state/lifecycle.sqlite'));
  git(root, 'init', '--bare', 'bare.git');
  rejects(join(root, 'bare.git/state/lifecycle.sqlite'));
  rejects(join(repo, '.git/state/lifecycle.sqlite'));
});

test('nonempty corrupt markers and gitfiles fail closed without interpreting their contents', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'corrupt/.git'), { recursive: true });
  writeFileSync(join(root, 'corrupt/.git/unknown'), 'unrecognized metadata');
  rejects(join(root, 'corrupt/state/lifecycle.sqlite'));
  mkdirSync(join(root, 'gitfile'));
  writeFileSync(join(root, 'gitfile/.git'), 'invalid gitfile');
  rejects(join(root, 'gitfile/state/lifecycle.sqlite'));
});

test('symlink markers, dangling database links and path aliases cannot bypass the guard', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'empty'));
  for (const target of ['empty', 'missing']) {
    const parent = join(root, target + '-marker');
    mkdirSync(parent);
    symlinkSync(join(root, target), join(parent, '.git'));
    rejects(join(parent, 'state/lifecycle.sqlite'));
  }
  symlinkSync(join(root, 'missing-db'), join(root, 'database-link'));
  rejects(join(root, 'database-link'));
  assert.throws(() => new Registry(join(root, 'database-link')).read(), /cannot be a symlink/);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init');
  symlinkSync(repo, join(root, 'repo-alias'));
  rejects(join(root, 'repo-alias/state/lifecycle.sqlite'));
  mkdirSync(join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(repo, 'outside-alias'));
  rejects(join(repo, 'outside-alias/lifecycle.sqlite'));
});

test('disposable path component is rejected at its root, in descendants and through aliases', t => {
  const root = fixture(t);
  const disposable = join(root, '.task-runner-worktrees');
  rejects(join(disposable, 'lifecycle.sqlite'));
  rejects(join(disposable, 'branch/state/lifecycle.sqlite'));
  symlinkSync(disposable, join(root, 'alias'));
  rejects(join(root, 'alias/lifecycle.sqlite'));
  rejects(join(root, '.git/lifecycle.sqlite'));
});

test('a marker becoming nonempty blocks subsequent reads and writes without losing state', t => {
  const root = fixture(t);
  mkdirSync(join(root, '.git'));
  const registry = new Registry(join(root, 'state/lifecycle.sqlite'));
  registry.update(s => { s.disk.reasons = ['preserve']; });
  writeFileSync(join(root, '.git/unknown'), 'unknown');
  assert.throws(() => registry.read(), /outside Git/);
  assert.throws(() => registry.update(() => {}), /outside Git/);
  rmSync(join(root, '.git/unknown'));
  assert.deepEqual(registry.read().disk.reasons, ['preserve']);
});
