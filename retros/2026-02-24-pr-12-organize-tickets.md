# PR Review Retro: PR #12 — JOS-70: Add organize-tickets CLI command
**Date**: 2026-02-24 | **Branch**: task-runner/jos-70 | **Findings**: 3 bugs, 1 perf

## What Was Found

1. **[bug] Silent error swallowing in `fetchBlockingRelations`** (src/linear/queries.ts)
   - A bare `catch {}` around `inverseRelations()` swallowed all errors, including network and rate-limit failures. This caused tickets with fetch failures to be incorrectly classified as unblocked, potentially labeling them `agent-ready` when they still had active blockers.

2. **[perf] Redundant API calls in `getIssueLabelIds`** (src/runner/organize-tickets.ts)
   - For each unblocked issue, the code re-fetched the issue from Linear to get label IDs. The label name-to-ID map was already available from `resolveTeamLabels`, so the IDs could have been computed without additional API calls.

3. **[bug] No pagination on `team.labels()`** (src/runner/organize-tickets.ts, src/linear/mutations.ts)
   - The default page size silently truncated results for teams with many labels. A label present in the team but beyond the first page would fail to resolve, causing it to be silently skipped.

4. **[bug] Workspace labels not included** (src/runner/organize-tickets.ts)
   - `team.labels()` only returns team-scoped labels. A workspace-level label like `agent-ready` would fail to resolve if it was not also scoped to the team.

## Fixes Applied (in PR)

1. **Error swallowing**: Replaced `try/catch` with `typeof issue.inverseRelations === "function"` -- feature detection instead of exception-based control flow. Network/rate-limit errors now propagate naturally.
2. **Pagination**: Added `collectAllNodes()` helper with `{ first: 250 }` + `fetchNext` loop for `team.labels()`, `issue.labels()`, and `client.issueLabels()`.
3. **Workspace labels**: Added `client.issueLabels()` fetch merged with team labels, team taking precedence.
4. **Perf issue**: Deferred as non-critical.

## Root Cause

### Why chain: Silent error swallowing (most significant finding)

**Technical:**
1. `fetchBlockingRelations` wrapped `inverseRelations()` in a bare `catch {}`.
2. Because `inverseRelations` is not present on all Linear SDK issue objects (it depends on the SDK version and the shape of the GraphQL response).
3. The developer used try/catch as a feature-detection mechanism: "try calling the method; if it doesn't exist, skip it."
4. But JavaScript's `catch` is indiscriminate -- it catches `TypeError` (method doesn't exist) AND `NetworkError`, `RateLimitError`, etc.
5. Systemic cause: **exception-based feature detection is inherently unsafe** when the method, if it exists, can also throw for operational reasons. The correct pattern is `typeof` checking before invocation, which separates "does this exist?" from "did this fail?"

**Origin:**
1. The developer needed to handle an optional SDK method.
2. The Linear SDK's TypeScript types may not accurately reflect runtime method availability (the types might say the method exists even when it doesn't for a particular query shape).
3. Without accurate types, the developer reached for the most pragmatic approach: try/catch.
4. Design assumption: "if it throws, it must be because the method doesn't exist." This assumption collapses two failure modes into one.

### Why chain: Unpaginated label fetches

**Technical:**
1. `team.labels()` was called without `{ first: N }` and without paginating.
2. Because the Linear SDK defaults to a small page size (typically 50) and returns a connection object, not a full array.
3. The developer used `.nodes` directly, which only gives the first page.
4. Systemic cause: **the Linear SDK's connection pattern looks like a simple array** (`.nodes` is an array), so it's easy to forget that it's actually a page. Nothing in the SDK's TypeScript types forces the caller to handle pagination -- you have to know to check `pageInfo.hasNextPage`.

## Same-Pattern Audit (unpaginated `.labels()` on main)

The PR correctly paginated its own label fetches, but the **same unpaginated pattern exists in 4 locations on main**:

| File | Line | Call | Risk |
|------|------|------|------|
| `src/linear/mutations.ts` | 58 | `team.labels()` in `createChildIssue` | Labels beyond first page silently unresolved |
| `src/linear/mutations.ts` | 95 | `team.labels()` in `createIssue` | Same -- label lookup fails silently |
| `src/linear/queries.ts` | 13 | `issue.labels()` in `toLinearIssue` | Issue labels truncated to first page |
| `src/linear/queries.ts` | 161 | `issue.labels()` in `fetchRecentActivity` | Same as above |

Additionally, neither `createChildIssue` nor `createIssue` in `mutations.ts` resolves workspace-level labels -- both use only `team.labels()`. The same bug fixed in the PR exists unfixed on main.

## Deferred

- **Perf: `getIssueLabelIds` redundant API calls**: Non-critical, deferred by review. The fix would map label names through the already-fetched `teamLabels` map instead of re-fetching each issue. Revisit trigger: if `organize-tickets` is run against projects with many unblocked tickets, or if rate-limit errors appear.
- **Unpaginated `.labels()` on main (4 locations)**: These are the same class of bug fixed in the PR, but they exist in already-shipped code on `main`. Should be a separate ticket to avoid scope creep on PR #12. The practical risk is low today (small team, few labels) but will silently break as labels accumulate. **Created ticket recommended.**
- **`as any` cast in `mutations.ts:150`**: 3rd retro appearance (PR #3, #11, #12). Reached the structural hotspot threshold. Should be addressed in a dedicated cleanup PR using `IssueCreateInput` from `@linear/sdk`.
- **Labels description mismatch in `cli.ts:114`**: 3rd retro appearance (PR #3, #11, #12). "Comma-separated labels" is wrong for Commander variadic `<labels...>` (space-separated). Should be fixed across all commands.

## Lessons Encoded

### 1. Never use try/catch for feature detection (MEMORY.md)

Exception-based feature detection (`try { obj.method() } catch {}`) is unsafe when the method, if it exists, can also throw for operational reasons (network, rate-limit, permissions). Use `typeof obj.method === "function"` to check existence, then call normally so operational errors propagate. This applies to any SDK where method availability varies by version or query shape.

### 2. Linear SDK connections require explicit pagination (CLAUDE.md)

Every `.labels()`, `.states()`, `.comments()`, `.relations()` call on a Linear SDK object returns a connection with a default page size. Always pass `{ first: 250 }` and use the `collectAllNodes` pagination helper from `organize-tickets.ts`. Treat `.nodes` on an unpaginated connection as a potential data truncation bug.

### 3. Three-retro hotspots must be addressed (process observation)

`src/linear/mutations.ts` and `src/cli.ts` have now appeared in 3 retros each with the same unfixed patterns (`as any`, labels description, unpaginated labels). Deferred suggestions that survive 3 PRs are proven propagation vectors -- each new function copies the existing pattern. These need dedicated cleanup tickets, not continued deferral.

## Hotspots

- **`src/linear/mutations.ts`** -- **3rd retro appearance** (PR #3: `as any`; PR #11: `as any` + eager fetch; PR #12: unpaginated `.labels()`, no workspace labels, `as any` still present). **Structural hotspot.** Every new mutation function copies the unpaginated `team.labels()` + `as any` pattern. Needs a shared `resolveLabels(teamKey, labelNames)` utility that paginates and includes workspace labels.
- **`src/cli.ts`** -- **3rd retro appearance** (PR #3: NaN priority, labels description; PR #11: labels description copied; PR #12: labels description still present). **Structural hotspot.** The "Comma-separated labels" description has survived 3 reviews without being fixed in the source.
- **`src/linear/queries.ts`** -- 1st retro appearance, but contains 2 instances of the unpaginated `.labels()` pattern (lines 13, 161) and the `toLinearIssue` function is called by every query function, making it a high-frequency truncation risk.
