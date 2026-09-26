import type { Command } from 'commander';
import { loadConfig } from '../config.ts';
import { checkLifecycle, registryFor } from '../lifecycle/service.ts';
import { evaluate } from '../lifecycle/model.ts';
import { authorize } from '../lifecycle/authorization.ts';
import type { Authorization } from '../lifecycle/authorization.ts';

export function registerLifecycleCommand(program: Command): void {
  const group = program.command('lifecycle').description('Runner-owned capacity, deadlines, disk safety, and recovery');
  group.command('status').description('Read durable lifecycle state without starting agents or cleanup').action(() => {
    const config = loadConfig(); const state = registryFor(config).read(); evaluate(state, config.lifecycle);
    console.log(JSON.stringify(state, null, 2));
  });
  for (const name of ['check', 'assess']) {
    group.command(name).description('Reconcile all projects, assess holds and independently verify cleanup candidates')
      .option('--dry-run', 'Read evidence without changing the registry, Linear, agents, or checkouts')
      .option('--retry-assessment', 'Explicitly retry an unchanged failed assessment')
      .action(async opts => { console.log(JSON.stringify(await checkLifecycle(loadConfig(), { dryRun: opts.dryRun, retryAssessment: opts.retryAssessment }), null, 2)); });
  }
  const actionCommand = (name: string) => group.command(`${name} <identifier>`)
    .requiredOption('--reason <reason>', 'Exact Josh-approved reason')
    .requiredOption('--authorization-comment <id>', 'Josh-authored Linear authorization matching this action');
  actionCommand('extend').requiredOption('--deadline <iso>', 'Explicit new deadline with timezone')
    .action(async (identifier, opts) => { await authorize(loadConfig(), opts.authorizationComment, { action: 'extend', identifier, reason: opts.reason, deadline: opts.deadline }); });
  actionCommand('disposition').requiredOption('--action <action>', 'defer, cancel, reprioritize, scope-change, or resume')
    .option('--priority <number>', 'Josh-approved local scheduling priority: 0 through 4', Number)
    .option('--scope <text>', 'Complete Josh-approved replacement worker scope')
    .action(async (identifier, opts) => {
      if (!['defer', 'cancel', 'reprioritize', 'scope-change', 'resume'].includes(opts.action)) throw new Error('Invalid disposition');
      const request: Authorization = { action: opts.action, identifier, reason: opts.reason };
      if (opts.priority !== undefined) request.priority = opts.priority;
      if (opts.scope !== undefined) request.scope = opts.scope;
      await authorize(loadConfig(), opts.authorizationComment, request);
    });
  actionCommand('adopt').requiredOption('--project <name>', 'Configured project')
    .requiredOption('--started-at <iso>', 'Original first execution time, never a restart time')
    .option('--path <path>', 'Optional existing checkout, left alone unless explicitly adopted')
    .action(async (identifier, opts) => {
      const request: Authorization = { action: 'adopt', identifier, reason: opts.reason, project: opts.project, startedAt: opts.startedAt };
      if (opts.path) request.path = opts.path;
      await authorize(loadConfig(), opts.authorizationComment, request);
    });
}
