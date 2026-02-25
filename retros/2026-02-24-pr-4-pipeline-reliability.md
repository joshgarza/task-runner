# PR Review Retro: PR #4 — Fix pipeline reliability and cleanup

**Date**: 2026-02-24 | **Branch**: fix/pipeline-reliability | **Findings**: 2 bugs, 2 suggestions

## What Was Found

The pipeline's failure-path had two bugs: (1) a double-rollback that posted duplicate Linear comments when worktree creation failed, and (2) a dead truthiness guard on `reviewApprovedLabel` that could never be falsy because config.ts always defaulted it to a non-empty string. Two cleanup issues were also flagged: `fetchStaleIssues` was a full copy-paste of `fetchAgentReadyIssues`, and two local variables (`issueId`, `teamKey`) were assigned but never read.

## Root Cause

**Double rollback (why chain)**:
- *What*: `rollbackInProgress` was called explicitly on worktree-creation failure AND again in the `finally` block.
- *Why*: The fix moved rollback into the `finally` block but the worktree-creation `catch` returned early (before entering the try/finally), so the explicit call was also needed. The real fix was to remove the explicit call from the worktree catch path and let the `finally` block handle all rollback uniformly -- which works because the `return failure(...)` on worktree failure exits before the try/finally scope begins, so the finally handler only fires for failures that occur inside the try block.
- *Systemic cause*: Cleanup-on-failure was split between inline error handlers and a finally block without a clear ownership rule. When logic was added to the finally block, the inline handler was not removed, creating a double-fire.

**Dead guard (why chain)**:
- *What*: `if (config.github.reviewApprovedLabel)` was always truthy.
- *Why*: The config type was `string` (not `string | undefined`) and the default was `"ready-for-human-review"`.
- *Systemic cause*: Config defaults that fill in a non-empty string make optional-field truthiness guards dead code. TypeScript's type system can catch this, but only if `noUnusedLocals`/strict narrowing is enabled and the type accurately reflects optionality.

## Fixes Applied

- **Double rollback** (fixed by fix agent): Removed explicit `rollbackInProgress` call on worktree failure. The `finally` block handles rollback uniformly using the `transitionedToInProgress` flag and `pipelineSucceeded` flag.
- **Dead guard** (fixed by fix agent): Changed `GithubConfig.reviewApprovedLabel` type to `string | undefined` and config default to `undefined`. The truthiness guard now gates real optionality.
- **Unused variables** (fixed in this retro): Removed `issueId` and `teamKey` local variables from `run-issue.ts` -- the code always accesses `issue.id` and `issue.teamKey` directly.
- **Copy-paste duplicate** (fixed in this retro): Replaced `fetchStaleIssues` body with `export const fetchStaleIssues = fetchAgentReadyIssues` since the implementations were identical (callers differ only in which state name they pass).

## Deferred

None. All four findings were bounded, non-breaking fixes.

## Lessons Encoded

1. **Config optionality must match the type** -- When a config field is meant to be optional, its TypeScript type must include `undefined` and its default must be `undefined`. Defaulting to a non-empty string makes any truthiness guard on that field dead code. (Encoded: MEMORY.md)
2. **Single-owner cleanup pattern** -- Cleanup-on-failure should have exactly one owner (a `finally` block or a dedicated teardown function), not both. When adding cleanup to a `finally` block, grep for and remove any inline cleanup in the same scope. (Encoded: MEMORY.md)

## Hotspots

- `src/runner/run-issue.ts` -- 3 of 4 findings in this file. The pipeline orchestrator accumulates complexity because it handles fetch, worktree, agent, validation, push, PR, review, and rollback in a single function. Future work could extract a state machine or phase-runner to reduce the surface area for cleanup bugs.
