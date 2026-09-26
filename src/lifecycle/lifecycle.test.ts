import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { Registry } from './registry.ts';
import { emptyState, evaluate, lifecycleConfig } from './model.ts';
import { reserve, monitor, registryFor, reconcile } from './service.ts';
import { applyDiskSamples } from './disk.ts';
import { authorize } from './authorization.ts';
import { identity, alive } from './processes.ts';
import type { TaskRunnerConfig, LinearIssue } from '../types.ts';

export function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'runner-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { projects: { one: { repoPath: join(root, 'one'), defaultBranch: 'main', testCommand: '', lintCommand: '' }, two: { repoPath: join(root, 'two'), defaultBranch: 'main', testCommand: '', lintCommand: '' } },
    lifecycle: lifecycleConfig({ registryPath: join(root, 'state/registry.sqlite'), controlCheckout: join(root, 'one') }),
    defaults: { contextModel: 'fixture', contextReasoningEffort: 'low', agentTimeoutMs: 2000 }, linear: { agentLabel: 'agent-ready', doneState: 'Done' } } as TaskRunnerConfig;
  return { root, config, registry: registryFor(config) };
}
export function issue(n: number, project = 'one'): LinearIssue { return { identifier: `JOS-${n}`, id: `id-${n}`, teamKey: 'JOS', projectName: project } as LinearIssue; }

test('atomic admissions across processes and repositories enforce both counters', async t => {
  const { config, registry } = fixture(t);
  registry.update(() => {});
  const script = `import { Registry } from ${JSON.stringify(new URL('./registry.ts', import.meta.url).pathname)};
import { reserve } from ${JSON.stringify(new URL('./service.ts', import.meta.url).pathname)};
const config=JSON.parse(process.argv[1]), n=Number(process.argv[2]);
const issue={identifier:'JOS-'+n,id:'id-'+n,teamKey:'JOS',projectName:n%2?'one':'two'};
const result=new Registry(config.lifecycle.registryPath).update(s=>reserve(s,config,issue,'custom'));
console.log(JSON.stringify(result));`;
  const results = await Promise.all(Array.from({ length: 12 }, (_, n) => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, JSON.stringify(config), String(n)]);
    let output = ''; let errors = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => errors += c);
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output.trim())) : reject(new Error(errors)));
  })));
  assert.equal(results.filter(r => r.lease).length, 5);
  assert.equal(Object.keys(registry.read().tickets).length, 5);
  registry.update(s => { for (const c of Object.values(s.checkouts)) c.phase = 'removed'; });
  const blocked = registry.update(s => reserve(s, config, issue(20), 'different'));
  assert.equal(blocked.hold?.kind, 'capacity', 'removed checkout must not release unfinished capacity');
  assert.ok(Object.values(registry.read().tickets).every(t => t.queueLabel === 'custom'));
});

test('persistent clocks survive retries, removed checkouts, and new processes; overdue holds are global', t => {
  const { config, registry } = fixture(t); const now = Date.now() - 73 * 3600_000;
  registry.update(s => reserve(s, config, issue(1), 'custom', now));
  registry.update(s => { for (const c of Object.values(s.checkouts)) { c.phase = 'removed'; c.owner = undefined; } });
  const clock = registry.read().tickets['JOS-1'];
  assert.equal(registry.update(s => reserve(s, config, issue(2, 'two'), 'other')).hold?.kind, 'age');
  const retry = registry.update(s => reserve(s, config, issue(1), 'custom'));
  assert.ok(retry.lease);
  assert.equal(registry.read().tickets['JOS-1'].startedAt, clock.startedAt);
  assert.equal(registry.read().tickets['JOS-1'].deadline, clock.deadline);
});

test('existing work can continue at capacity but additional checkouts still need a physical slot', t => {
  const { config, registry } = fixture(t); config.lifecycle.maxWorktrees = 1; config.lifecycle.maxUnfinished = 1;
  registry.update(s => reserve(s, config, issue(1), 'ready'));
  registry.update(s => { for (const c of Object.values(s.checkouts)) c.owner = undefined; });
  assert.ok(registry.update(s => reserve(s, config, issue(1), 'ready')).lease);
  registry.update(s => { s.tickets['JOS-2'] = { ...s.tickets['JOS-1'], identifier: 'JOS-2', issueId: 'id-2' }; });
  assert.equal(registry.update(s => reserve(s, config, issue(2), 'ready')).hold?.kind, 'capacity');
});

test('disk hysteresis uses the least headroom including Windows and fails closed on unknown evidence', () => {
  const state = emptyState(); const config = lifecycleConfig(); const sample = (n: number) => [{ path: 'linux', freeBytes: 500 * 1024 ** 3 }, { path: 'windows-backing', freeBytes: n * 1024 ** 3 }];
  applyDiskSamples(state, sample(9), config); assert.equal(state.disk.held, true);
  for (const n of [10, 14, 15]) { applyDiskSamples(state, sample(n), config); assert.equal(state.disk.held, true); }
  applyDiskSamples(state, sample(15.01), config); assert.equal(state.disk.held, false);
  applyDiskSamples(state, [{ path: 'windows-backing', error: 'Unavailable' }], config); assert.equal(state.disk.held, true);
  applyDiskSamples(state, sample(11), config); assert.equal(state.disk.held, true);
});

test('rapidly growing output and accumulated failure storage cancel execution without writing large files', async t => {
  const { config, registry } = fixture(t); config.lifecycle.diskCheckMs = 10;
  registry.update(s => reserve(s, config, issue(1), 'custom'));
  const headroom = [20, 17, 9];
  const guard = monitor(config, async () => [{ path: 'windows-backing', freeBytes: headroom.shift()! * 1024 ** 3 }]);
  t.after(() => guard.stop());
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Monitor did not cancel')), 2000);
    guard.signal.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
  assert.equal(registry.read().disk.held, true);
  assert.equal(registry.update(s => reserve(s, config, issue(2), 'custom')).hold?.kind, 'disk');
});

test('deadline extensions require matching authorization and do not bypass other holds', async t => {
  const { config, registry } = fixture(t);
  registry.update(s => reserve(s, config, issue(1), 'custom', Date.now() - 74 * 3600_000));
  await assert.rejects(authorize(config, 'missing', { action: 'extend', identifier: 'JOS-1', reason: 'retry', deadline: new Date(Date.now() + 3600_000).toISOString() }), /joshUserId/);
  registry.update(s => { s.disk = { held: true, reasons: ['Low disk'] }; });
  await authorize(config, 'approval', { action: 'extend', identifier: 'JOS-1', reason: 'Josh approved more time', deadline: new Date(Date.now() + 3600_000).toISOString() }, async () => 'approval');
  assert.ok(!evaluate(registry.read(), config.lifecycle).some(h => h.kind === 'age'));
  assert.equal(registry.update(s => reserve(s, config, issue(2), 'custom')).hold?.kind, 'disk');
  await assert.rejects(authorize(config, 'approval', { action: 'cancel', identifier: 'JOS-1', reason: 'cancel' }, async () => 'approval'), /consumed/);
});

test('registry transactions rollback on errors and dry reads create no state', t => {
  const { registry } = fixture(t);
  assert.deepEqual(registry.read(), emptyState()); assert.equal(existsSync(registry.path), false);
  assert.throws(() => registry.update(s => { s.disk.held = true; throw new Error('abort'); }), /abort/);
  assert.equal(registry.read().disk.held, false);
});

test('process identities reject PID reuse; an old clock never makes a live owner disposable', t => {
  const { registry, config } = fixture(t);
  const owner = identity(); assert.equal(alive(owner), true); assert.equal(alive({ ...owner, start: 'wrong' }), false);
  registry.update(s => reserve(s, config, issue(1), 'custom', 1));
  assert.equal(registry.update(s => reserve(s, config, issue(1), 'custom')).hold?.kind, 'lifecycle');
});

test('closing an unmerged PR never completes a ticket; only matching inactive merge evidence releases unfinished capacity', async () => {
  const { reconcilePublishedTicket } = await import('./service.ts');
  const state = emptyState();
  const ticket = { identifier: 'JOS-1', issueId: 'one', teamKey: 'JOS', project: 'one', queueLabel: 'custom', startedAt: 1, deadline: 2,
    pr: { url: 'https://github.com/fixture/repo/pull/1', head: 'a'.repeat(40), branch: 'task-runner/jos-1', repository: 'fixture/repo' } };
  state.tickets['JOS-1'] = structuredClone(ticket);
  const snapshot = { state: 'CLOSED', mergedAt: null as string | null, url: ticket.pr.url, headRefOid: ticket.pr.head, headRefName: ticket.pr.branch };
  reconcilePublishedTicket(state, structuredClone(state.tickets['JOS-1']), snapshot);
  assert.equal(state.tickets['JOS-1'].resolution, undefined);
  snapshot.state = 'MERGED'; snapshot.mergedAt = new Date().toISOString();
  state.checkouts.one = { id: 'one', ticket: 'JOS-1', project: 'one', repoPath: '/fixture', path: '/fixture/output', branch: ticket.pr.branch, protected: false, phase: 'present', owner: identity(), revision: ticket.pr.head };
  reconcilePublishedTicket(state, structuredClone(state.tickets['JOS-1']), snapshot);
  assert.equal(state.tickets['JOS-1'].resolution, undefined);
  state.checkouts.one.owner = undefined; state.checkouts.one.revision = 'b'.repeat(40);
  reconcilePublishedTicket(state, structuredClone(state.tickets['JOS-1']), snapshot);
  assert.equal(state.tickets['JOS-1'].resolution, undefined);
  state.checkouts.one.phase = 'removed';
  reconcilePublishedTicket(state, structuredClone(state.tickets['JOS-1']), { ...snapshot, headRefOid: 'wrong' });
  assert.equal(state.tickets['JOS-1'].resolution, undefined);
  reconcilePublishedTicket(state, structuredClone(state.tickets['JOS-1']), snapshot);
  assert.equal(state.tickets['JOS-1'].resolution?.kind, 'merged');
});

test('historical execution requires explicit adoption even after its checkout is gone', t => {
  const { config, registry } = fixture(t);
  const oldIssue = { ...issue(9), comments: ['## Agent Starting Work\nOld execution'] };
  assert.match(registry.update(s => reserve(s, config, oldIssue, 'custom')).hold?.reason ?? '', /adoption/);
  assert.equal(Object.keys(registry.read().tickets).length, 0);
});
