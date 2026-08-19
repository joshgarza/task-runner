# PR Review Retro: PRs #45 and #46, Thin Codex Routing and Native Review
**Date**: 2026-08-18 | **Branches**: feat/phase1-routing, feat/phase1-native-review | **Findings**: 3 P1 bugs, 7 P2 bugs

## What Was Found

The Phase 1 routing work correctly made TaskRunner thinner, but review exposed several cross-system invariants that the first implementation treated as best-effort. Dependency lookup failures could let blocked work proceed, refinement could be marked complete before its routing label was durable, native review and Linear transition failures could be logged without failing the run, and pull request health could infer recency from where a link happened to be stored instead of GitHub's event chronology.

The remaining findings were state-reporting variants of the same problem. Cloud-delegated work could be reported as a stale local worker, cloud completion logs could print an undefined pull request, fallback pull request links were invisible to health checks, browser-style pull request URLs were rejected, and operations refinement could retain a conflicting ready label.

## Root Cause

- **Technical:** orchestration steps that cross Linear, GitHub, and the local runner lacked explicit postcondition checks. A successful function return or log line was sometimes accepted as evidence that the external state change had happened.
- **Modeling:** pull request link position in a Linear description or comment stream was used as a proxy for creation time. Storage order and event chronology are different concepts.
- **Testing:** happy-path coverage asserted the intended route, but did not consistently inject dependency lookup, label mutation, review request, transition, or metadata lookup failures.

## Fixes Applied

- Blocker verification now fails closed when Linear relations cannot be fetched.
- Refinement persists the selected routing label before writing the refined marker, and removes a conflicting ready label for operations work.
- Cloud delegation is excluded from local stale-worker warnings and uses route-aware completion logging.
- Native Codex review requests and the transition to In Review are required postconditions. Failures keep the issue retryable and preserve the pull request and branch for recovery.
- Pull request links are normalized from common GitHub browser variants and discovered in both issue descriptions and comments.
- Pull request health queries GitHub metadata for every unique linked pull request and selects the newest by GitHub `createdAt`. Incomplete metadata fails closed instead of guessing.
- Failure-path and ordering tests now cover each repaired invariant.

## Deferred

- **Missing package test script:** the repository's documented validation shape refers to `npm test`, but `package.json` does not define it. The phase was verified with the repository's direct Node test command. This is outside the routing and native-review scope and needs a Linear ticket when Linear access is available.

## Lessons Encoded

### 1. External handoffs need verified postconditions

Creating a branch, posting a review request, applying a routing label, and transitioning an issue are not incidental side effects. Each one is part of the orchestration contract. The runner now returns failure when a required handoff cannot be confirmed, while preserving recoverable artifacts for a later retry.

### 2. Derive chronology from authoritative timestamps

Descriptions and comments are storage locations, not an event log with shared ordering. When multiple pull requests are linked, TaskRunner now asks GitHub for `createdAt` and makes the choice from authoritative metadata.

### 3. Route-aware status must follow the active execution model

Local workers, cloud-delegated tasks, and operations refinement have different valid states. Drain output, stale-worker checks, and label mutations now branch on the selected route instead of assuming every issue follows the legacy local-worker lifecycle.

## Hotspots

- **`src/runner/run-issue.ts`** is now a structural hotspot with repeated retro appearances. It coordinates dependency checks, worktrees, pull requests, review requests, and Linear transitions, so new handoffs should be isolated behind small functions with explicit success results.
- **`src/runner/drain.ts`** and **`src/runner/review.ts`** have each reached repeated-review territory. Their route-aware formatting and URL normalization helpers reduce the chance of another implicit lifecycle assumption.
- **`src/runner/refine-tickets.ts`** has its second retro appearance. Ordering label persistence before marker persistence is now an explicit invariant.
- **`src/runner/pr-health.ts`** appears for the first time. Its main risk boundary is now clear: GitHub metadata is authoritative, and missing metadata must not produce a guessed health result.
