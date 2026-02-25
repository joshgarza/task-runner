# PR Review Retro: PR #11 — JOS-71: Add edit-ticket CLI command
**Date**: 2026-02-24 | **Branch**: task-runner/jos-71 | **Findings**: 1 perf

## What Was Found

One performance issue: `updateIssue` in `src/linear/mutations.ts` unconditionally fetches the team from the Linear API on every call, even when only updating simple fields (title, description, priority) that do not require team resolution. The team object is only needed to resolve `labelNames` (via `team.labels()`) and `stateName` (via `team.states()`). For the common case of updating title or priority, this is a wasted API call adding 100-300ms latency.

Two recurring patterns from PR #3 were also copied into the new code: the `as any` cast on the update payload, and the "Comma-separated labels" description on a Commander variadic `<labels...>` option.

## Root Cause

**Technical why chain (perf):**
1. `updateIssue` always fetches the team.
2. Because the function was modeled after `createIssue`, which always fetches the team.
3. But `createIssue` legitimately needs `teamId` for the create payload -- `updateIssue` does not.
4. The developer followed the existing pattern without noticing the structural difference: create needs the team unconditionally, update needs it conditionally.

**Origin why chain (recurring patterns):**
1. The `as any` cast and labels description mismatch were copied from `add-ticket`.
2. Both were flagged in the PR #3 retro as deferred suggestions.
3. They were deferred (not fixed) because neither is a runtime bug.
4. Without a fix in the source, the pattern propagates via copy-paste to new commands.
5. Systemic cause: deferred suggestions that live only in retro files have no mechanism to interrupt copy-paste. They would need to be either fixed in the source or flagged in CLAUDE.md as known issues to avoid copying.

## Fixes Applied

- None. The perf finding is a valid optimization but not a bug or security issue. The review correctly classified it as approved with a suggestion. The fix agent correctly declined to make changes since no critical fixes were needed.

## Deferred

- **Team fetch optimization**: Defer the `client.teams()` call in `updateIssue` to only fire when `labelNames` or `stateName` are provided. Bounded fix, but the PR is approved and the latency impact is minor for a CLI tool. Revisit trigger: if `updateIssue` is called in a hot path (e.g., batch updates) or if a follow-up PR touches `mutations.ts`.
- **`as any` cast (recurring)**: Second appearance (PR #3, PR #11). The `@linear/sdk` exports `IssueUpdateInput` which could replace `Record<string, unknown>`. Revisit trigger: third occurrence or any PR that refactors `mutations.ts`.
- **Labels description mismatch (recurring)**: Second appearance (PR #3, PR #11). Commander variadic `<labels...>` is space-separated, not comma-separated. Should be fixed across both `add-ticket` and `edit-ticket` together. Revisit trigger: next PR touching CLI option descriptions.

## Lessons Encoded

1. **Copy-paste from existing code propagates deferred issues** -- When a new function is modeled after an existing one, any unfixed suggestions in the source get copied to the new code. Deferred suggestions that are likely to be copied should either be fixed promptly or documented in CLAUDE.md as known patterns to avoid. (Not encoded to MEMORY.md -- this is a project-management observation, not a technical pattern.)

2. **Create vs. update have different data dependencies** -- A create operation typically needs a parent entity (team, project) unconditionally because it must associate the new record. An update operation only needs the parent entity when resolving name-to-ID fields. When copying a create function to make an update function, audit which data fetches are still required. (Not encoded -- too specific to be a general heuristic.)

## Hotspots

- `src/linear/mutations.ts` -- 2nd retro appearance (PR #3: `as any` cast; PR #11: eager team fetch + `as any` cast again). Approaching the 3-retro structural hotspot threshold. The file accumulates both type-safety and performance debt as new mutation functions are added by copying existing ones.
- `src/cli.ts` -- 2nd retro appearance (PR #3: NaN priority, labels mismatch; PR #11: labels mismatch copied). Same copy-paste propagation pattern.
