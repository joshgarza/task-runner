import { Worker } from 'node:worker_threads';
import type { TaskRunnerConfig, AgentResult, ValidationResult, ProjectConfig } from '../types.ts';
import type { LocalCodexOptions } from '../agents/spawn.ts';

export type ExecutionTask = { kind: 'agent'; options: Omit<LocalCodexOptions, 'signal' | 'diskConfig'> } |
  { kind: 'validation'; path: string; branch: string; project: ProjectConfig; identifier: string };
/** Each execution gets an independent event loop so coordinator Git calls cannot stall monitoring. */
export function monitoredExecution(task: ExecutionTask, config: TaskRunnerConfig, signal?: AbortSignal): Promise<AgentResult | ValidationResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./execution-worker.ts', import.meta.url), {
      workerData: { task, config }, execArgv: ['--experimental-strip-types'],
    });
    const abort = () => worker.postMessage({ abort: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let settled = false;
    const detach = () => signal?.removeEventListener('abort', abort);
    worker.on('message', message => {
      settled = true; detach();
      if (message.error) reject(new Error(message.error)); else resolve(message.result);
    });
    worker.on('error', error => { settled = true; detach(); reject(error); });
    worker.on('exit', code => { detach(); if (!settled) reject(new Error(`Monitored execution exited without a result (${code})`)); });
  });
}
