# PR Review Retro: PR #18 — JOS-76: parallel agent concurrency for drain command
**Date**: 2026-02-25 | **Branch**: task-runner/jos-76 | **Findings**: 1 bug, 1 suggestion, 1 question, 1 self-corrected

## What Was Found

The PR adds `--concurrency <n>` to the drain command with a worker-pool pattern. The main bug was non-deterministic result ordering: `results.push()` from concurrent async workers meant the `RunResult[]` array order depended on which worker resolved first, not input order. The fix agent addressed this with indexed assignment. A secondary finding was that the test file duplicated the entire `runWithConcurrency` implementation instead of importing it, and the two copies had already diverged in signature (generic vs hardcoded). The reviewer also self-corrected a bug report about error handling after realizing production `processIssue` catches internally.

## Root Cause

### Why chain: Non-deterministic ordering in concurrent push

**Technical:**
1. `results.push(await processIssue(...))` in concurrent workers produced results in completion order, not input order.
2. The worker pool used a shared mutable index to distribute work, which is correct for assignment, but `push()` appends regardless of which index the worker was processing.
3. The pattern was written as a direct conversion from a sequential `for` loop, where `push()` is order-preserving. The sequential-to-concurrent conversion didn't account for `push()` losing its ordering guarantee.
4. Systemic cause: **when converting sequential loops to concurrent workers, array-append operations silently become non-deterministic.** The type system (`RunResult[]`) doesn't distinguish "ordered" from "unordered" arrays.

**Origin:**
1. The sequential drain loop used `results.push(result)` inside a `for...of`.
2. The concurrency refactor kept `push()` because it "still works" -- no compile error, no runtime error, just wrong ordering.
3. Design assumption: **`push()` is safe in async code because JS is single-threaded.** True for atomicity, false for ordering when multiple `await`s interleave.

### Why chain: Duplicated test implementation

1. The test couldn't mock ES module imports to test `runWithConcurrency` directly from drain.ts.
2. So the test copied the implementation and tested the copy.
3. The copy immediately diverged: test version is generic `(items, concurrency, fn)`, production is hardcoded to `processIssue`.
4. Systemic cause: **when code is untestable in its current form, the workaround (copy-paste) creates a maintenance liability.** The fix is to extract the logic into a testable, importable module.

## Fixes Applied

- **Extracted `runWithConcurrency` to `src/concurrency.ts`** as a generic `<T, R>` utility with JSDoc documenting error semantics (worker dies on throw, other workers continue). Both drain.ts and drain.test.ts now use the same implementation. Eliminates the diverged-copy problem.
- **Added explicit ordering test** that processes items with different delays at concurrency=3 and asserts `results` match input order, not completion order. This test would have caught the original `push()` bug.
- **Fixed error-handling test** to document actual pool behavior (result slot is `undefined` when `fn` throws) with a comment noting that production `processIssue` catches internally, so this path only exercises the raw pool contract.

## Deferred

- **Lock semantics with concurrent workers** (finding #4, question): The single file lock covers all concurrent workers within a drain invocation. This prevents `drain --project A` and `drain --project B` from running simultaneously. The reviewer confirmed this is intentional for now. Revisit trigger: if users request per-project parallelism across separate drain invocations.

## Lessons Encoded

### 1. Sequential-to-concurrent conversion: replace push() with indexed assignment (code fix)

Extracted `runWithConcurrency` to `src/concurrency.ts` using indexed assignment (`results[i] = ...`) with a pre-sized array. This structurally prevents the ordering bug -- the API returns `R[]` in input order by construction. Any future caller gets ordered results without needing to know about the concurrency implementation.

### 2. Untestable private functions should be extracted, not copy-pasted into tests (code fix)

When a function is private/unexported and the test duplicates it, the copies will diverge. The fix is to extract the function into a shared module and export it. Applied here by creating `src/concurrency.ts`. The JSDoc on the exported function documents the error contract so callers know to catch inside `fn` if they need all items processed.

### 3. Array.push() is not order-preserving under concurrency (observation)

In sequential code, `array.push(await fn(item))` preserves input order. Under concurrent workers (even in single-threaded JS), it preserves completion order instead. The type system doesn't flag this. When converting sequential loops to concurrent patterns, always use indexed assignment for ordered results.

## Hotspots

- **`src/runner/drain.ts`** -- 1st retro appearance. The concurrency refactor is clean after extraction. The remaining complexity is in issue collection (multi-project fetch with limit). No immediate concern.
- **`src/cli.ts`** -- 6th retro appearance (PR #3, #11, #12, #13, #16, #18). This PR adds `--concurrency` with `parseInt` parser, continuing the unguarded-parseInt pattern flagged in prior retros. The pattern is not worse than before but remains unaddressed debt.
