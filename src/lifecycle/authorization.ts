import { getLinearClient } from '../linear/client.ts';
import { registryFor } from './service.ts';
import { evaluate } from './model.ts';
import { worktrees } from './cleanup.ts';
import { checkoutActivity } from './processes.ts';
import { resolveGitDir } from '../git/worktree.ts';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TaskRunnerConfig } from '../types.ts';

export interface Authorization {
  action: 'extend' | 'defer' | 'cancel' | 'reprioritize' | 'scope-change' | 'resume' | 'adopt';
  identifier: string; reason: string; deadline?: string; project?: string;
  startedAt?: string; path?: string; priority?: number; scope?: string;
}
export const authorizationPrefix = 'TaskRunner lifecycle authorization\n';
function canonical(value: object): string { return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))); }
export function validateAuthorization(config: TaskRunnerConfig, request: Authorization, comment: { authorId?: string; identifier?: string; body: string }): void {
  if (!config.lifecycle.joshUserId || comment.authorId !== config.lifecycle.joshUserId || comment.identifier !== request.identifier || !comment.body.startsWith(authorizationPrefix)) throw new Error('Authorization must be a Josh-authored comment on this ticket');
  const approved = JSON.parse(comment.body.slice(authorizationPrefix.length));
  if (canonical(approved) !== canonical(request)) throw new Error('Requested action does not exactly match Josh authorization');
  if (!request.reason?.trim()) throw new Error('An explicit reason is required');
  for (const date of [request.deadline, request.startedAt].filter(Boolean)) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(date!) || !Number.isFinite(Date.parse(date!))) throw new Error('Use an explicit ISO timestamp with timezone');
  }
  if (request.action === 'reprioritize' && (!Number.isInteger(request.priority) || request.priority! < 0 || request.priority! > 4)) throw new Error('Reprioritization requires priority 0 through 4');
  if (request.action === 'scope-change' && !request.scope?.trim()) throw new Error('Scope change requires the complete approved scope');
}
export async function verifyAuthorization(config: TaskRunnerConfig, commentId: string, request: Authorization): Promise<string> {
  if (!config.lifecycle.joshUserId) throw new Error('Configure lifecycle.joshUserId before Josh-authorized actions');
  if (!request.reason?.trim()) throw new Error('An explicit reason is required');
  const comment = await getLinearClient().comment(commentId);
  const author = await comment.user;
  const issue = await comment.issue;
  validateAuthorization(config, request, { authorId: author?.id, identifier: issue?.identifier, body: comment.body });
  return comment.id;
}
export async function authorize(config: TaskRunnerConfig, commentId: string, request: Authorization,
  verify = verifyAuthorization): Promise<void> {
  const proof = await verify(config, commentId, request);
  const registry = registryFor(config);
  registry.update(state => {
    if (state.authorizations[proof]) throw new Error('Authorization already consumed');
    let ticket = state.tickets[request.identifier];
    if (request.action === 'adopt') {
      if (!request.project || !config.projects[request.project] || !request.startedAt || !Number.isFinite(Date.parse(request.startedAt)) || Date.parse(request.startedAt) > Date.now()) throw new Error('Adoption needs configured project and original start time');
      if (ticket) throw new Error('Ticket already registered');
      const startedAt = Date.parse(request.startedAt);
      ticket = { identifier: request.identifier, issueId: request.identifier, teamKey: request.identifier.split('-')[0],
        project: request.project, startedAt, deadline: startedAt + config.lifecycle.timeboxHours * 3600_000, queueLabel: config.linear.agentLabel };
      if (request.path) {
        const path = realpathSync(request.path);
        const project = config.projects[request.project];
        if (path === realpathSync(resolveGitDir(project.repoPath)) || path === realpathSync(resolveGitDir(config.lifecycle.controlCheckout))) throw new Error('Permanent checkout cannot be adopted');
        if (Object.values(state.checkouts).some(c => c.path === path && c.phase !== 'removed')) throw new Error('Checkout already registered');
        const entry = worktrees(project.repoPath).find(w => w.path === path);
        if (!entry || entry.bare || entry.locked || entry.prunable || !entry.branch || checkoutActivity(path).length) throw new Error('Adoption requires an inactive, unlocked Git checkout');
        const id = randomUUID();
        state.checkouts[id] = { id, ticket: request.identifier, project: request.project, repoPath: resolve(project.repoPath),
          path, branch: entry.branch, phase: 'present', protected: false, revision: entry.head };
      }
      state.tickets[request.identifier] = ticket;
    } else {
      if (!ticket || ticket.resolution) throw new Error('No unfinished registered ticket');
      if (request.action !== 'extend' && Object.values(state.checkouts).some(c => c.ticket === ticket.identifier && (c.owner || c.cleanup))) throw new Error('Stop active execution or cleanup before changing disposition');
      if (request.action === 'extend') {
        const deadline = Date.parse(request.deadline ?? '');
        if (!Number.isFinite(deadline) || deadline <= ticket.deadline || deadline <= Date.now()) throw new Error('Extension requires an explicit later future deadline');
        ticket.deadline = deadline;
      } else if (request.action === 'cancel') {
        if (Object.values(state.checkouts).some(c => c.ticket === ticket.identifier && c.owner)) throw new Error('Stop active execution before cancellation');
        ticket.resolution = { at: Date.now(), kind: 'cancelled', evidence: `${proof}: ${request.reason}` };
      } else if (request.action === 'resume') {
        ticket.disposition = undefined;
      } else ticket.disposition = { kind: request.action === 'defer' ? 'deferred' : request.action === 'reprioritize' ? 'reprioritized' : 'scope-change', reason: request.reason, authorization: proof };
    }
    if (request.action === 'reprioritize') ticket.priority = request.priority;
    if (request.action === 'scope-change') ticket.scope = request.scope;
    state.authorizations[proof] = canonical({ ...request, at: new Date().toISOString() });
    evaluate(state, config.lifecycle);
  });
}
