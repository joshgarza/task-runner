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
Drain all agent-ready issues with configurable concurrency.
```bash
task-runner drain
task-runner drain --project my-project --limit 5 --concurrency 3
task-runner drain --dry-run    # List agent-ready issues without processing
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

### `edit-ticket <identifier>`
Update an existing Linear issue.
```bash
task-runner edit-ticket JOS-47 --status "In Progress"
task-runner edit-ticket JOS-47 --add-labels agent-ready --comment "Ready for agent processing"
task-runner edit-ticket JOS-47 --title "New title" --priority 2 --assignee user@example.com
```

### `list-tickets`
List Linear issues with filtering.
```bash
task-runner list-tickets --team JOS
task-runner list-tickets --team JOS --status Todo Backlog --project my-project --labels agent-ready
task-runner list-tickets --team JOS --comments    # Include comment bodies
```

### `organize-tickets`
Triage Linear tickets: detect blocked/unblocked issues, apply labels, optionally gather codebase context via LLM.
```bash
task-runner organize-tickets --team JOS --project my-project
task-runner organize-tickets --team JOS --context --dry-run
```

### `list-agents`
Show all registered agent types from the RBAC registry.
```bash
task-runner list-agents
task-runner list-agents --verbose    # Show full tool lists
```

### `pending-proposals`
List agent type proposals awaiting human approval.
```bash
task-runner pending-proposals
task-runner pending-proposals --all    # Include resolved proposals
```

### `approve-agent <id>`
Approve or reject an agent type proposal.
```bash
task-runner approve-agent <proposal-id>
task-runner approve-agent <proposal-id> --reject --reason "Too broad tool access"
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
  concurrency.ts      # Shared runWithConcurrency helper
  runner/
    run-issue.ts      # Full pipeline for a single issue
    drain.ts          # Concurrent issue processing
    review.ts         # Standalone PR review
    standup.ts        # Linear activity digest
    add-ticket.ts     # Linear issue creation
    edit-ticket.ts    # Linear issue updates + comments
    list-tickets.ts   # Linear issue listing with filters
    organize-tickets.ts # Triage: label blocked/unblocked, gather context
  agents/
    spawn.ts          # Claude CLI spawning with tool whitelists
    registry.ts       # RBAC agent type registry (load, resolve, validate)
    dispatcher.ts     # Dispatches issues to agents by type
    failure-analysis.ts # Analyzes agent failures, proposes new types
    proposals.ts      # Agent type proposal CRUD (approve/reject)
    worker-prompt.ts  # System prompt for worker agents
    review-prompt.ts  # System prompt for review agents
    context-prompt.ts # System prompt for context-gathering agents
    agent-registry.json   # Agent type definitions
    worker-tools.json     # Tool whitelist for worker agents
    review-tools.json     # Tool whitelist for review agents
    context-tools.json    # Tool whitelist for context agents
  git/
    branch.ts         # Branch creation, push, PR creation
    worktree.ts       # Worktree create/remove for target repos
  linear/
    client.ts         # Linear SDK client
    queries.ts        # Linear read operations
    mutations.ts      # Linear write operations
    labels.ts         # Label resolution (team + workspace)
  validation/
    validate.ts       # Output validation (commits, tests, lint)
```

### Agent Permissions

**Worker** (implements code): Read, Write, Edit, Glob, Grep, git status/diff/log/add/commit, test/lint/build commands. No git push, no network access, no destructive commands.

**Reviewer** (reviews PRs): Read, Glob, Grep, gh pr diff/view, git diff/log/status, test/lint commands. No Write or Edit — cannot modify code.

### Design Decisions
- **Runner pushes, not agents.** Agents commit locally; the runner handles `git push` and `gh pr create`. This prevents agents from pushing broken code.
- **Concurrent drain with lock.** The drain command runs multiple agents in parallel (configurable `--concurrency`). A lock file prevents overlapping drain invocations.
- **Dependency-aware prioritization.** `organize-tickets` detects blocked issues via Linear relations and strips `agent-ready` labels from blocked tickets. Drain processes unblocked issues first.
- **RBAC agent registry.** Agent types are defined in `agent-registry.json` with scoped tool whitelists. The dispatcher selects agent types per-issue. New types are proposed by failure analysis and require human approval.
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
      "lintCommand": "npm run lint",
      "team": "JOS"
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

Project names must match Linear project names exactly. `team` is optional — when set, `--team` is auto-detected from cwd. `prLabels` is an empty array by default (no auto-labels). `reviewApprovedLabel` is optional.
