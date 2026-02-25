# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

task-runner is a Linear-powered agent orchestration tool for Claude Code. It pulls tickets from Linear, spins up Claude agents in isolated worktrees, creates PRs, runs automated code reviews, and queues approved work for human merge.

## Linear
- Team: `JOS`
- Project: `task-runner`

## Critical Rules

### Branch Protection
- **NEVER commit directly to `main`** — a pre-commit hook will reject it
- **NEVER create merge commits on `main`** — a pre-merge-commit hook will reject it
- These hooks protect against local mistakes. Merges to `main` happen via PR on GitHub
- If the Claude Code hook blocks your Edit/Write, you are on the `main` worktree — switch to a feature branch worktree

### Anti-Hallucination
- NEVER modify a pipeline step without reading its source file first
- NEVER assume config structure — check `src/types.ts` for `TaskRunnerConfig` and related types
- Verify `.env` and `task-runner.config.json` exist before debugging config issues

### Verification Required
- After modifying pipeline code, test with: `node --experimental-strip-types src/cli.ts run <issue-id> --dry-run`
- After modifying CLI commands, test with: `node --experimental-strip-types src/cli.ts --help`

## Tech Stack

- **Runtime**: Node.js 22+ (uses `--experimental-strip-types` — no build step)
- **Language**: TypeScript (run directly with `node --experimental-strip-types`)
- **Dependencies**: `@linear/sdk` (Linear API), `commander` (CLI framework)
- **External tools**: `claude` CLI (agent spawning), `gh` CLI (PR creation/review)

## Git Worktree Workflow

This repo uses a **bare repo + worktree** layout. Each branch has its own directory.

### Directory Structure
```
/home/josh/coding/claude/
  task-runner.git/          # Bare repository (do not work here directly)
    hooks/                  # Shared git hooks (pre-commit, pre-merge-commit)
  task-runner/              # Worktrees container (coordination hub)
    main/                   # main branch (protected, read-only for agents)
    <feature-worktrees>/    # Created per-task, deleted after merge
```

### How to Work
- **Start Claude from a worktree directory** (e.g. `task-runner/<feature>/`)
- Each worktree is a full working copy with its own `node_modules`, `.env`, and config
- All worktrees share the same git history via the bare repo
- Feature worktrees are **temporary** — create for active work, delete after merging

### Worktree Lifecycle

From the hub directory (`task-runner/`):

```bash
# Create a worktree (handles .env, config, npm install)
./create-worktree.sh <name> [branch-name]

# Remove a worktree and its branch (after merge)
./remove-worktree.sh <name>

# Validate all worktrees have required config
./check-worktrees.sh
```

### Merging to Main
1. Work and commit on a feature worktree
2. Rebase onto main: `git rebase main`
3. Push and open a PR:
   ```bash
   git push -u origin <branch>
   gh pr create
   ```
4. After PR is approved and merged on GitHub:
   ```bash
   cd /home/josh/coding/claude/task-runner/main && git pull origin main
   cd .. && ./remove-worktree.sh <name>
   ```

### Worktree Gotchas
- **Bare repo fetch refspec**: `git clone --bare` does not configure `remote.origin.fetch`. If `origin/main` is missing, run from the bare repo:
  ```bash
  git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
  git fetch origin
  ```
- **Feature branches need rebase**: After merging changes to `main`, feature branches must `git rebase main` to pick up shared files like `.claude/hooks/` and `.gitignore`
- **`npm install` is per-worktree**: Each worktree has its own `node_modules`. The `create-worktree.sh` script handles this automatically

## CLI Commands

All commands are run via:
```bash
node --experimental-strip-types src/cli.ts <command>
```

### `run <identifier>`
Run a single Linear issue through the full pipeline.
```bash
task-runner run JOS-47
task-runner run JOS-47 --model opus --max-turns 40 --max-budget-usd 10
task-runner run JOS-47 --dry-run    # Fetch and validate without spawning agents
```

### `drain`
Drain all agent-ready issues sequentially.
```bash
task-runner drain
task-runner drain --project my-project --limit 5
```

### `review <pr-url>`
Review an existing PR standalone.
```bash
task-runner review https://github.com/user/repo/pull/42
```

### `standup`
Daily standup digest from Linear activity.
```bash
task-runner standup
task-runner standup --days 7 --project my-project
```

### `add-ticket <title>`
Create a new Linear issue.
```bash
task-runner add-ticket "Fix login bug" --team JOS
task-runner add-ticket "Add search" --team JOS --description "Full-text search" --priority 2 --project my-project
```

## Architecture

### Pipeline Steps (run command)

1. **Fetch** issue from Linear (title, description, comments, project)
2. **Validate** issue is in Todo or Backlog state
3. **Transition** Linear → In Progress, add comment
4. **Create worktree** at `<repo>/.task-runner-worktrees/<issue-id>/`
5. **Spawn worker agent** with scoped tool whitelist
6. **Validate output** — commits exist, tests pass, lint clean
7. **Retry** if validation fails (up to `maxAttempts`)
8. **Push branch** and **create PR** (runner does this, not the agent)
9. **Spawn review agent** (read-only) to evaluate the PR
10. **Act on verdict** — label PR if approved, create fix ticket if not
11. **Clean up** worktree

### Source Layout

```
src/
  cli.ts              # Entry point — commander-based CLI
  config.ts           # Config and .env loading
  types.ts            # All TypeScript interfaces
  logger.ts           # Structured logging
  lock.ts             # File-based lock for drain
  runner/
    run-issue.ts      # Full pipeline for a single issue
    drain.ts          # Sequential issue processing
    review.ts         # Standalone PR review
    standup.ts        # Linear activity digest
    add-ticket.ts     # Linear issue creation
  agents/
    spawn.ts          # Claude CLI spawning with tool whitelists
    worker-prompt.ts  # System prompt for worker agents
    review-prompt.ts  # System prompt for review agents
  git/
    branch.ts         # Branch creation, push, PR creation
    worktree.ts       # Worktree create/remove for target repos
  linear/
    client.ts         # Linear SDK client
    queries.ts        # Linear read operations
    mutations.ts      # Linear write operations
  validation/
    validate.ts       # Output validation (commits, tests, lint)
```

### Agent Permissions

**Worker** (implements code): Read, Write, Edit, Glob, Grep, git status/diff/log/add/commit, test/lint/build commands. No git push, no network access, no destructive commands.

**Reviewer** (reviews PRs): Read, Glob, Grep, gh pr diff/view, git diff/log/status, test/lint commands. No Write or Edit — cannot modify code.

### Design Decisions
- **Runner pushes, not agents.** Agents commit locally; the runner handles `git push` and `gh pr create`. This prevents agents from pushing broken code.
- **Sequential processing.** The drain command processes one ticket at a time with a lock file to prevent concurrent runs.
- **No dependency resolution.** The runner trusts that `agent-ready` tickets are actually ready. Only label a ticket when its dependencies are satisfied.
- **Project-scoped config.** Each Linear project maps to a repo, so one Linear workspace can drive multiple repos.

## Config Format

`task-runner.config.json` (gitignored, copied per-worktree):

```json
{
  "projects": {
    "project-name": {
      "repoPath": "/home/josh/coding/claude/task-runner/main",
      "defaultBranch": "main",
      "testCommand": "npm test",
      "lintCommand": "npm run lint"
    }
  },
  "linear": {
    "agentLabel": "agent-ready",
    "inProgressState": "In Progress",
    "inReviewState": "In Review",
    "todoState": "Todo"
  },
  "defaults": {
    "model": "opus",
    "maxTurns": 50,
    "maxBudgetUsd": 10.00,
    "reviewModel": "opus",
    "reviewMaxTurns": 15,
    "reviewMaxBudgetUsd": 2.00,
    "maxAttempts": 2,
    "agentTimeoutMs": 900000
  },
  "github": {
    "prLabels": [],
    "reviewApprovedLabel": "ready-for-human-review"
  }
}
```

Project names must match Linear project names exactly. `prLabels` is an empty array by default (no auto-labels). `reviewApprovedLabel` is optional.
