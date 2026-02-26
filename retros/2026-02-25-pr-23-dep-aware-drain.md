# PR Review Retro: PR #23 — Dependency-aware prioritization for drain
**Date**: 2026-02-25 | **Branch**: feat/dep-aware-drain | **Findings**: 1 bug (fixed in PR), 1 perf, 1 question (out of scope)

## What Was Found

The PR adds dependency-aware prioritization to the drain command: before processing, it fetches forward block counts for each issue and sorts by most-blocking-first. It also adds a blocking safety net in `run-issue.ts` that re-checks blocking relations before committing resources. Two findings were actionable: (1) the new `fetchForwardBlockCount` called `relations()` and `inverseRelations()` without `{ first: 250 }`, which would silently under-count blocked issues beyond the default page size — fixed in a follow-up commit on the branch; (2) the same unpaginated pattern existed in the pre-existing `fetchBlockingRelations` function (the blocking safety net inherits this truncation risk), plus `toLinearIssue`'s `comments()` call and three `team.states()` calls in `mutations.ts`.

## Root Cause

This is the **same root cause documented in PR #12's retro**: the Linear SDK's connection pattern looks like a simple array (`.nodes` is an array), so callers forget it's actually a page. The lesson was encoded in MEMORY.md after PR #12, and the new `fetchForwardBlockCount` was written with `{ first: 250 }` after the fix commit — but the *existing* `fetchBlockingRelations` function and `toLinearIssue` were never updated because they were flagged as "out of scope" in the PR #12 retro and never got a dedicated cleanup ticket.

### Why chain: Why did the fix for fetchForwardBlockCount get applied but fetchBlockingRelations was left unpaginated?

1. The review flagged `fetchForwardBlockCount` as a `[bug]` because it was new code in this PR.
2. `fetchBlockingRelations` was flagged as `[question]` (pre-existing, out of scope).
3. The PR #12 retro identified this same pattern in `fetchBlockingRelations` but deferred it.
4. No cleanup ticket was created for the deferred work.
5. Systemic cause: **"out of scope" deferrals without a ticket are silent debt that accumulates until the next retro rediscovers the same pattern.** The lesson from PR #12 was encoded in MEMORY.md but the instances in existing code were never cleaned up.

## Fixes Applied

- **Already fixed in PR (commit 5d86511):** Added `{ first: 250 }` to `relations()` and `inverseRelations()` in `fetchForwardBlockCount` (queries.ts lines 238, 254).
- **Fixed in this retro — queries.ts:** Added `{ first: 250 }` to `relations()` (line 182) and `inverseRelations()` (line 201) in `fetchBlockingRelations`. Added `{ first: 250 }` to `comments()` (line 16) in `toLinearIssue`.
- **Fixed in this retro — mutations.ts:** Added `{ first: 250 }` to all three `team.states()` calls (lines 23, 117, 207). These were the last remaining unpaginated Linear SDK connection calls in the codebase.
- **Codebase-wide audit confirmed:** After these fixes, every `.relations()`, `.inverseRelations()`, `.comments()`, `.labels()`, and `.states()` call in `src/` now passes `{ first: 250 }`. Zero unpaginated connection calls remain.

## Deferred

- **O(3N + M) API calls for prioritization (finding #2, perf):** Each issue in the drain queue triggers a `fetchForwardBlockCount` call which makes 1 issue fetch + 1 relations fetch + 1 inverseRelations fetch, plus per-relation state lookups. At current scale (< 50 issues per drain) this is acceptable. Revisit trigger: if drain latency exceeds 60s or if Linear rate-limit errors appear during the prioritization phase. Potential fix: batch relations query or cache state lookups.

## Lessons Encoded

### 1. "Out of scope" deferrals must produce a ticket or be fixed in the retro (process)

When a retro identifies instances of a bug pattern in existing code and defers them as "out of scope," those instances must either get a cleanup ticket or be fixed in the retro itself. Otherwise the deferred work is invisible and accumulates until the next PR touches the same file and the reviewer re-discovers the same pattern. This retro fixes the remaining instances rather than deferring again.

### 2. Complete the audit, don't just fix the finding (reinforcement of PR #12 lesson)

The PR #12 retro correctly audited the codebase for unpaginated calls and found 4 instances, but only the PR's own code was fixed. The retro documented the remaining instances but no ticket was created. This retro closes the loop by fixing all remaining unpaginated calls across `queries.ts` and `mutations.ts`. The correct workflow is: audit -> fix all instances in the retro (if bounded) OR create a ticket (if large).

## Hotspots

- **`src/linear/queries.ts`** -- 2nd retro appearance (PR #12, #23). Both appearances involve unpaginated Linear SDK calls. The file now has consistent pagination across all 7 connection-returning calls. The `fetchBlockingRelations` and `fetchForwardBlockCount` functions are structurally similar (traverse relations + inverse relations, check state) — a shared traversal helper could reduce duplication but is not urgent.
- **`src/runner/run-issue.ts`** -- 3rd retro appearance (PR #4, #22, #23). This PR adds the blocking safety net (~15 lines). The function continues to grow with each feature. Now a structural hotspot by the 3-retro threshold.
- **`src/runner/drain.ts`** -- 2nd retro appearance (PR #18, #23). The prioritization logic (~20 lines) is cleanly structured. No immediate concern.
- **`src/linear/mutations.ts`** -- 5th retro appearance (PR #3, #11, #12, #15/#17, #23). The `as any` casts are resolved (PR #17), label resolution uses the shared utility, and states are now paginated. Remaining debt: the three `team.states()` calls share a pattern that could use a `resolveState(teamKey, stateName)` utility similar to `resolveLabels`. Not urgent.
