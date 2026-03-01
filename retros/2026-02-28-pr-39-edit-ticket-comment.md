# PR Review Retro: PR #39 -- JOS-170: add --comment option to edit-ticket command
**Date**: 2026-02-28 | **Branch**: feat/jos-170-edit-ticket-comment | **Findings**: 1 bug, 1 suggestion

## What Was Found

The primary bug: wrapping `updateIssue()` in an `if (needsIssueUpdate)` conditional to allow comment-only operations also removed the fail-fast path for the no-arguments case. Previously, calling `editTicket()` with no options would reach `updateIssue()`, which throws "No fields to update" when the payload is empty (mutations.ts:143). After the refactor, the `if (needsIssueUpdate)` guard caused `updateIssue()` to be skipped entirely, and the function would print "Updated" without doing anything. The fix added an explicit early guard before any API calls.

Secondary finding: two retro files from PRs #24 and #26 were bundled into the initial commit of this feature branch. These retros are unrelated to the --comment feature and should have been committed to main when they were produced.

## Root Cause

- **Technical**: The original code relied on `updateIssue()` as the single exit point, with its internal "empty payload" check serving as the no-args validator. Adding `--comment` required splitting the single call into two conditional calls (`updateIssue` if fields, `addComment` if comment), which removed the unconditional call that provided the no-args validation.
- **Why the validation gap**: The "No fields to update" error lived inside `updateIssue()` (mutations.ts:143) rather than in the caller. The caller delegated input validation to the downstream function. When the downstream call became conditional, the delegated validation became conditional too. The caller had no explicit "at least one thing to do" check of its own.
- **Design assumption**: When a function is always called, its internal validation can substitute for caller-side validation. This assumption breaks whenever a refactor makes the call conditional.

## Fixes Applied

- **Early guard added (commit 2bb01ad):** `hasFieldUpdates` check at line 24-27 throws "No fields to update" when neither field updates nor `--comment` are provided. The validation now lives in the caller, independent of whether `updateIssue` is called.

## Deferred

- **Duplicated field-presence logic:** Lines 24 and 42 both enumerate the same set of option fields to determine "any field updates?" vs "any issue update needed?". They use slightly different conditions (`opts.labels || opts.addLabels` vs `labelNames`) because one runs before label merging and one after, which is correct. But if a new field is added to `EditTicketOptions`, both checks must be updated. A structural fix would be to compute the `updateIssue` payload first, then check if it's non-empty, but that would require reordering the fetch-then-resolve flow. Low risk given the file's simplicity. Revisit trigger: next field addition to `EditTicketOptions`.
- **Bundled retro files:** PR #24 and PR #26 retros are included in this feature branch but belong on main. They should be split out when this PR merges, or merged as-is if the retros are simply being backfilled. Not blocking.

## Lessons Encoded

### 1. Delegated validation breaks under conditional calls (MEMORY.md)
When a function relies on a downstream call for input validation (e.g., "No fields to update" thrown by `updateIssue`), wrapping that call in a conditional silently removes the validation. The fix is to validate at the caller level before deciding which downstream calls to make. Added as a new entry to MEMORY.md.

## Hotspots

- **`src/runner/edit-ticket.ts`** -- 2nd retro appearance (PR #11, PR #39). PR #11 flagged the eager team fetch inherited from `createIssue`. PR #39 found validation delegated to `updateIssue` broke when the call became conditional. Both are symptoms of the file inheriting patterns from other functions without adapting them. Not yet at the 3-retro hotspot threshold.
- **`src/cli.ts`** -- 8th retro appearance (PR #3, #11, #12, #13, #16, #18, #22, #39). The change in this PR (adding `--comment` option) is clean and minimal. No new patterns of concern.
