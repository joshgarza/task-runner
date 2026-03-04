# PR Review Retro: PR #26 -- fix: gate needs-human-approval tickets from agent processing
**Date**: 2026-02-26 | **Branch**: feat/fix-approval-gate | **Findings**: 1 bug

## What Was Found

The dry-run path for the new needs-approval label stripping block reported label removals that the real-run path would never execute. The dry-run filter included any label matching `l.startsWith("agent:")`, but the real-run path only removes labels present in the `teamLabels` map (via `teamLabels.get(name)` returning a non-undefined ID). Labels using the `agent:` prefix that are workspace-level or not registered as team labels would appear in dry-run output but be silently skipped in real runs.

## Root Cause

- **Technical**: The dry-run filter used `teamLabels.has(l) || l.startsWith("agent:")`, but real-run used `teamLabels.get(name)` as a guard. The `agent:` prefix check was an over-inclusive heuristic that didn't match the real-run's ID-based filtering.
- **Why the mismatch**: The dry-run and real-run label-manipulation paths are hand-written separately in each code block. There is no shared function that computes "which labels would change" independent of whether the mutation actually executes. Each new label-manipulation site requires manually duplicating the filtering logic, and the dry-run path is tested only by manual inspection.
- **Design assumption**: The `if (!dryRun) { ... } else if (dryRun) { ... }` pattern treats dry-run as a completely separate code path rather than a mode flag on a shared computation. This guarantees the two paths will diverge when new filtering conditions are added.

## Fixes Applied

- Removed `|| l.startsWith("agent:")` from the dry-run filter at line 162 so it only includes labels present in `teamLabels`, matching the real-run guard at line 151. (Commit d7d8c24)

## Deferred

- **Extract shared label-mutation helper**: The `getIssueLabelIds -> Set -> add/delete -> setIssueLabels` pattern with parallel dry-run logic now appears THREE times in `organize-tickets.ts` (needs-approval at L147, blocked at L190, unblocked at L275). A `computeLabelDiff(issueLabels, toAdd, toRemove, teamLabels)` function would eliminate the dual-path divergence risk entirely. The dry-run path would use the same computation, just skip the API call. This was already flagged in the PR #25 retro but the third instance makes it more urgent. Revisit trigger: next PR touching this file.
- **No test coverage for organize-tickets**: The only test file in `src/runner/` is `drain.test.ts`. A unit test that mocks `teamLabels` and verifies dry-run output matches real-run label changes would have caught this bug mechanically. Revisit trigger: when the label-mutation helper is extracted (it becomes independently testable).

## Lessons Encoded

### 1. Dry-run/real-run divergence pattern (MEMORY.md)
Added a new entry under a "Dry-Run Fidelity" section documenting the anti-pattern and the structural fix.

### 2. Hotspot update for `organize-tickets.ts` (MEMORY.md)
Updated to reflect 4th retro appearance (PR #12, #13, #25, #26). The label-mutation pattern is now triplicated.

## Hotspots

- **`src/runner/organize-tickets.ts`** -- 4th retro appearance (PR #12, #13, #25, #26). The file now has three separate label-manipulation blocks each with hand-written dry-run/real-run divergent logic. The duplicated pattern directly caused this bug. Extraction of a shared helper is no longer "nice to have" but is the primary structural prevention for this class of bug.
- **`src/runner/run-issue.ts`** -- touched by this PR (new approval gate at line 68), 4th retro appearance (PR #4, #22, #23, #26). The change is clean (simple label check), no new patterns of concern.
