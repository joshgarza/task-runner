import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Registry } from './registry.ts';
import { lifecycleConfig } from './model.ts';
import { inspectCheckout, cleanupCheckout, checkNames, suspectedSecret } from './cleanup.ts';
import { checkoutActivity } from './processes.ts';
import { reconcile } from './service.ts';
import type { TaskRunnerConfig } from '../types.ts';
import type { Checkout, Ticket } from './model.ts';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'runner-cleanup-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'main'); const origin = join(root, 'origin.git'); const path = join(root, 'output');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
  git(root, 'init', '--bare', origin); git(root, 'init', '-b', 'main', repo);
  git(repo, 'config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\nignored/\n'); writeFileSync(join(repo, 'README.md'), 'base');
  git(repo, 'add', '.gitignore', 'README.md'); git(repo, 'commit', '-m', 'base'); git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', 'origin', 'main');
  git(repo, 'worktree', 'add', '-b', 'task-runner/jos-1', path);
  writeFileSync(join(path, 'README.md'), 'complete'); git(path, 'add', 'README.md'); git(path, 'commit', '-m', 'task'); git(path, 'push', 'origin', 'HEAD');
  const head = git(path, 'rev-parse', 'HEAD');
  const config = { projects: { 'task-runner': { repoPath: repo, defaultBranch: 'main', testCommand: '', lintCommand: '' } },
    lifecycle: lifecycleConfig({ registryPath: join(root, 'state/registry.sqlite'), controlCheckout: repo }) } as TaskRunnerConfig;
  const ticket: Ticket = { identifier: 'JOS-1', issueId: 'one', teamKey: 'JOS', project: 'task-runner', startedAt: 1, deadline: 2, queueLabel: 'custom',
    pr: { url: 'https://github.com/fixture/repo/pull/1', head, branch: 'task-runner/jos-1', repository: 'fixture/repo' } };
  const checkout: Checkout = { id: 'fixture', ticket: 'JOS-1', project: 'task-runner', repoPath: repo, path, branch: 'task-runner/jos-1', phase: 'present', protected: false };
  const registry = new Registry(config.lifecycle.registryPath);
  registry.update(s => { s.tickets[ticket.identifier] = ticket; s.checkouts[checkout.id] = checkout; });
  const inspect: typeof inspectCheckout = (c, t, cfg) => inspectCheckout(c, t, cfg, { checkoutActivity: () => [], prEvidence: () => ({ state: 'OPEN', headRefOid: head, headRefName: checkout.branch, url: ticket.pr!.url, mergedAt: null }) });
  return { root, repo, path, head, git, config, ticket, checkout, registry, inspect };
}

test('safe cleanup permits explicitly allowlisted dependencies, preserves recovery refs, releases only physical capacity', t => {
  const f = fixture(t); mkdirSync(join(f.path, 'node_modules')); writeFileSync(join(f.path, 'node_modules', 'fixture.js'), 'disposable');
  const preview = cleanupCheckout(f.registry, 'fixture', f.config, true, f.inspect);
  assert.equal(preview.safe, true, preview.reasons.join()); assert.equal(existsSync(f.path), true);
  const result = cleanupCheckout(f.registry, 'fixture', f.config, false, f.inspect);
  assert.equal(result.safe, true, result.reasons.join()); assert.equal(existsSync(f.path), false);
  assert.equal(f.registry.read().checkouts.fixture.phase, 'removed'); assert.equal(f.registry.read().tickets['JOS-1'].resolution, undefined);
  assert.equal(f.git(f.repo, 'rev-parse', 'refs/task-runner/recovery/fixture'), f.head);
  assert.equal(f.git(f.repo, 'rev-parse', 'task-runner/jos-1'), f.head);
});
for (const kind of ['dirty', 'untracked', 'ignored', 'unpublished', 'locked', 'protected', 'stale-remote']) {
  test(`preserves ${kind} output and refuses physical-slot release`, t => {
    const f = fixture(t);
    if (kind === 'dirty') writeFileSync(join(f.path, 'README.md'), 'unfinished');
    if (kind === 'untracked') writeFileSync(join(f.path, 'draft.txt'), 'unfinished');
    if (kind === 'ignored') { mkdirSync(join(f.path, 'ignored')); writeFileSync(join(f.path, 'ignored', 'draft.txt'), 'unfinished'); }
    if (kind === 'unpublished') f.git(f.path, 'commit', '--allow-empty', '-m', 'unpublished');
    if (kind === 'locked') f.git(f.repo, 'worktree', 'lock', f.path);
    if (kind === 'protected') f.registry.update(s => { s.checkouts.fixture.protected = true; });
    if (kind === 'stale-remote') f.git(f.path, 'push', 'origin', 'main:task-runner/jos-1', '--force');
    const result = cleanupCheckout(f.registry, 'fixture', f.config, false, f.inspect);
    assert.equal(result.safe, false); assert.equal(existsSync(f.path), true); assert.equal(f.registry.read().checkouts.fixture.phase, 'present');
  });
}

test('suspected secret names block before content inspection, including inside allowlisted directories', () => {
  for (const name of ['.env', '.env.local', 'credentials.json', 'secrets.json', 'private.key', 'server.pem', 'api-key.json']) assert.equal(suspectedSecret(name), true);
  let directories = 0;
  const names = checkNames('/fixture', ((_path: string) => {
    directories++;
    return directories === 1 ? [{ name: 'node_modules', isDirectory: () => true }] : [{ name: '.env.local', isDirectory: () => { throw new Error('Must not access a suspected secret'); } }];
  }) as any);
  assert.equal(names.length, 1); assert.equal(directories, 2);
});

test('live processes protect a checkout even after its runner owner dies', async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: f.path, stdio: 'ignore' });
  await new Promise<void>(resolve => child.once('spawn', resolve));
  t.after(() => child.kill('SIGKILL'));
  assert.ok(checkoutActivity(f.path).some(reason => reason.includes(`Process ${child.pid} has checkout cwd`)));
  assert.equal(inspectCheckout(f.checkout, f.ticket, f.config).safe, false);
  f.registry.update(s => { s.checkouts.fixture.owner = { pid: 2147483647, start: 'old', boot: 'old' }; reconcile(s, f.config); });
  assert.equal(f.registry.read().checkouts.fixture.activityUnknown, true);
  assert.equal(existsSync(f.path), true);
});

test('restart recovery preserves inactive dirty output and protects unregistered worktrees', t => {
  const f = fixture(t); writeFileSync(join(f.path, 'draft.txt'), 'retained');
  f.registry.update(s => { s.checkouts.fixture.owner = { pid: 2147483647, start: 'old', boot: 'old' }; reconcile(s, f.config, () => []); });
  const state = f.registry.read();
  assert.equal(state.checkouts.fixture.owner, undefined); assert.equal(state.checkouts.fixture.phase, 'present');
  assert.ok(state.inventory.some(w => w.path === f.repo));
  assert.equal(cleanupCheckout(f.registry, 'fixture', f.config, false, f.inspect).safe, false);
});

test('revision changes during cleanup and failed or incomplete removal never release capacity', t => {
  const f = fixture(t); let passes = 0;
  const result = cleanupCheckout(f.registry, 'fixture', f.config, false, (...args) => {
    if (++passes === 2) writeFileSync(join(f.path, 'draft.txt'), 'racing output');
    return f.inspect(...args);
  });
  assert.equal(result.safe, false); assert.equal(existsSync(f.path), true);
  rmSync(join(f.path, 'draft.txt'));
  for (const remove of [() => { throw new Error('simulated EBUSY'); }, () => '']) {
    const failed = cleanupCheckout(f.registry, 'fixture', f.config, false, f.inspect, remove);
    assert.equal(failed.safe, false); assert.equal(f.registry.read().checkouts.fixture.phase, 'present');
  }
});

test('an unregistered existing branch defers before reserving or overwriting historical output', async t => {
  const f = fixture(t);
  f.registry.update(s => { s.tickets = {}; s.checkouts = {}; });
  const { acquire } = await import('./service.ts');
  const result = await acquire(f.config, { identifier: 'JOS-1', id: 'one', teamKey: 'JOS', projectName: 'task-runner', comments: [] } as any, 'custom', async () => {});
  assert.equal(result.hold?.kind, 'lifecycle'); assert.match(result.hold?.reason ?? '', /unregistered branch/);
  assert.equal(Object.keys(f.registry.read().tickets).length, 0);
  assert.equal(existsSync(f.path), true); assert.equal(f.git(f.path, 'rev-parse', 'HEAD'), f.head);
});
