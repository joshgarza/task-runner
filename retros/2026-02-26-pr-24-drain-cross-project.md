# PR Review Retro: PR #24 — fix: drain always sweeps all projects regardless of cwd
**Date**: 2026-02-26 | **Branch**: fix/drain-cross-project-sweep | **Findings**: 1 bug (fixed)

## What Was Found

One finding: `createChildIssue` in `src/linear/mutations.ts` used `payload: any` instead of `LinearDocument.IssueCreateInput`. The sibling function `createIssue` in the same file (line 181) already used the correct type. The `any` annotation was inherited from the original function (pre-PR #16 cleanup) and survived because the PR #24 change added a `projectId` parameter without upgrading the type. The fix was clean: change the type annotation and inline the `projectId` conditional using a spread pattern consistent with the rest of the file.

## Root Cause

This is straightforward and does not warrant a deep why-chain. The function was written with `any` before the PR #16 type-safety cleanup, and PR #24 modified the function without upgrading the type to match its sibling. The project has no type-checking step (no tsconfig, no `tsc --noEmit`, no eslint), so the only defense against `any` regression is code review. The reviewer caught it.

**Structural observation:** The codebase has ~60 remaining `: any` annotations across 6 files (cli.ts, queries.ts, run-issue.ts, validate.ts, drain.ts, organize-tickets.ts), plus 6 `as any` casts in labels.ts. Most are `catch (err: any)` blocks (benign, since TypeScript's catch clause typing is limited) and `filter: any` objects in queries.ts (where the Linear SDK's filter types are complex generics). The highest-value targets for type upgrades are the `issue: any, projectConfig: any, config: any` parameters in `run-issue.ts:332-336` and `run-issue.ts:401-402`, which have proper types available (`LinearIssue`, `ProjectConfig`, `TaskRunnerConfig`).

## Fixes Applied

- **Fixed in PR (commit dddc320):** Changed `payload` type from `any` to `LinearDocument.IssueCreateInput` in `createChildIssue`. Inlined the `projectId` conditional using a spread pattern, consistent with sibling `createIssue` function. No remaining `any` types in `mutations.ts`.

## Deferred

- **Add tsconfig.json with `noImplicitAny`:** The structural fix for `any` regressions is compiler enforcement. However, with ~60 existing `any` annotations, enabling `noImplicitAny` requires a codebase-wide cleanup. Most are `catch (err: any)` (needs `unknown` + type narrowing) and `filter: any` in queries.ts (needs Linear SDK filter type imports). This is a medium-sized refactor. Revisit trigger: if another `any` regression appears in the next 3 PRs, create a dedicated ticket.
- **Type `runReview` and `rollbackInProgress` parameters in run-issue.ts:** Lines 332-336 and 401-402 use `any` for `issue`, `projectConfig`, and `config` parameters that have proper types (`LinearIssue`, `ProjectConfig`, `TaskRunnerConfig`). These are the highest-value type upgrades remaining. Revisit trigger: any PR that touches `run-issue.ts`.

## Lessons Encoded

### 1. Fix already applied in code (structural)

The `any` in `createChildIssue` was a one-off regression. The fix (use `LinearDocument.IssueCreateInput`) is the right pattern. No new lesson to encode beyond what's already captured: the mutations.ts hotspot note in MEMORY.md already documents the `as any` debt history.

### 2. No new MEMORY.md entry needed

The lesson "when modifying a function, upgrade its types to match sibling functions" is a general code hygiene practice, not a project-specific pattern worth encoding. The specific finding was caught and fixed. The broader `any` problem is a tooling gap (no type-checker), not a knowledge gap.

## Hotspots

- **`src/linear/mutations.ts`** -- 6th retro appearance (PR #3, #11, #12, #15/#17, #23, #24). The `as any` casts are now fully resolved. Label resolution uses the shared utility. States are paginated. The `payload: any` in `createChildIssue` was the last type-safety gap and is now fixed. Remaining debt is limited to the three `team.states()` calls sharing a pattern that could use a `resolveState()` utility. The file's retro frequency should decline now that its historical debt is cleared.
- **`src/runner/run-issue.ts`** -- 3rd retro appearance (PR #4, #22, #23), not directly involved in this PR's finding but carries the highest-value remaining `any` annotations (`issue: any`, `config: any` in helper function signatures at lines 332-336 and 401-402).
