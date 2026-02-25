# task-runner

Linear-powered agent orchestration for Claude Code. Drop tickets into Linear, and task-runner pulls them, spins up Claude agents in isolated worktrees, creates PRs, runs automated reviews, and queues approved work for human merge.

## How it works

```
Linear ticket (agent-ready label, Todo state)
         │
         ▼
   ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
   │  task-runner │────▶│ Worker Agent  │────▶│ Review Agent  │
   │  drain/run   │     │ (worktree)   │     │ (read-only)  │
   └──────┬──────┘     └──────────────┘     └──────┬───────┘
          │                                         │
          │  runner pushes branch,          approved → label PR
          │  creates PR via gh              needs fix → new Linear ticket
          │                                         │
          ▼                                         ▼
   You review & merge                    Next drain picks up fix ticket
```

The runner handles all git operations (push, PR creation) — agents only commit locally. Workers get a scoped tool whitelist (read/write/test/commit), reviewers get read-only access.

## Setup

### Prerequisites

- Node.js 22+ (uses `--experimental-strip-types`)
- `claude` CLI installed
- `gh` CLI authenticated
- Linear API key

### Install

```bash
cd ~/coding/claude/task-runner/main
npm install
```

### Configure

Create `.env` with your Linear API key:

```bash
echo 'LINEAR_API_KEY=lin_api_...' > .env
```

Edit `task-runner.config.json` to map Linear projects to repos:

```json
{
  "projects": {
    "my-project": {
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

Project names must match Linear project names exactly. `prLabels` defaults to empty (no auto-labels). `reviewApprovedLabel` is optional.

## Usage

```bash
# Run a single issue through the full pipeline
task-runner run JOS-47
task-runner run JOS-47 --model opus --max-turns 40 --max-budget-usd 10

# Dry run — fetch and validate without spawning agents
task-runner run JOS-47 --dry-run

# Drain all agent-ready issues sequentially
task-runner drain
task-runner drain --project my-project --limit 5

# Review an existing PR standalone
task-runner review https://github.com/user/repo/pull/42

# Create a new Linear issue
task-runner add-ticket "Fix login bug" --team JOS
task-runner add-ticket "Add search" --team JOS --description "Full-text search" --priority 2

# Daily standup digest
task-runner standup
task-runner standup --days 7 --project my-project
```

All commands are run via:

```bash
node --experimental-strip-types src/cli.ts <command>
```

## Development

This repo uses a **bare repo + worktree** layout for branch isolation:

```
task-runner.git/    # Bare repository
task-runner/        # Hub directory (not a repo)
  main/             # main branch worktree (protected)
  <feature>/        # Feature worktrees (temporary)
```

```bash
# From the hub directory (task-runner/)
./create-worktree.sh feat-my-feature          # Create worktree + install deps
./remove-worktree.sh feat-my-feature          # Remove after merge
./check-worktrees.sh                          # Validate all worktrees
```

Direct commits to `main` are blocked by git hooks. Work on feature worktrees, then PR and merge via GitHub.

## Pipeline steps

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

## Agent permissions

**Worker** (implements code): Read, Write, Edit, Glob, Grep, git status/diff/log/add/commit, test/lint/build commands. No git push, no network access, no destructive commands.

**Reviewer** (reviews PRs): Read, Glob, Grep, gh pr diff/view, git diff/log/status, test/lint commands. No Write or Edit — cannot modify code.

## Design decisions

- **Runner pushes, not agents.** Agents commit locally; the runner handles `git push` and `gh pr create`. This prevents agents from pushing broken code.
- **Sequential processing.** The drain command processes one ticket at a time with a lock file to prevent concurrent runs.
- **No dependency resolution.** The runner trusts that `agent-ready` tickets are actually ready. Only label a ticket when its dependencies are satisfied.
- **Project-scoped config.** Each Linear project maps to a repo, so one Linear workspace can drive multiple repos.
