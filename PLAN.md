# Codex Migration Plan

This plan reflects the current task-runner architecture, the dashboard Codex SDK reference, and the cron lessons captured in `FIX_CRON.md`.

## Goals

- Restore task-runner without any dependency on Claude Code.
- Keep the migration as close to 1:1 as possible at the pipeline level.
- Treat cron as part of production cutover, not a follow-up.

## Constraints

- `src/agents/spawn.ts` is the provider seam. Replace the agent engine there instead of rewriting the pipeline.
- `task-runner` must keep working from the `main` worktree because cron wrappers run from `/home/josh/coding/claude/task-runner/main`.
- Cron wrappers must keep explicit start and finish logging with captured exit codes.
- The active runtime must have the Codex SDK dependency installed in the exact worktree cron uses.
- Codex supports `model` and `modelReasoningEffort`, but it does not expose Claude-style `allowedTools`, `maxTurns`, or `maxBudgetUsd` in the same way.

## PR 1: Cron Hardening

Scope:

- Update `scripts/cron-drain.sh`.
- Update `scripts/cron-standup.sh`.
- Add this `PLAN.md`.

Changes:

- Replace the hardcoded Node version path with dynamic `nvm` sourcing.
- Keep the absolute `TASK_RUNNER_DIR` path.
- Keep repo-local `.env` sourcing in the wrapper.
- Keep the current start and finish log markers.
- Keep explicit exit-code capture.
- Set `HOME` defensively so future Codex-backed cron runs resolve `~/.codex` consistently.

Acceptance criteria:

- Manual execution of `scripts/cron-drain.sh` writes both start and finish markers.
- Manual execution of `scripts/cron-standup.sh` writes both start and finish markers.
- Existing CLI behavior is unchanged.

## PR 2: Codex Provider Swap

Scope:

- Add `@openai/codex-sdk`.
- Replace the Claude subprocess implementation in `src/agents/spawn.ts`.
- Update the runner call sites to await the new provider.
- Add model and reasoning-effort configuration.
- Remove Claude-specific output parsing and wording.

Changes:

- Implement the provider with lazy `import("@openai/codex-sdk")` to reduce startup fragility for `--help`, `standup`, and cron entrypoints.
- Map agent types to Codex sandbox modes:
  - `worker` -> `workspace-write`
  - `reviewer` -> `read-only`
  - `context` -> `read-only`
- Always set `approvalPolicy: "never"`.
- Always set `networkAccessEnabled: false`.
- Add reasoning-effort support to config and CLI.
- Preserve the current dispatch model and agent labels for the first migration pass.
- Use structured output schemas instead of Claude JSON wrapper parsing.
- Update docs and CLI descriptions so the project no longer claims to run on Claude Code.

Acceptance criteria:

- `node --experimental-strip-types src/cli.ts --help` works.
- `node --experimental-strip-types src/cli.ts run <ticket> --dry-run` works.
- A low-risk real `run` works end-to-end with Codex.
- Standalone `review` still returns a valid structured verdict.
- Manual execution of `scripts/cron-drain.sh` works from `main` after the dependency install and logs the active model and reasoning settings.

## Cutover Sequence

1. Merge PR 1.
2. Merge PR 2.
3. Run `npm install` in `/home/josh/coding/claude/task-runner/main`.
4. Run `scripts/cron-drain.sh` manually from the `main` worktree.
5. Re-enable or trust the scheduled drain only after the manual run succeeds.

## Out of Scope

- Redesigning agent types around Codex-native capability boundaries.
- Replacing the proposal and escalation system.
- Switching review over to `codex exec review`.
- Extracting a shared cron helper unless another wrapper is added.
