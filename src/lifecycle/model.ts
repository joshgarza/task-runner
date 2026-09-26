import type { LifecycleConfig, TaskRunnerConfig } from '../types.ts';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export interface Identity { pid: number; boot: string; start: string }
export interface Ticket {
  identifier: string; issueId: string; teamKey: string; project: string;
  startedAt: number; deadline: number; queueLabel: string;
  priority?: number; scope?: string; pausedForDisk?: boolean;
  resolution?: { at: number; kind: 'merged' | 'cancelled'; evidence: string };
  disposition?: { kind: 'deferred' | 'reprioritized' | 'scope-change'; reason: string; authorization: string };
  pr?: { url: string; head: string; branch: string; repository: string; state?: string };
}
export interface Checkout {
  id: string; ticket: string; project: string; repoPath: string; path: string; branch: string;
  phase: 'reserved' | 'present' | 'removed'; owner?: Identity; token?: string;
  protected: boolean; recoveryRef?: string; error?: string; revision?: string;
  activityUnknown?: boolean;
}
export interface Hold { kind: 'capacity' | 'age' | 'disk' | 'lifecycle'; reason: string }
export interface Assessment {
  key: string; at: number; status: 'running' | 'complete' | 'failed'; owner?: Identity;
  report?: AssessmentReport; error?: string;
}
export interface AssessmentReport {
  cause: 'review-waiting' | 'underestimated-scope' | 'priority-uncertainty' | 'execution-problems' | 'unknown';
  evidence: string[]; cleanupCandidates: string[]; decisionNeeded: string;
}
export interface State {
  version: 1; tickets: Record<string, Ticket>; checkouts: Record<string, Checkout>;
  disk: { held: boolean; reasons: string[] }; holds: Hold[];
  assessment?: Assessment; episode: number; triggerActive: boolean;
  notices: Record<string, string>; authorizations: Record<string, string>;
  inventory: Array<{ project: string; path: string; branch: string; protection: string }>;
}
export function emptyState(): State {
  return { version: 1, tickets: {}, checkouts: {}, disk: { held: false, reasons: [] }, holds: [],
    episode: 0, triggerActive: false, notices: {}, authorizations: {}, inventory: [] };
}
export function lifecycleConfig(raw: Partial<LifecycleConfig> = {}, projects: TaskRunnerConfig['projects'] = {}): LifecycleConfig {
  const config: LifecycleConfig = {
    registryPath: resolve(homedir(), '.local/state/task-runner/lifecycle.sqlite'),
    controlCheckout: projects['task-runner']?.repoPath ?? '',
    maxWorktrees: 5, maxUnfinished: 5, timeboxHours: 72,
    diskStopGiB: 10, diskResumeGiB: 15, diskCheckMs: 10_000, diskPaths: [], ...raw,
  };
  for (const field of ['maxWorktrees', 'maxUnfinished', 'timeboxHours', 'diskStopGiB', 'diskResumeGiB', 'diskCheckMs'] as const) {
    if (!Number.isFinite(config[field]) || config[field] <= 0) throw new Error(`Invalid lifecycle.${field}`);
  }
  if (!Number.isInteger(config.maxWorktrees) || !Number.isInteger(config.maxUnfinished) ||
      config.diskResumeGiB <= config.diskStopGiB) throw new Error('Invalid lifecycle capacity or disk hysteresis');
  if (!isAbsolute(config.registryPath) || !Array.isArray(config.diskPaths) || config.diskPaths.some(p => !isAbsolute(p))) {
    throw new Error('Lifecycle registry and disk paths must be absolute');
  }
  return config;
}
export function evaluate(state: State, config: LifecycleConfig, now = Date.now()): Hold[] {
  const holds: Hold[] = [];
  const physical = Object.values(state.checkouts).filter(c => c.phase !== 'removed').length;
  const unfinished = Object.values(state.tickets).filter(t => !t.resolution);
  if (physical >= config.maxWorktrees) holds.push({ kind: 'capacity', reason: `Physical capacity ${physical}/${config.maxWorktrees}` });
  if (unfinished.length >= config.maxUnfinished) holds.push({ kind: 'capacity', reason: `Unfinished tickets ${unfinished.length}/${config.maxUnfinished}` });
  for (const t of unfinished) {
    if (t.deadline <= now) holds.push({ kind: 'age', reason: `${t.identifier} overdue since ${new Date(t.deadline).toISOString()}` });
  }
  if (state.disk.held) holds.push({ kind: 'disk', reason: state.disk.reasons.join('; ') });
  for (const c of Object.values(state.checkouts)) {
    if (c.phase !== 'removed' && c.activityUnknown) holds.push({ kind: 'lifecycle', reason: `${c.ticket}: activity cannot be verified` });
  }
  state.holds = holds;
  const triggered = holds.some(h => h.kind === 'age' || h.kind === 'capacity');
  if (triggered && !state.triggerActive) state.episode++;
  state.triggerActive = triggered;
  return holds;
}
