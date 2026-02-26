# PR Review Retro: PRs #15, #16, #17 — JOS-75, JOS-74, JOS-73 (batch review)
**Date**: 2026-02-25 | **Branches**: task-runner/jos-75, task-runner/jos-74, task-runner/jos-73 | **Findings**: 2 bugs (cross-PR), 2 suggestions

## What Was Found

These three PRs address deferred items from prior retros (unpaginated labels, `as any` casts, label description mismatch, missing `--project` enforcement). Individually each PR is well-scoped. The primary findings are **cross-PR semantic conflicts** that will cause one PR to silently undo the other's intentional behavior change after merge.

1. **[bug] PR #15 and #17 conflict on missing-label behavior** (src/linear/mutations.ts)
   - PR #15 intentionally changes `createIssue` to *throw* on missing labels (the whole point of JOS-75). PR #17 replaces the same label-resolution code with `resolveLabels()`, which *warns and skips*. Whichever merges second will silently revert the other's behavior. Neither PR is wrong in isolation -- they just disagree on error policy.

2. **[bug] PR #15 error message references unpaginated `teamLabels.nodes`** (src/linear/mutations.ts:192)
   - The throw in PR #15 uses `teamLabels.nodes.map(l => l.name)` to list available labels, but `teamLabels` comes from the unpaginated `team.labels()` call that PR #17 removes. If #15 merges first, the "Available:" list in the error message is truncated to the first page. If #17 merges first, this code is gone. Either way the line is short-lived, but it demonstrates how touching the same code without coordination creates transient bugs.

3. **[suggestion] PR #17 introduces `(label as any)` casts in new `labels.ts`** (src/linear/labels.ts:42-53)
   - `collectAllNodes<T>` correctly infers `T` as `IssueLabel` when called on `team.labels()`. `IssueLabel` has typed `.name: string` and `.id: string` properties. The `as any` casts are unnecessary and counteract the type-safety improvements PR #16 makes in the same file (`mutations.ts`).

4. **[suggestion] PR #17 `resolveTeamLabels()` re-fetches team by key** (src/linear/labels.ts:27-30)
   - Every caller of `resolveLabels(teamKey, ...)` in `mutations.ts` has already fetched the team to get `team.id` for the create/update payload. The shared utility re-fetches it. This doubles the Linear API call for every label-resolving mutation.

## Root Cause

### Why chain: Cross-PR semantic conflict (#15 vs #17)

**Technical:**
1. PR #15 changes `createIssue`'s missing-label handling from warn-and-skip to throw-on-error.
2. PR #17 extracts label resolution into `resolveLabels()`, which uses warn-and-skip (the behavior that existed on main when the branch was cut).
3. Both PRs branched from the same `main` commit and modified the same lines in `mutations.ts`.
4. Neither PR author knew the other PR existed, because the tickets (JOS-73, JOS-75) were independent Linear issues with no blocking relationship.
5. Systemic cause: **shared utility extraction and behavior-change PRs are inherently conflicting when they touch the same code path, and the conflict is semantic (not textual) so git merge won't detect it.**

**Origin:**
1. JOS-73 (extract `resolveLabels`) and JOS-75 (throw on missing label) were filed as separate tickets from the same retro (PR #12).
2. The retro identified two problems in the same code: (a) labels aren't paginated, (b) missing labels are silently skipped.
3. Two separate tickets means two separate PRs means two separate branches. Each PR "fixes" the label-resolution code but with different policies.
4. Design assumption: **retro-derived tickets are independent.** In reality, when two tickets modify the same function, they need a dependency relationship (one blocks the other) or must be combined into a single PR.

## Fixes Applied

None. All findings are in PR branch code, not on main. Coordination guidance is encoded below.

## Deferred

- **Cross-PR conflict resolution**: The recommended merge strategy is:
  1. Merge PR #17 first (extracts `resolveLabels()` -- the larger structural change).
  2. Rebase PR #15 onto the new main.
  3. In PR #15, modify `resolveLabels()` to accept a `{ strict?: boolean }` option. When `strict: true`, throw on missing labels instead of warning. Have `createIssue` pass `{ strict: true }`.
  4. This preserves both PR #17's shared utility and PR #15's intentional throw behavior.
  Revisit trigger: immediately, before merging either PR.

- **`(label as any)` casts in labels.ts**: Drop the `as any` -- `IssueLabel` is correctly typed. The `collectAllNodes` return type already infers `IssueLabel[]`. Can be addressed in the rebase of PR #17 or as a follow-up.

- **`resolveTeamLabels()` redundant team fetch**: Accept a `team` parameter as an alternative to `teamKey` to avoid the re-fetch. Low urgency -- the extra API call adds ~100ms and only fires during label-resolving mutations.

- **`collectAllNodes` verbose inline type**: Extract `PaginatedConnection<T>` type alias. Can be done in the rebase or as a follow-up.

## Lessons Encoded

### 1. Retro-derived tickets that modify the same function need dependency links (MEMORY.md)

When a single retro identifies multiple problems in the same function, the resulting tickets are not independent -- they will produce conflicting PRs. Either combine them into one ticket, or create an explicit `blocks` relationship so they merge sequentially with rebase between. (Evidence: PRs #15 and #17 both fix label handling in `createIssue` with incompatible error policies because JOS-73 and JOS-75 had no dependency link.)

### 2. Shared utility extraction must preserve caller-specific error policies (observation)

When extracting duplicated code into a shared utility (`resolveLabels`), the utility must support the strictest error policy any caller needs. If one caller throws on failure and another warns-and-skips, the utility needs a `strict` mode -- not a one-size-fits-all default. Hardcoding warn-and-skip in the shared utility silently downgrades callers that previously threw.

### 3. Structural hotspot update (observation)

`src/linear/mutations.ts` is now at 5 retro appearances (PR #3, #11, #12, #13, this batch). PRs #16 and #17 are actively resolving the accumulated debt (`as any` casts, unpaginated labels). After both merge, the hotspot should be downgraded if no new patterns emerge. The new `src/linear/labels.ts` should be monitored as a potential successor hotspot since it centralizes label resolution.

## Hotspots

- **`src/linear/mutations.ts`** -- 5th retro appearance (PR #3, #11, #12, #13, #15/#16/#17). Three concurrent PRs modify the same label-resolution code. PRs #16 and #17 are actively cleaning up the `as any` and unpaginated-labels debt. After merge, reassess.
- **`src/cli.ts`** -- 5th retro appearance (PR #3, #11, #12, #13, #16). PR #16 fixes the "Comma-separated" description mismatch. After merge, the remaining debt is the unguarded `parseInt` on `run`/`drain`/`standup` commands.
- **`src/linear/labels.ts`** -- New file (PR #17). Centralizes label resolution but introduces `as any` casts and a redundant team re-fetch. Monitor for becoming the next hotspot as more callers adopt it.
