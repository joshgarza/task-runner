# Repository audit readiness

## Goal and boundaries

Understand the repositories under `/home/josh/coding` and
`/home/josh/coding/claude`, identify which deserve attention, and propose shared
development infrastructure from observed repetition, especially WSL and Docker.
TaskRunner prepares and executes bounded tickets to support that work.

Josh owns architectural decisions, repository priorities, and archival choices.
The implementation agent owns execution, validation, the PR review loop, merging
within approved scope, and ticket reconciliation. A reviewer finding that would
change architecture or approved scope goes back to Josh before implementation.

The initial audit does not move repositories, archive projects, restructure
Docker stacks, create GitHub repositories, or decide a monorepo layout. Those
are proposals for Josh after the inventory. Runtime inspection is read-only;
do not start or stop services merely to inventory them. Never access secrets.

## Current interface

Linear holds the work and dependencies. Skills wrap the TypeScript CLI.
`refine-tickets` enriches tickets and routes them; `organize-tickets` manages
readiness; `run` executes one ticket; scheduled `drain` consumes ready tickets.
Local work uses isolated Codex worktrees. Cloud work is explicitly delegated.
`execution:ops`, approval labels, and unresolved blockers stop unattended work.

`agent-ready` remains the local queue gate. The August delegation spike found
that assigning Codex as a delegate triggers cloud work, so it must not also be
used as a passive local queue marker. See JOS-280 in Linear.

TaskRunner requests native GitHub review and transitions work to In Review.
The coordinating implementation agent carries the review loop through merge.
There is no background review-fix/merge service. `pr-health` reconciles completed
or closed PRs when invoked; the existing drain cron does not invoke it.

## PR protocol

1. Confirm that existing affected work is committed and pushed. Preserve any
   untracked hub helpers before modifying them. Work in an isolated branch.
2. Implement the approved ticket and verify every acceptance criterion. Run the
   project's relevant tests and inspect the complete diff for unintended scope.
3. Push and create a PR. Record its URL on the Linear ticket and move to In Review.
4. Comment `@codex review`. Wait for the review to complete on the current PR
   commit, including security review when enabled. A running review, eyes
   reaction, timeout, or absence of comments is not a clean review.
5. Inspect all feedback. Fix real, relevant errors, explain unsupported findings
   with evidence, and ask Josh about architectural or scope changes. Push fixes,
   rerun relevant checks, and request review again. Repeat until no valid errors
   remain and the latest commit has an explicit clean result.
6. Confirm required checks and mergeability. Merge only the reviewed commit;
   if the head changes, repeat validation and review. The implementation agent
   performs this merge without asking Josh to repeat prior authorization.
7. Synchronize local main. Reconcile Linear with `pr-health` for runner-created
   PRs. For manually coordinated PRs, verify the merge and update the linked
   ticket directly. Remove only verified disposable worktrees and merged refs.

If review is unavailable or credentials are missing, keep the PR/ticket open
and report the precise blocked step. Never equate passing tests with completed
scope or a completed review.

## Initial inventory output

Create bounded audit tickets per repository or closely related repository
group. Keep reports in versioned Markdown on a PR. Each report should record:

- Repository name, paths, GitHub remote, main branch, and commit inspected.
- Purpose, maturity, recent activity, and evidence of use or traction.
- Language/runtime, dependencies, startup and validation commands.
- Worktree layout and outstanding work, without deleting or overwriting it.
- Docker services, ports, volumes, shared data, scheduled jobs, and observed
  running/stopped state. Record observation time and distinguish configuration
  from confirmed operation.
- Repeated setup and dependencies on other projects, with concrete candidates
  for shared tooling.
- Known gaps, evidence limits, and decisions needed from Josh. Recommendations
  to focus, maintain, pause, or archive are proposals, never automatic actions.

Read-only inspection may run concurrently when repositories are independent.
Record blockers and overlapping files before parallel implementation. The
report writer can commit audit documents, but should not mutate the systems
being audited or execute unknown project scripts just to inspect them.

## Acceptance and follow-up

JOS-287 covers inherited credentials. JOS-286 covers safe helper cleanup and
deployment. JOS-288 covers executable project initialization tests. JOS-290
tracks overall readiness and a live ticket-to-PR-to-merge acceptance run.

Commands use inherited `LINEAR_API_KEY`. The connected Linear app does not
automatically export a credential to CLI processes. If absent, ask the operator
to configure the launch environment, never source `.env` from an agent.
Existing cron wrappers intentionally load their own environment for human-
configured unattended operation; agents must not invoke those wrappers.

### Subscription runtime deployment

The worker uses the CLI bundled with `@openai/codex-sdk`, not a global `codex`
installation. JOS-293 updates that dependency to the 0.154 release line and the
worker default to `gpt-5.6-terra` with `high` reasoning. Context gathering keeps
its `medium` effort. Authentication and network/sandbox restrictions are unchanged.
Explicit model selections remain explicit; a source-code default does not
override an old model pinned in local configuration.

After merging a runtime upgrade, run `npm ci --ignore-scripts --no-audit --no-fund`
in the launch worktree. Preserve the non-secret `task-runner.config.json` on
GitHub before changing its live settings. For this deployment, set only:

- `defaults.model`: `gpt-5.6-terra`
- `defaults.reasoningEffort`: `high`
- `projects.task-runner.testCommand`: `npm test`

Leave other projects' commands and unrelated configuration intact. Verify the
bundled CLI version and effective config, then requeue JOS-291 for the scheduled
acceptance run. The live run, not just a successful SDK import, must prove that
the selected model works with the signed-in account and the real tests execute.

See the official [Codex models](https://learn.chatgpt.com/docs/models) and
[SDK documentation](https://learn.chatgpt.com/docs/codex-sdk) for compatibility.

### Native execution-permission review

JOS-294 routes eligible worker escalation requests through Codex's native
automatic reviewer: `approval_policy = "on-request"` and
`approvals_reviewer = "auto_review"`. The SDK passes these settings per
invocation, without editing machine-local Codex configuration. Workers remain
`workspace-write` with network access disabled; context gathering stays
`read-only` with approval policy `never`. Authentication, model selection,
routing gates, and commit ownership do not change.

This reviewer handles execution permissions, including sandbox-blocked Git
metadata and test commands. It is separate from `@codex review` on GitHub and
does not grant blanket access. Do not override reviewer policy, work around a
denial, or switch to Full Access when a request fails. See the official
[Auto-review documentation](https://learn.chatgpt.com/docs/sandboxing/auto-review).

Publication requires a successful worker turn and validation of clean committed
output. Failed runs retain the worktree and local branch, log the recovery path,
and attempt to record it in Linear before rollback. An existing worktree blocks
new runs instead of being deleted. Triage and preserve its output before moving
or removing it and requeueing the ticket. This is local recovery, not an automatic
backup or permission to publish partial work. Successful PR runs still clean up
their local worktree and keep the remote PR branch.
Retained failures are removed from the configured ready queue before returning
to Todo. If removal cannot be verified, leave the ticket In Progress so the next
drain cannot select it. A custom `drain --label` is passed through to this gate;
both the active and default queue labels are cleared if present. Requeue only
after the retained worktree has been triaged.

Runtime errors and timeouts stop for triage instead of opening a fresh agent turn
that could reset a native approval interruption. Completed turns whose output
fails validation still use the configured retry limit.
Workers return a schema-constrained completion report. A blocked report, including
a normally exited turn that reports a permission denial, or an invalid report
stops before validation and cannot be retried automatically. Validation-time HEAD
changes are also terminal, so a later attempt cannot accept a commit created by
a test, lint, or build command as the new baseline.

The SDK/CLI 0.154.0 configuration was exercised in a disposable worktree using
Terra/high on 2026-09-24: a sandbox-blocked child-process test passed after native
permission review and the worker created its own commit. The real scheduled
JOS-291 ticket-to-PR-to-reviewed-merge run remains the deployment acceptance gate.

Future visual design work is tracked in JOS-289. It will use Ladle first, with
a tool-independent contract for previews, design states, evidence, and approval.
The architecture proposal goes to Josh before building that integration.
