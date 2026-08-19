# task-runner

Linear-powered Codex routing. Drop tickets into Linear, and task-runner sends normal work to local Codex in an isolated worktree, delegates optional cloud work through Codex for Linear, and keeps operations work human-gated.

## How it works

```
Linear ticket (agent-ready label, Todo state)
         |
         +-- local --> worktree --> validate/retry --> PR --> @codex review
         |
         +-- cloud --> @Codex in Linear --> Codex cloud chat
         |
         +-- ops ----> stop for human approval
```

The runner handles local git operations, validation, retries, PR creation, and Linear reconciliation. Local implementation runs use a Codex `workspace-write` sandbox. Context runs use a read-only sandbox.

## Execution routing

- No execution label or `execution:local`: run unattended through local Codex. Unlabeled tickets default to local for compatibility.
- `execution:cloud`: mention `@Codex` in Linear to start a native Codex cloud chat for the repository.
- `execution:ops`: never run unattended. TaskRunner fails closed and leaves the ticket for a human.

Unknown or conflicting `execution:*` labels also fail closed.

## Setup

### Prerequisites

- Node.js 22+ (uses `--experimental-strip-types`)
- Codex auth configured on this machine, for example via `~/.codex`
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
    "model": "gpt-5.4",
    "reasoningEffort": "high",
    "contextModel": "gpt-5.4",
    "contextReasoningEffort": "medium",
    "maxAttempts": 2,
    "agentTimeoutMs": 900000
  },
  "github": {
    "prLabels": []
  }
}
```

Project names must match Linear project names exactly. `prLabels` defaults to empty, with no automatic labels.

## Usage

```bash
# Run a single issue through the full pipeline
task-runner run JOS-47
task-runner run JOS-47 --model gpt-5.4 --reasoning-effort high

# Dry run, fetch and resolve routing without executing work
task-runner run JOS-47 --dry-run

# Drain all agent-ready issues sequentially
task-runner drain
task-runner drain --project my-project --limit 5

# Request a native Codex review on an existing PR
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

1. **Fetch** the Linear issue and resolve its execution route.
2. **Validate** state, approval requirements, project configuration, and blockers.
3. **Delegate cloud**, reject ops, or continue with local execution.
4. **Create a worktree** and run local Codex with workspace-write access.
5. **Validate and retry** until checks pass or `maxAttempts` is exhausted.
6. **Push the branch** and create a GitHub pull request.
7. **Request native review** by commenting `@codex review` on the PR.
8. **Transition to In Review** and let `pr-health` reconcile merge or close state back to Linear.
9. **Clean up** the local worktree.

## Execution permissions

**Local**: Codex `workspace-write` sandbox. Prompted to keep changes focused, commit locally, avoid network access, and leave push/PR creation to the runner.

**Cloud**: Native Codex for Linear delegation. Codex cloud selects the configured environment and posts progress back to Linear.

**Ops**: Human-gated and never run unattended.

## Design decisions

- **Runner pushes, not agents.** Agents commit locally; the runner handles `git push` and `gh pr create`. This prevents agents from pushing broken code.
- **Bounded concurrency.** Drain uses the configured concurrency limit and a lock file prevents overlapping drain invocations.
- **Dependency safety.** Organize strips `agent-ready` from blocked tickets, and run checks active blockers again before committing resources.
- **GitHub-native review.** Codex review feedback stays in GitHub. TaskRunner only requests review and reconciles PR merge or close state with Linear.
- **Project-scoped config.** Each Linear project maps to a repo, so one Linear workspace can drive multiple repos.
