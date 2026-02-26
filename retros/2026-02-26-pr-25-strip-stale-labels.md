# PR Review Retro: PR #25 — fix: strip stale agent-ready labels from blocked tickets
**Date**: 2026-02-26 | **Branch**: feat/fix-organize-tickets-blocking | **Findings**: 1 suggestion (non-blocking)

## What Was Found

Clean review. The PR correctly moves the blocking-relation check before the early-skip optimization and adds label stripping for blocked tickets that previously received `agent-ready`. One minor suggestion noted: the dry-run path uses cached `issue.labels` (names from the initial fetch) while the real path fetches fresh label IDs from the API via `getIssueLabelIds`. This is a consistent pattern throughout the file (the unblocked label-manipulation path at lines 237-272 does the same) and is functionally correct since dry-run is inherently snapshot-based. No bugs, no security issues.

## Root Cause

N/A. No bugs found.

## Fixes Applied

- None needed. The review suggestion is a cosmetic consistency gap that follows an established pattern in the file.

## Deferred

- **Duplicated label-manipulation pattern**: The fetch-mutate-write sequence (`getIssueLabelIds` -> `new Set(ids)` -> add/delete -> `setIssueLabels`) now appears twice in the same file (blocked path lines 153-165, unblocked path lines 238-258). A shared `modifyIssueLabels(issueId, add, remove, teamLabels)` helper would reduce this. Revisit trigger: if a third label-manipulation site is added to the file, or if a bug is introduced in one copy but not the other.
- **`organize-tickets.ts` growing complexity**: This file now handles: label resolution, blocking detection with label stripping, context gathering, comment posting, state transitions, and dry-run simulation. It reached the 3-retro hotspot threshold. A future refactor could extract the label-manipulation logic into `src/linear/labels.ts` and the blocking-detection logic into a dedicated module. Revisit trigger: next PR touching this file, or if the function exceeds ~200 lines of loop body.

## Lessons Encoded

### 1. Hotspot update for `organize-tickets.ts` (MEMORY.md)

Updated the structural hotspots section to reflect the 3rd retro appearance (PR #12, #13, #25) and the new duplicated label-manipulation pattern.

## Hotspots

- **`src/runner/organize-tickets.ts`** -- 3rd retro appearance (PR #12, #13, #25). Now a structural hotspot. The file handles 6 distinct responsibilities (label resolution, blocking detection, label stripping, context gathering, comment posting, state transitions). The `getIssueLabelIds` -> mutate -> `setIssueLabels` pattern is duplicated within the file. The `collectAllNodes` extraction to `src/linear/labels.ts` (PR #17) helped, but the file continues to grow with each feature.
- **`src/linear/mutations.ts`** -- Not directly touched by this PR, but `setIssueLabels` is called from both label-manipulation paths. 6th indirect appearance.
