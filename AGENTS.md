# TaskRunner Agent Guidance

See `CLAUDE.md` for repository workflow and architecture details.

## Code Review Rules

- Verify unattended routing fails closed. `execution:ops`, unknown execution routes, conflicting route labels, human-approval labels, and active blockers must stop before worktree creation or delegation.
- Verify successful local runs preserve the PR link and remote branch, request native Codex review, transition Linear to In Review, and leave merge or close reconciliation to `pr-health`.
- Verify git and GitHub commands pass arguments without shell interpolation, especially values originating in Linear issues or configuration.
