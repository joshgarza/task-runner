import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Registry } from './registry.ts';
import { lifecycleConfig, evaluate } from './model.ts';
import { assess, parseAssessment } from './assessment.ts';
import type { TaskRunnerConfig } from '../types.ts';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'runner-assessment-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const control = join(root, 'control'); execFileSync('git', ['init', control], { stdio: 'ignore' });
  const config = { projects: {}, lifecycle: lifecycleConfig({ registryPath: join(root, 'state.sqlite'), controlCheckout: control, maxUnfinished: 1 }),
    defaults: { contextModel: 'fixture', contextReasoningEffort: 'low', agentTimeoutMs: 100 } } as TaskRunnerConfig;
  const registry = new Registry(config.lifecycle.registryPath);
  registry.update(s => {
    s.tickets['JOS-1'] = { identifier: 'JOS-1', issueId: 'one', project: 'fixture', teamKey: 'JOS', startedAt: 1, deadline: 2, queueLabel: 'custom' };
    evaluate(s, config.lifecycle);
  });
  return { registry, config, control };
}
const report = { cause: 'review-waiting', evidence: ['PR awaits review'], cleanupCandidates: [], decisionNeeded: 'Josh may extend deadline with a reason' };

test('assessment uses native read-only profile and permanent control checkout, deduplicated across concurrent checks', async t => {
  const { registry, config, control } = fixture(t); let calls = 0;
  const run: any = async (options: any) => {
    calls++; assert.equal(options.profile, 'read'); assert.equal(options.cwd, control); assert.ok(options.outputSchema);
    await new Promise(resolve => setTimeout(resolve, 30));
    return { success: true, output: JSON.stringify(report) };
  };
  await Promise.all([assess(registry, config, {}, run), assess(registry, config, {}, run)]);
  await assess(registry, config, {}, run); assert.equal(calls, 1);
  registry.update(s => { s.tickets['JOS-1'].deadline += 10; evaluate(s, config.lifecycle); });
  await assess(registry, config, {}, run); assert.equal(calls, 2);
  assert.deepEqual(registry.read().assessment?.report, report);
});
for (const kind of ['malformed', 'dependency-unavailable', 'unregistered-candidate', 'prototype-key']) {
  test(`${kind} assessment preserves the hold and does not repeat on unchanged polling`, async t => {
    const { registry, config } = fixture(t); let calls = 0;
    const run: any = async () => { calls++; return kind === 'dependency-unavailable' ? { success: false, stderr: 'Codex unavailable' } : { success: true, output: kind === 'malformed' ? '{}' : JSON.stringify({ ...report, cleanupCandidates: [kind === 'prototype-key' ? '__proto__' : 'not-owned'] }) }; };
    await assess(registry, config, {}, run); await assess(registry, config, {}, run);
    assert.equal(calls, 1); assert.equal(registry.read().assessment?.status, 'failed'); assert.ok(registry.read().holds.length);
    await assess(registry, config, { retry: true }, run); assert.equal(calls, 2);
  });
}
test('dry-run and disk holds do not spawn assessment or change registry', async t => {
  const { registry, config } = fixture(t); const before = registry.read();
  const run: any = () => { throw new Error('must not spawn'); };
  await assess(registry, config, { dryRun: true }, run); assert.deepEqual(registry.read(), before);
  registry.update(s => { s.disk.held = true; }); await assess(registry, config, {}, run);
});
test('schema validation rejects extra policy fields and unknown causes', () => {
  assert.throws(() => parseAssessment(JSON.stringify({ ...report, deleteCommand: 'rm' })));
  assert.throws(() => parseAssessment(JSON.stringify({ ...report, cause: 'automatically-cancel' })));
});
