# PR Review Retro: PRs #28, #31, #37
**Date**: 2026-03-03 | **Branches**: task-runner/jos-140, task-runner/jos-106, task-runner/jos-142 | **Findings**: 2 security, 2 bug, 1 perf, 1 suggestion

## What Was Found

Two security findings and two bugs across three PRs, all stemming from two systemic patterns. PRs #28 and #31 both introduced `execSync` with string interpolation on external/config input (`defaultBranch` in `getCommitStats()`, `prUrl` from Linear comments in `getPrState()`), reintroducing the shell injection vulnerability that PR #36 is already addressing elsewhere. PR #37 used a greedy regex (`/\{[\s\S]*...\}/`) to extract JSON from agent output, which could span from the first `{` to the last `}` across multiple JSON objects. All three were fixed in-PR. Additionally, PR #37 had an N+1 query pattern in `hasBlockingRelation` (fetching each related issue individually) and a dynamic import inside a loop, both noted but not fixed as non-critical.

## Root Cause

### Why chain: `execSync` with string interpolation keeps reappearing (most significant)

**Technical:**
1. `getCommitStats()` (PR #28) used `execSync(\`git rev-list --count origin/${defaultBranch}..HEAD\`)` and `getPrState()` (PR #31) used `execSync(\`gh pr view ${prUrl} --json state\`)`.
2. Both interpolate external data into a shell command string, enabling injection if the value contains shell metacharacters.
3. `prUrl` is particularly dangerous: it comes from Linear comment text (external input). `defaultBranch` comes from config but could still be exploited if the config file is compromised.
4. The codebase's default pattern for running CLI tools is `execSync` with template literals. Every existing function in `branch.ts` and `worktree.ts` uses this pattern. New code copies the surrounding style.
5. Systemic cause: **there is no safe abstraction for running git/gh commands.** Without an `execGit(args[])` or `execGh(args[])` helper that uses `spawnSync` internally, every new callsite must independently remember to avoid string interpolation. PR #36 (`execGit`/`execGh`) is the structural fix.

**Origin:**
1. The original `branch.ts` and `worktree.ts` were written using `execSync` with string interpolation as the standard pattern.
2. This worked safely initially because early callsites only interpolated values the runner itself generated (branch names derived from issue IDs, worktree paths).
3. As the codebase grew, new functions followed the same pattern but with less controlled inputs (config values, URLs from external comments).
4. Design assumption: **all interpolated values are trusted.** This was approximately true at the start but became false as the system ingested more external data.

### Why chain: Greedy JSON regex is duplicated in 4 places

**Technical:**
1. PR #37's `parseRefineOutput` used `/\{[\s\S]*"agentType"[\s\S]*\}/` to extract JSON, which is greedy and spans from the first `{` to the last `}` in the string.
2. The same pattern exists in 3 other files on `main`: `review.ts:95`, `organize-tickets.ts:59`, `run-issue.ts:381`.
3. PR #37 fixed its copy by implementing `extractBalancedJson()` with brace counting, but the helper is local to `refine-tickets.ts`.
4. Systemic cause: **the "parse agent output" pattern has been copied and diverged 4 times** (noted in PR #13 retro as a duplicated pattern). Each copy independently implements JSON unwrapping + regex extraction. The `extractBalancedJson` fix needs to be a shared utility.

## Fixes Applied

**In PR #28 (jos-140 worktree):**
- Replaced `execSync` with `spawnSync` using args array in `getCommitStats()` for both the `git rev-list` and `git diff --name-only` calls. This eliminates shell interpretation of `defaultBranch`.

**In PR #31 (jos-106 worktree):**
- Replaced `execSync` with `spawnSync` args array in `getPrState()`, passing `["pr", "view", prUrl, "--json", "state"]` to avoid shell interpretation of the PR URL.
- Tightened PR URL regex from `[^\s]+` to `[\w.-]+/[\w.-]+` to prevent over-matching trailing characters from markdown links like `[text](url)`.

**In PR #37 (jos-142 worktree):**
- Replaced greedy regex with `extractBalancedJson()` helper that uses brace-counting with string-escape awareness. This correctly handles nested objects and stops at the matching closing brace instead of greedily consuming to the last `}` in the text.

## Deferred

- **Remaining `execSync` with interpolation on `main`**: 10+ callsites in `branch.ts` and `worktree.ts` still use `execSync` with template literals. PR #36 (JOS-141) introduces `execGit`/`execGh` abstractions that solve this systemically. Recommendation: merge PR #36 first, close PR #38 (conflicts with #36), then verify all callsites are converted. Revisit trigger: PR #36 merge.
- **Greedy JSON regex in 3 remaining files**: `review.ts:95`, `organize-tickets.ts:59`, `run-issue.ts:381` all use `/\{[\s\S]*"key"[\s\S]*\}/` which has the same greedy-span bug fixed in PR #37. The `extractBalancedJson` helper should be extracted to a shared utility (e.g., `src/utils/json-extract.ts`) and all 4 callsites should use it. Creating a ticket for this.
- **N+1 queries in `hasBlockingRelation`** (PR #37): Each relation check fetches the related issue individually. Low urgency since refine-tickets runs infrequently and dependency lists are typically small (<5 items). Revisit trigger: if refine-tickets is used on batches >20 tickets.

## Lessons Encoded

### 1. Shell command execution must use args arrays, not string interpolation (CLAUDE.md + MEMORY.md)

The `execSync` + template literal pattern is an injection vulnerability when any interpolated value comes from external input (config, API responses, user input). The structural fix is an abstraction like `execGit(args[])` that enforces `spawnSync` with args arrays. Until PR #36 merges, new code must use `spawnSync` with explicit args. Added to MEMORY.md as a cross-project security principle.

### 2. Greedy regex for JSON extraction is a latent bug (MEMORY.md)

The pattern `/\{[\s\S]*"key"[\s\S]*\}/` is greedy and will match from the first `{` to the last `}` in the text, spanning across multiple JSON objects. Use brace-counting extraction or non-greedy patterns with validation. The codebase has 3 remaining instances of this pattern. Added to MEMORY.md.

### 3. Duplicated patterns produce duplicated bugs (recurring theme)

This is the third retro noting the duplicated "parse agent output" pattern (PR #13 first flagged it, PR #37 now has a concrete bug caused by it). When a pattern is copied 4 times, a bug fix in one copy does not fix the other three. The `extractBalancedJson` helper in PR #37 is the right fix but needs to be shared.

## Hotspots

- **`src/git/branch.ts`** -- 2nd retro appearance (PR #10, PR #28). PR #28 fixed `getCommitStats` but the file still has 5 `execSync` callsites with string interpolation (`hasCommits`, `pushBranch`, `createPR`, `addPRLabel`, `addPRComment`). PR #36 will address these with `execGit`/`execGh`. The `escapeShell` function is an incomplete defense (misses single quotes, newlines, null bytes) and should be eliminated once `spawnSync` args arrays are used everywhere.
- **`src/git/worktree.ts`** -- 2nd retro appearance (PR #10, PR #28 by association). Has 5 `execSync` callsites with interpolation. Same PR #36 dependency.
- **`src/runner/run-issue.ts`** -- 5th retro appearance (PR #4, #22, #23, #26, #28/37). Contains the greedy JSON regex at line 381 (`parseReviewVerdict`). Also has `any` type annotations on helper functions noted in prior retros.
- **`src/runner/review.ts`** -- 1st retro appearance. Contains greedy JSON regex at line 95 (same pattern as the PR #37 bug).
- **`src/runner/organize-tickets.ts`** -- 5th retro appearance (PR #12, #13, #25, #26, #28/37). Contains greedy JSON regex at line 59. The label-mutation duplication and 6+ responsibilities noted in prior retros remain.
