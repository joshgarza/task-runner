# PR Review Retro: PR #22 — Multi-agent RBAC: dynamic registry, dispatcher, failure analysis, proposals
**Date**: 2026-02-25 | **Branch**: feat/agent-rbac | **Findings**: 1 security, 3 bug, 1 suggestion, 1 question, 1 perf

## What Was Found

The PR introduces a multi-agent RBAC system: a JSON-based agent registry with tool whitelists and inheritance, a label-based dispatcher, failure analysis that detects permission denials, and a proposal workflow for capability escalation. Four critical issues were found and fixed in a follow-up commit: (1) path traversal in `proposalPath()` via unsanitized CLI input, (2) forbidden-tool validation used exact string matching instead of prefix matching allowing bypass via suffixes like `Bash(sudo su:*)`, (3) duplicate proposals on drain re-runs (no idempotency), and (4) over-broad timeout regex matching "timeout" as a substring in config values. Two additional findings about silent label failures and a perf issue (registry re-read from disk on every call) were addressed in this retro.

## Root Cause

### Why chain: Forbidden tool bypass via exact matching (most significant finding)

**Technical:**
1. `validateRegistry()` compared each tool string against `FORBIDDEN_PREFIXES` using `tool === prefix` (exact match only).
2. `Bash(sudo su:*)` !== `Bash(sudo` so the check passed, even though the tool grants sudo access.
3. The fix agent's prefix-matching change (`tool.startsWith(prefix)`) is correct — it catches `Bash(sudo su:*)`, `Bash(sudo rm:*)`, etc.
4. Systemic cause: **the validation and the runtime tool-matching used different matching semantics.** Claude CLI's `--allowedTools` interprets `Bash(sudo:*)` as a prefix/glob, but the registry validator was treating tool strings as opaque exact values.

**Origin:**
1. The forbidden-prefixes list was designed as a safety net to prevent dangerous tools from being registered.
2. The validator assumed it only needed to match the exact strings in the registry JSON.
3. But tool strings have structure — `Bash(cmd:*)` is a prefix pattern, not a literal. The validator was treating structured data as opaque strings.
4. Design assumption: **tool strings are atomic identifiers.** In reality, they are patterns with prefix semantics that the runtime expands. Any validator must match against the same semantics the runtime uses.

### Why chain: Path traversal in proposalPath()

1. `approve-agent <id>` passes CLI input directly to `proposalPath(id)` which builds a file path via `resolve(PROPOSALS_DIR, \`${id}.json\`)`.
2. No validation — `id` could be `../../etc/passwd` or any path.
3. Systemic cause: **any function that builds a filesystem path from external input needs input validation.** The fix (UUID regex) is correct but pattern-specific. A more general defense would be to verify the resolved path stays within the expected directory.

## Fixes Applied

**In the fix commit (cf33dea):**
- **Prefix matching for forbidden tools**: Changed validation from `tool === prefix` to `tool === prefix || tool.startsWith(prefix)`, and extended validation to check resolved (inherited) tools, not just raw tool lists. This closes the bypass via suffixed tool strings.
- **UUID validation on proposal IDs**: Added regex `/^[0-9a-f]{8}-...$/i` check in `proposalPath()` to reject non-UUID input. Prevents path traversal since only `randomUUID()` output is valid.
- **Idempotency guard on createProposal**: Before creating, scans existing pending proposals for the same `issueIdentifier + baseAgentType` combo. Returns existing proposal on match, preventing duplicates on drain re-runs.
- **Word-boundary timeout regex**: Changed from `/timeout/gi` to `/\btimed out\b|\bSIGTERM\b|\bETIMEDOUT\b/gi`, preventing false positives on config values like `agentTimeoutMs`.

**In this retro:**
- **Registry caching**: Added in-memory `cachedRegistry` variable to `loadRegistry()`, mirroring the existing `cachedConfig` pattern in `config.ts`. Cache is updated (not invalidated) on `addAgentType()` writes. Eliminates 2-3 redundant disk reads per `run` invocation.
- **Missing label warnings**: Added explicit `log("WARN", ...)` in `createProposal()` when `needs-human-approval` label is missing from Linear, and in `approveProposal()` when `agent:<type>` label is missing. These labels being absent previously caused silent no-ops in the approval flow — the label swap would succeed (no error) but the label wouldn't actually be added, breaking the dispatch loop.

## Deferred

- **Auto-create labels in Linear on proposal creation/approval**: The `needs-human-approval` and `agent:<type>` labels must exist in Linear for the approval flow to work. Currently we warn when they're missing. Auto-creating them via the Linear SDK's `createIssueLabel` mutation would make the system self-bootstrapping, but requires choosing between team-scoped vs workspace-scoped labels and handling name collisions. Revisit trigger: when the first real proposal flow is tested end-to-end.
- **General path-containment guard**: The UUID regex in `proposalPath()` is correct but narrow. A general `assertPathWithin(resolved, baseDir)` utility would protect against traversal in any future path-building function. Low urgency since `proposalPath` is the only function building paths from external input today.

## Lessons Encoded

### 1. Validators must match the semantics of the runtime they protect (CLAUDE.md observation)

When a system uses structured strings with prefix/glob semantics (like Claude CLI's `--allowedTools`), any validator checking those strings must use the same matching logic. Exact string comparison against prefix patterns is a bypass — `Bash(sudo su:*)` is not equal to `Bash(sudo` but it matches the forbidden prefix semantically. The fix (`.startsWith()`) aligns the validator with the runtime. This is a general principle: validators that use weaker matching than the runtime are bypassable.

### 2. File paths from external input need format validation or containment checks (code fix)

Any `resolve(baseDir, untrustedInput)` call is a path traversal risk. The narrowest fix is format validation (UUID regex here). The broadest fix is a containment check: `if (!resolved.startsWith(baseDir)) throw`. Applied the narrow fix here since proposal IDs are always UUIDs by construction.

### 3. Idempotency on append-only side effects in re-runnable commands (recurring pattern)

This is the third time this pattern has appeared (PR #13 context comments, PR #22 proposals). The principle is now well-established in MEMORY.md. The `createProposal` fix follows the exact same read-before-write pattern documented from PR #13. The recurrence suggests the pattern is a natural consequence of adding new side effects to the drain/run pipeline — each new side effect needs its own idempotency guard because the pipeline is designed to be re-runnable.

### 4. Silent no-ops when labels don't exist in Linear (code fix)

When `labelMap.get(name)` returns `undefined` for a critical workflow label, the conditional `if (id && ...)` pattern silently skips the label assignment. This is correct for optional labels but wrong for labels that are required for the workflow to function (like `needs-human-approval`). The fix is to log a warning when a required label is missing. A stronger fix would be to validate required labels at startup.

## Hotspots

- **`src/agents/proposals.ts`** -- 1st retro appearance. Three of the four critical fixes landed here (path traversal, idempotency, label warnings). The file handles proposal CRUD, label swapping, and comment posting — it's accumulating the same multi-concern pattern as `run-issue.ts`. The label-swap logic is duplicated between `createProposal` (remove agent-ready, add needs-approval) and `approveProposal` (remove needs-approval, add agent-ready). A shared `swapLabels(issue, remove, add)` helper would reduce the duplication.
- **`src/agents/registry.ts`** -- 1st retro appearance. The forbidden-tool bypass and perf fix both landed here. The prefix-matching fix is sound but the `FORBIDDEN_PREFIXES` list is a manual allowlist — if Claude CLI adds new dangerous tool patterns, the list needs manual updates.
- **`src/cli.ts`** -- 7th retro appearance (PR #3, #11, #12, #13, #16, #18, #22). This PR adds 4 new commands (`list-agents`, `pending-proposals`, `approve-agent`). The file continues to grow linearly with each feature. No new instances of the unguarded-parseInt pattern, but the existing debt remains.
- **`src/runner/run-issue.ts`** -- 2nd retro appearance (PR #4, #22). The dispatch + failure-analysis + proposal-creation path adds ~30 lines to the already-long pipeline function. The function now handles fetch, validate, transition, worktree, dispatch, spawn, analyze-failure, create-proposal, validate-output, push, PR, review, and cleanup.
