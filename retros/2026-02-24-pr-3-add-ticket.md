# PR Review Retro: PR #3 — JOS-48: create an "add-ticket" process
**Date**: 2026-02-24 | **Branch**: task-runner/jos-48 | **Findings**: 1 bug, 2 suggestions

## What Was Found

1. **[bug] NaN priority passed to Linear API** (src/cli.ts:113)
   - `parseInt(v, 10)` returns `NaN` for non-numeric input like `--priority abc`.
   - `NaN` gets silently passed through to `createIssue` and then to `client.issueCreate`, causing an opaque API error from Linear rather than a clear CLI validation error.

2. **[suggestion] `as any` bypasses type safety** (src/linear/mutations.ts:107)
   - `client.issueCreate(payload as any)` where `payload` is `Record<string, unknown>`. The `@linear/sdk` exports `IssueCreateInput` which would provide compile-time field validation.

3. **[suggestion] Labels option description mismatch** (src/cli.ts:109)
   - Option description says "Comma-separated labels" but Commander's variadic `<labels...>` syntax uses space-separated values. Misleading for users.

## Root Cause

1. **NaN bug**: Missing input validation in the Commander option parser callback. The existing `run` command has the same pattern for `--max-turns` and `--max-attempts` (also vulnerable to NaN), suggesting this is a codebase-wide pattern gap.

2. **Type safety**: The `createIssue` function builds its payload incrementally with conditional fields, making it awkward to type statically. The developer chose `Record<string, unknown>` for flexibility but lost type checking.

3. **Labels description**: Likely a copy-paste from a different CLI framework's convention. Commander's variadic args are a less common pattern.

## Fixes Applied

- **NaN priority**: Added range validation (0-4) and `isNaN` check in the Commander option parser. Throws a clear error: `"Invalid priority: abc. Must be 0-4."` Commit: `b2a8736`.

## Deferred

- **`as any` cast**: Not a runtime bug. Suggested using `IssueCreateInput` from `@linear/sdk` in the PR comment. Left to author's discretion.
- **Labels description**: Not a runtime bug. Suggested fixing the description or switching to comma-separated parsing. Left to author's discretion.
- **NaN in existing commands**: The `run` command's `--max-turns` and `--max-attempts` options have the same `parseInt` without NaN guard. Should be fixed separately to keep this PR scoped.

## Lessons Encoded

| Finding | Automatable? | How |
|---------|-------------|-----|
| NaN from parseInt | Yes | Lint rule: `no-unguarded-parseInt` custom ESLint rule, or a shared `parseIntSafe` utility used across all Commander option parsers |
| `as any` cast | Yes | `@typescript-eslint/no-unsafe-argument` or `@typescript-eslint/no-explicit-any` lint rules |
| Misleading option description | No | Code review catch; could add a CLI integration test that verifies `--help` output matches actual behavior |

**Test gap**: No tests exist for CLI option parsing. A minimal test that would catch the NaN bug:
```ts
// test: --priority rejects non-numeric input
import { execSync } from "child_process";
const result = execSync('node --experimental-strip-types src/cli.ts add-ticket "test" --team JOS --priority abc 2>&1', { encoding: "utf-8" });
assert(result.includes("Invalid priority") || result.includes("Must be 0-4"));
```

**Similar patterns elsewhere**: The `run` command at src/cli.ts:24-26 has `parseInt` without NaN guard on `--max-turns` and `--max-attempts`. The `drain` command at line 60 and `standup` at line 96 also have unguarded `parseInt`. These should all get the same treatment.

## Hotspots

- `src/cli.ts` — All `parseInt` option parsers across all commands (lines 24, 26, 60, 96)
- `src/linear/mutations.ts` — Type safety around API payloads (`as any` pattern)
