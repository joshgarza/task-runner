import { parentPort, workerData } from 'node:worker_threads';
import { monitor } from './service.ts';
import { runLocalCodex } from '../agents/spawn.ts';
import { validateAgentOutput } from '../validation/validate.ts';
import type { ExecutionTask } from './execution.ts';
import type { TaskRunnerConfig } from '../types.ts';

const { task, config } = workerData as { task: ExecutionTask; config: TaskRunnerConfig };
const external = new AbortController();
parentPort!.on('message', message => { if (message.abort) external.abort(); });
const guard = monitor(config);
const signal = AbortSignal.any([external.signal, guard.signal]);
try {
  await guard.check();
  const result = task.kind === 'agent'
    ? await runLocalCodex({ ...task.options, signal })
    : await validateAgentOutput(task.path, task.branch, task.project, task.identifier, signal);
  if (signal.aborted) result.cancelled = true;
  parentPort!.postMessage({ result });
} catch (e: any) {
  if (signal.aborted) parentPort!.postMessage({ result: task.kind === 'agent'
    ? { success: false, output: '', stderr: 'Disk safety cancelled native execution', durationMs: 0, exitCode: 1, cancelled: true }
    : { valid: false, errors: ['Disk safety cancelled validation'], warnings: [], retryable: false, cancelled: true } });
  else parentPort!.postMessage({ error: e.message });
} finally { await guard.stop(); parentPort!.close(); }
