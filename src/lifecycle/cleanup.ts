import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execGit, execGh } from '../git/exec.ts';
import { resolveGitDir } from '../git/worktree.ts';
import { getGitHubRepository } from '../git/remote.ts';
import { alive, checkoutActivity } from './processes.ts';
import { inside, Registry } from './registry.ts';
import type { Checkout, Ticket } from './model.ts';
import type { TaskRunnerConfig } from '../types.ts';

export interface WorktreeEntry { path: string; branch: string; head: string; locked: boolean; prunable: boolean; bare: boolean }
export function worktrees(repo: string): WorktreeEntry[] {
  const output = execGit(['worktree', 'list', '--porcelain', '-z'], { cwd: resolveGitDir(repo) });
  return output.split('\0\0').filter(Boolean).map(block => {
    const fields = block.split('\0');
    const value = (key: string) => fields.find(s => s.startsWith(key + ' '))?.slice(key.length + 1) ?? '';
    return { path: value('worktree'), branch: value('branch').replace(/^refs\/heads\//, ''), head: value('HEAD'),
      locked: fields.some(s => s === 'locked' || s.startsWith('locked ')), prunable: fields.some(s => s === 'prunable' || s.startsWith('prunable ')), bare: fields.includes('bare') };
  });
}
export function suspectedSecret(name: string): boolean {
  if (/^(\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.ssh|\.aws|\.gnupg|\.azure|auth\.json|settings\.local\.json|service[-_]?account.*\.json)$/i.test(name)) return true;
  return /^(\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key)|.*(?:api[-_]?key|token|password).*|id_(?:rsa|ed25519|ecdsa)(?:\..*)?)$/i.test(name);
}
/** Check names before any Git command that could read tracked contents. Never follow symlinks. */
export function checkNames(path: string, entries: typeof readdirSync = readdirSync): string[] {
  const blocked: string[] = [];
  const walk = (dir: string) => {
    for (const entry of entries(dir, { withFileTypes: true })) {
      if (entry.name === '.git') {
        if (dir !== path) blocked.push('Nested Git checkout is protected');
        continue;
      }
      if (suspectedSecret(entry.name)) { blocked.push('Suspected secret path; contents not accessed'); continue; }
      if (entry.isDirectory()) walk(resolve(dir, entry.name));
    }
  };
  walk(path);
  return blocked;
}
export interface PrEvidence { state: string; headRefOid: string; headRefName: string; url: string; mergedAt: string | null }
export function prEvidence(ticket: Ticket, repo: string): PrEvidence {
  if (!ticket.pr || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(ticket.pr.url)) throw new Error('No registered PR evidence');
  if (getGitHubRepository(repo) !== ticket.pr.repository || !ticket.pr.url.startsWith(`https://github.com/${ticket.pr.repository}/pull/`)) throw new Error('PR repository mismatch');
  const pr = JSON.parse(execGh(['pr', 'view', ticket.pr.url, '--json', 'url,state,headRefOid,headRefName,mergedAt'], { cwd: resolveGitDir(repo), timeout: 15000 }));
  if (pr.url !== ticket.pr.url || pr.headRefOid !== ticket.pr.head || pr.headRefName !== ticket.pr.branch) throw new Error('PR revision changed; fresh preservation evidence required');
  if (!['OPEN', 'MERGED', 'CLOSED'].includes(pr.state)) throw new Error('Unknown PR state');
  return pr;
}
export interface CleanupEvidence { safe: boolean; reasons: string[]; revision?: string; fingerprint?: string }
export function inspectCheckout(checkout: Checkout, ticket: Ticket, config: TaskRunnerConfig,
  deps = { prEvidence, checkoutActivity }): CleanupEvidence {
  const reasons: string[] = [];
  try {
    const project = config.projects[checkout.project];
    if (!project || resolve(project.repoPath) !== resolve(checkout.repoPath)) throw new Error('Project ownership changed');
    if (checkout.protected || checkout.phase !== 'present') throw new Error('Checkout is protected or not present');
    if (checkout.owner && alive(checkout.owner) !== false) throw new Error('Checkout has an active or unknown owner');
    reasons.push(...deps.checkoutActivity(checkout.path));
    if (reasons.length) return { safe: false, reasons };
    const entries = worktrees(checkout.repoPath);
    const entry = entries.find(w => w.path === checkout.path);
    if (!entry || entry.bare || entry.locked || entry.prunable || entry.branch !== checkout.branch) throw new Error('Git ownership/lock/branch evidence mismatch');
    const control = resolveGitDir(config.lifecycle.controlCheckout);
    if (realpathSync(checkout.path) !== checkout.path || checkout.path === realpathSync(resolveGitDir(project.repoPath)) || checkout.path === realpathSync(control)) throw new Error('Permanent or redirected checkout is protected');
    reasons.push(...checkNames(checkout.path));
    if (reasons.length) return { safe: false, reasons };
    if (execGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: checkout.path })) reasons.push('Modified or untracked output remains');
    const disposable = project.disposableFolders ?? (checkout.project === 'task-runner' ? ['node_modules'] : []);
    if (disposable.some(p => p !== 'node_modules' && (!p || p.includes('..') || p.startsWith('/') || p === '.git'))) throw new Error('Invalid disposable folder configuration');
    const ignored = execGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { cwd: checkout.path }).split('\0').filter(Boolean);
    if (ignored.some(path => !disposable.some(folder => path.startsWith(folder + '/')))) reasons.push('Unknown ignored output remains');
    if (reasons.length) return { safe: false, reasons };
    const head = execGit(['rev-parse', 'HEAD'], { cwd: checkout.path });
    if (head !== entry.head || head !== ticket.pr?.head || checkout.branch !== ticket.pr?.branch) throw new Error('Local revision does not match registered publication');
    const pr = deps.prEvidence(ticket, checkout.repoPath);
    if (pr.state !== 'MERGED') {
      const remote = execGit(['ls-remote', '--exit-code', 'origin', `refs/heads/${checkout.branch}`], { cwd: checkout.path }).split(/\s/)[0];
      if (remote !== head) throw new Error('Remote branch does not preserve the current revision');
    }
    return { safe: true, reasons: [], revision: head, fingerprint: createHash('sha256').update(JSON.stringify({ entry, head, pr, ignored })).digest('hex') };
  } catch (e: any) { return { safe: false, reasons: [e.message] }; }
}
export function cleanupCheckout(registry: Registry, id: string, config: TaskRunnerConfig, dryRun = false,
  inspect: typeof inspectCheckout = inspectCheckout,
  remove = (checkout: Checkout) => execGit(['worktree', 'remove', '--force', '--', checkout.path], { cwd: resolveGitDir(checkout.repoPath), timeout: 15000 })): CleanupEvidence {
  const initial = registry.read();
  const checkout = Object.hasOwn(initial.checkouts, id) ? initial.checkouts[id] : undefined;
  if (!checkout) return { safe: false, reasons: ['Checkout is not registered as runner-owned'] };
  const first = inspect(checkout, initial.tickets[checkout.ticket], config);
  if (!first.safe || dryRun) return first;
  // All runner ownership/admission changes serialize with this final safety check and removal.
  return registry.update(state => {
    const current = state.checkouts[id];
    if (!current || JSON.stringify(current) !== JSON.stringify(checkout)) return { safe: false, reasons: ['Ownership/activity changed during cleanup'] };
    const final = inspect(current, state.tickets[current.ticket], config);
    if (!final.safe || final.fingerprint !== first.fingerprint) return { safe: false, reasons: ['Cleanup evidence changed', ...final.reasons] };
    try {
      const ref = `refs/task-runner/recovery/${id}`;
      execGit(['update-ref', ref, final.revision!], { cwd: current.path });
      current.recoveryRef = ref;
      // Force is conditional on the complete gate above, including ignored-file allowlists.
      remove(current);
      if (existsSync(current.path) || worktrees(current.repoPath).some(w => w.path === current.path)) throw new Error('Removal could not be verified');
      current.phase = 'removed'; current.error = undefined;
      return final;
    } catch (e: any) {
      current.error = `Cleanup failed: ${e.message}`;
      return { safe: false, reasons: [current.error] };
    }
  });
}
