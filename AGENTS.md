# TaskRunner Agent Guidance

See `CLAUDE.md` for repository workflow and architecture details.

## Ownership and completion

Josh owns architecture, repository prioritization, and archival decisions.
The coordinating implementation agent owns the PR lifecycle: implement, test,
publish, request `@codex review`, address real findings, and repeat review until
the latest commit is clean. Merge only after that review and required checks
complete, then reconcile Linear. Do not wait for Josh to perform routine merges
within already approved scope. See `docs/repository-audit.md` for the protocol
and audit boundaries.

## Code Review Rules

- Verify unattended routing fails closed. `execution:ops`, unknown execution routes, conflicting route labels, human-approval labels, and active blockers must stop before worktree creation or delegation.
- Verify successful local runs preserve the PR link and remote branch, request native Codex review, transition Linear to In Review, and leave merge or close reconciliation to `pr-health`.
- Keep execution-permission review separate from PR code review. Workers use native `auto_review` with `on-request`; context gathering stays `read-only`/`never`. Never replace this with Full Access or custom approval bypasses.
- Reject publication without successful validation of clean committed output. Failed runs retain their worktree and branch for triage; never silently overwrite that output on a later run.
- Verify git and GitHub commands pass arguments without shell interpolation, especially values originating in Linear issues or configuration.
