import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Registry } from './registry.ts';
import { evaluate } from './model.ts';
import type { Checkout, Hold, State, Ticket } from './model.ts';
import { alive, identity, checkoutActivity } from './processes.ts';
import { sampleDisks, applyDiskSamples } from './disk.ts';
import { cleanupCheckout, prEvidence, worktrees } from './cleanup.ts';
import { assess } from './assessment.ts';
import { getWorktreePath, getBranchName, resolveGitDir } from '../git/worktree.ts';
import { execGit, execGh } from '../git/exec.ts';
import { getGitHubRepository } from '../git/remote.ts';
import { addComment } from '../linear/mutations.ts';
import { log } from '../logger.ts';
import type { LinearIssue, TaskRunnerConfig } from '../types.ts';

export interface Lease { id: string; token: string; path: string; reuse: boolean; reuseBranch?: boolean }
export type Admission = { lease: Lease; hold?: never } | { hold: Hold; lease?: never };
export const registryFor = (config: TaskRunnerConfig) => new Registry(config.lifecycle.registryPath);

export function reconcile(state: State, config: TaskRunnerConfig, activity = checkoutActivity): void {
  const inventory: State['inventory'] = [];
  for (const [project, settings] of Object.entries(config.projects)) {
    const entries = worktrees(settings.repoPath);
    for (const entry of entries.filter(w => !w.bare)) {
      const owned = Object.values(state.checkouts).find(c => c.path === entry.path && c.phase !== 'removed');
      if (!owned) inventory.push({ project, path: entry.path, branch: entry.branch, protection: 'Unregistered: manual/permanent/ambiguous; explicit adoption required' });
    }
    for (const checkout of Object.values(state.checkouts).filter(c => c.project === project && c.phase !== 'removed')) {
      if (checkout.cleanup) {
        const living = alive(checkout.cleanup.owner);
        if (living === true) continue;
        const blockers = living === 'unknown' ? ['Cleanup owner cannot be verified'] : activity(checkout.path);
        if (blockers.length) { checkout.activityUnknown = true; checkout.error = blockers.join('; '); continue; }
        checkout.cleanup = undefined; checkout.activityUnknown = false;
      }
      const entry = entries.find(w => w.path === checkout.path);
      if (entry) checkout.revision = entry.head;
      if (checkout.owner) {
        const living = alive(checkout.owner);
        if (living === true) { checkout.activityUnknown = false; continue; }
        if (living === 'unknown') { checkout.activityUnknown = true; continue; }
        const blockers = activity(checkout.path);
        if (blockers.length) { checkout.activityUnknown = true; checkout.error = blockers.join('; '); continue; }
        checkout.owner = undefined; checkout.token = undefined; checkout.activityUnknown = false;
      }
      if (entry) {
        checkout.phase = 'present';
        if (entry.branch !== checkout.branch) { checkout.protected = true; checkout.error = 'Branch ownership changed'; }
      } else if (!existsSync(checkout.path)) {
        // Absence verified in both Git and the filesystem, never inferred from a heartbeat.
        checkout.phase = 'removed';
      } else { checkout.protected = true; checkout.error = 'Directory exists without matching Git registration'; }
    }
  }
  state.inventory = inventory.sort((a, b) => a.path.localeCompare(b.path));
  evaluate(state, config.lifecycle);
}

export function reserve(state: State, config: TaskRunnerConfig, issue: LinearIssue, queueLabel: string, now = Date.now()): Admission {
  evaluate(state, config.lifecycle, now);
  const existing = state.tickets[issue.identifier];
  const general = state.holds.find(h => h.kind === 'disk' || h.kind === 'lifecycle');
  if (general) return { hold: general };
  if (existing?.resolution || existing?.disposition?.kind === 'deferred') return { hold: { kind: 'lifecycle', reason: 'Ticket is resolved or Josh-deferred; an explicit disposition is required' } };
  if (!existing && state.holds.length) return { hold: state.holds[0] };
  if (!existing && issue.comments?.some(c => /^(## Agent Starting Work|## Agent Failed|🤖 Agent failed|🤖 PR created:)/.test(c))) return { hold: { kind: "lifecycle", reason: "Previous runner execution requires explicit adoption of the original clock" } };
  const project = config.projects[issue.projectName!];
  if (!project) throw new Error('Project is not configured');
  let checkout = Object.values(state.checkouts).find(c => c.ticket === issue.identifier && c.phase !== 'removed');
  if (checkout && (checkout.owner || checkout.cleanup || checkout.protected || checkout.activityUnknown)) return { hold: { kind: 'lifecycle', reason: 'Ticket checkout is active or protected' } };
  if (!checkout && Object.values(state.checkouts).filter(c => c.phase !== 'removed').length >= config.lifecycle.maxWorktrees) return { hold: { kind: 'capacity', reason: 'An additional checkout requires a physical slot' } };
  const path = getWorktreePath(project.repoPath, issue.identifier);
  if (!checkout && existsSync(path)) return { hold: { kind: 'lifecycle', reason: 'Unregistered output at the requested path requires explicit adoption' } };
  if (existing && (existing.project !== issue.projectName || (existing.issueId !== issue.id && existing.issueId !== issue.identifier))) return { hold: { kind: 'lifecycle', reason: 'Ticket ownership association changed' } };
  if (!existing) state.tickets[issue.identifier] = {
    identifier: issue.identifier, issueId: issue.id, teamKey: issue.teamKey, project: issue.projectName!, queueLabel,
    startedAt: now, deadline: now + config.lifecycle.timeboxHours * 3600_000,
  };
  if (existing) { existing.issueId = issue.id; existing.pausedForDisk = false; }
  const reuse = !!checkout;
  const reuseBranch = Object.values(state.checkouts).some(c => c.ticket === issue.identifier && c.branch === getBranchName(issue.identifier, project.branchPrefix));
  checkout ??= { id: randomUUID(), ticket: issue.identifier, project: issue.projectName!, repoPath: resolve(project.repoPath),
    path, branch: getBranchName(issue.identifier, project.branchPrefix), phase: 'reserved', protected: false };
  checkout.owner = identity(); checkout.token = randomUUID(); checkout.error = undefined;
  state.checkouts[checkout.id] = checkout;
  evaluate(state, config.lifecycle, now);
  return { lease: { id: checkout.id, token: checkout.token, path: checkout.path, reuse, reuseBranch } };
}
export async function acquire(config: TaskRunnerConfig, issue: LinearIssue, queueLabel: string, notifyDeferred = addComment): Promise<Admission> {
  try {
    await checkLifecycle(config);
    const registry = registryFor(config);
    const samples = await sampleDisks(config);
    const admission = registry.update(state => {
      applyDiskSamples(state, samples, config.lifecycle); reconcile(state, config);
      const project = config.projects[issue.projectName!];
      const branch = getBranchName(issue.identifier, project.branchPrefix);
      const branchExists = execGit(['branch', '--list', branch], { cwd: resolveGitDir(project.repoPath) });
      if (branchExists && !Object.values(state.checkouts).some(c => c.ticket === issue.identifier && c.project === issue.projectName && c.branch === branch)) {
        return { hold: { kind: 'lifecycle', reason: 'An unregistered branch requires explicit ownership adoption' } } as Admission;
      }
      return reserve(state, config, issue, queueLabel);
    });
    if (admission.lease && registry.read().triggerActive) {
      try { await checkLifecycle(config); }
      catch (e: any) { log("WARN", issue.identifier, `Post-reservation assessment failed: ${e.message}`); }
    }
    if (admission.hold) {
      const notice = `admission:${issue.identifier}`;
      const reason = `${admission.hold.kind}: ${admission.hold.reason}`;
      if (registry.read().notices[notice] !== reason) {
        try {
          await notifyDeferred(issue.id, `TaskRunner deferred (${reason}). Queue labels and execution attempts are unchanged. Use lifecycle status/check; Josh alone can extend deadlines or authorize dispositions.`);
          registry.update(state => { state.notices[notice] = reason; });
        } catch (e: any) { log('WARN', issue.identifier, `Deferred-hold reporting failed: ${e.message}`); }
      }
    }
    return admission;
  } catch (e: any) { return { hold: { kind: 'lifecycle', reason: `Lifecycle evidence unavailable: ${e.message}` } }; }
}
export function activate(config: TaskRunnerConfig, lease: Lease): void {
  registryFor(config).update(state => {
    const c = owned(state, lease);
    if (realpathSync(c.path) !== c.path || !worktrees(c.repoPath).some(w => w.path === c.path && w.branch === c.branch && !w.locked)) throw new Error('Created checkout ownership could not be verified');
    c.phase = 'present';
  });
}
function owned(state: State, lease: Lease): Checkout {
  const c = state.checkouts[lease.id];
  if (!c || c.token !== lease.token || !c.owner || alive(c.owner) !== true) throw new Error('Lifecycle reservation no longer owned by this process');
  return c;
}
export function reusablePR(config: TaskRunnerConfig, lease: Lease): string | undefined {
  const state = registryFor(config).read();
  const c = owned(state, lease); const ticket = state.tickets[c.ticket];
  if (!ticket.pr) return undefined;
  const current = JSON.parse(execGh(['pr', 'view', ticket.pr.url, '--json', 'url,state,headRefName,headRefOid'], { cwd: c.path }));
  if (current.state !== 'OPEN') return undefined;
  if (current.url !== ticket.pr.url || current.headRefName !== c.branch || current.headRefOid !== execGit(['rev-parse', 'HEAD'], { cwd: c.path }) || getGitHubRepository(c.repoPath) !== ticket.pr.repository) throw new Error('Review-fix PR ownership mismatch');
  return current.url;
}
export function published(config: TaskRunnerConfig, lease: Lease, url: string): void {
  registryFor(config).update(state => {
    const c = owned(state, lease);
    const repository = getGitHubRepository(c.repoPath);
    if (!repository || !url.startsWith(`https://github.com/${repository}/pull/`)) throw new Error('Published PR repository mismatch');
    state.tickets[c.ticket].pr = { url, head: execGit(['rev-parse', 'HEAD'], { cwd: c.path }), branch: c.branch, repository };
  });
}
export function pauseDisk(config: TaskRunnerConfig, lease: Lease): void {
  registryFor(config).update(state => { const c = owned(state, lease); state.tickets[c.ticket].pausedForDisk = true; });
}
export function releaseLease(config: TaskRunnerConfig, lease: Lease): void {
  registryFor(config).update(state => {
    const c = owned(state, lease);
    c.owner = undefined; c.token = undefined; c.activityUnknown = false;
    if (!existsSync(c.path) && !worktrees(c.repoPath).some(w => w.path === c.path)) c.phase = 'removed';
    evaluate(state, config.lifecycle);
  });
}
export function cleanup(config: TaskRunnerConfig, lease: Lease) {
  const registry = registryFor(config);
  const result = cleanupCheckout(registry, lease.id, config);
  if (!result.safe) registry.update(state => { state.checkouts[lease.id].error = result.reasons.join("; "); });
  return result;
}
export function monitor(config: TaskRunnerConfig, sample = sampleDisks) {
  const controller = new AbortController();
  let stopped = false; let pending: Promise<void> | undefined;
  const tick = async () => {
    try {
      const samples = await sample(config);
      if (stopped) return;
      const held = registryFor(config).update(state => { applyDiskSamples(state, samples, config.lifecycle); evaluate(state, config.lifecycle); return state.disk.held; });
      if (held) controller.abort(new Error('Disk safety hold'));
    } catch { controller.abort(new Error('Disk safety monitoring unavailable')); }
  };
  const timer = setInterval(() => { if (!pending) pending = tick().finally(() => { pending = undefined; }); }, config.lifecycle.diskCheckMs);
  return { signal: controller.signal, check: tick, stop: async () => { stopped = true; clearInterval(timer); await pending; } };
}

async function reportHolds(registry: Registry, state: State): Promise<void> {
  if (!state.holds.length) return;
  const text = state.holds.map(h => h.reason).join('\n') + (state.assessment ? `\nAssessment: ${JSON.stringify(state.assessment.report ?? state.assessment.error ?? state.assessment.status)}` : '');
  if (!text) return;
  const key = createHash('sha256').update(text).digest('hex');
  for (const ticket of Object.values(state.tickets).filter(t => !t.resolution)) {
    if (state.notices[ticket.identifier] === key) continue;
    try {
      await addComment(ticket.issueId, `TaskRunner lifecycle hold\n\n${text}\n\nExisting work and verified cleanup remain permitted subject to disk safety. Josh alone can extend deadlines or authorize dispositions. Use lifecycle status/check for evidence.`);
      registry.update(current => { current.notices[ticket.identifier] = key; });
    } catch (e: any) { log('WARN', ticket.identifier, `Lifecycle reporting failed: ${e.message}`); }
  }
}
export function reconcilePublishedTicket(state: State, ticket: Ticket, pr: { state: string; mergedAt: string | null; url: string; headRefOid: string; headRefName: string }): void {
  const current = state.tickets[ticket.identifier];
  if (!current?.pr || JSON.stringify(current.pr) !== JSON.stringify(ticket.pr)) return;
  if (pr.url !== current.pr.url || pr.headRefOid !== current.pr.head || pr.headRefName !== current.pr.branch) return;
  current.pr.state = pr.state;
  const activeOrChanged = Object.values(state.checkouts).some(c => c.ticket === ticket.identifier && c.phase !== 'removed' && (c.owner || c.revision !== pr.headRefOid));
  if (pr.state === 'MERGED' && pr.mergedAt && Number.isFinite(Date.parse(pr.mergedAt)) && !activeOrChanged) current.resolution = { at: Date.now(), kind: 'merged', evidence: `${pr.url}@${pr.headRefOid}` };
}
export async function checkLifecycle(config: TaskRunnerConfig, options: { dryRun?: boolean; retryAssessment?: boolean } = {}): Promise<State> {
  const registry = registryFor(config);
  const samples = await sampleDisks(config);
  const update = (state: State) => { applyDiskSamples(state, samples, config.lifecycle); reconcile(state, config); return state; };
  if (options.dryRun) return update(registry.read());
  registry.update(update);
  // Only registered ticket/PR associations are in TaskRunner's authority.
  for (const ticket of Object.values(registry.read().tickets).filter(t => t.pr && !t.resolution)) {
    try {
      const pr = prEvidence(ticket, config.projects[ticket.project].repoPath);
      registry.update(state => {
        reconcile(state, config);
        reconcilePublishedTicket(state, ticket, pr);
        evaluate(state, config.lifecycle);
      });

    } catch (e: any) { log('WARN', ticket.identifier, `Lifecycle PR reconciliation: ${e.message}`); }
  }
  const diskMonitor = monitor(config);
  try {
    await diskMonitor.check();
    await assess(registry, config, { retry: options.retryAssessment, signal: diskMonitor.signal });
    const state = registry.read();
    if (state.triggerActive && !state.disk.held && !diskMonitor.signal.aborted && state.assessment?.status === 'complete') {
      for (const id of state.assessment.report?.cleanupCandidates ?? []) {
        if (!Object.hasOwn(state.checkouts, id) || state.checkouts[id].phase === "removed") continue;
        const result = cleanupCheckout(registry, id, config);
        if (!result.safe) registry.update(current => { if (Object.hasOwn(current.checkouts, id)) current.checkouts[id].error = result.reasons.join('; '); });
      }
    }
  } finally { await diskMonitor.stop(); }
  const state = registry.update(state => { evaluate(state, config.lifecycle); return state; });
  await reportHolds(registry, state);
  return state;
}
