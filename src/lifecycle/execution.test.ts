import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lifecycleConfig } from './model.ts';
import { monitoredExecution } from './execution.ts';
import { Registry } from './registry.ts';
import type { TaskRunnerConfig, AgentResult } from '../types.ts';

test('a monitored worker stops before invoking native Codex when headroom is below the configured threshold', async t => {
  const root = mkdtempSync(join(tmpdir(), 'runner-worker-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { projects: {}, lifecycle: lifecycleConfig({ registryPath: join(root, 'state.sqlite'), diskStopGiB: 1e12, diskResumeGiB: 2e12, diskCheckMs: 20 }) } as TaskRunnerConfig;
  const result = await monitoredExecution({ kind: 'agent', options: { prompt: 'Never run', cwd: root, model: 'invalid-fixture', reasoningEffort: 'low', profile: 'read', timeoutMs: 1000, context: 'fixture' } }, config) as AgentResult;
  assert.equal(result.cancelled, true); assert.equal(result.success, false); assert.equal(new Registry(config.lifecycle.registryPath).read().disk.held, true);
});

test('execution disk cancellation keeps running while the coordinator event loop is blocked', async t => {
  const root = mkdtempSync(join(tmpdir(), 'runner-monitor-loop-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { projects: {}, lifecycle: lifecycleConfig({ registryPath: join(root, 'state.sqlite'), diskCheckMs: 50 }) } as TaskRunnerConfig;
  const script = `import {parentPort,workerData} from 'node:worker_threads';
import {monitor} from ${JSON.stringify(new URL('./service.ts', import.meta.url).href)};
import {runValidationCommand} from ${JSON.stringify(new URL('../validation/process.ts', import.meta.url).href)};
let probes=0; const guard=monitor(workerData.config,async()=>[{path:'fake-windows-backing',freeBytes:(++probes<4?20:9)*1024**3}]);
parentPort.postMessage({ready:true}); const start=Date.now();
try {await runValidationCommand(workerData.command,workerData.root,10000,guard.signal); parentPort.postMessage({error:'not cancelled'});}
catch(e) {parentPort.postMessage({elapsed:Date.now()-start,error:e.message});}
finally {await guard.stop();parentPort.close();}`;
  const command = `node -e 'require("node:fs").writeFileSync("partial.txt", "retained"); setInterval(()=>{},1000)'`;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(script)), { workerData: { config, root, command } });
  const result = new Promise<any>((resolve, reject) => { worker.on('error', reject); worker.on('message', message => { if (message.ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200); else resolve(message); }); });
  const message = await result;
  assert.match(message.error, /cancelled/); assert.ok(message.elapsed < 1000, `Worker took ${message.elapsed}ms`);
  assert.equal(readFileSync(join(root, 'partial.txt'), 'utf8'), 'retained');
  assert.equal(new Registry(config.lifecycle.registryPath).read().disk.held, true);
});
