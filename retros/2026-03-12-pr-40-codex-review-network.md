# PR Review Retro: PR #40 -- Migrate task-runner to Codex SDK
**Date**: 2026-03-12 | **Branch**: feat/codex-pr1 | **Findings**: 1 bug

## What Was Found

The Codex migration initially disabled network access for every agent type in `src/agents/spawn.ts`. That preserved the old worker safety intent, but it broke the review flows: both the standalone `review` command and the PR review step rely on GitHub CLI and API calls to inspect PR metadata and diffs. With network disabled universally, reviewer agents could be launched successfully but fail to perform their core job.

## Root Cause

- **Technical**: The provider migration translated Claude's generic "no network" guardrail into a global Codex SDK setting instead of mapping it per agent type. The old implementation had tool-level restrictions, while the new implementation moved enforcement to sandbox configuration. The migration preserved the restriction but lost the nuance.
- **Why the regression slipped through**: Verification covered imports, existing unit tests, and dry-run CLI paths, but not an end-to-end reviewer execution path. The one agent type that truly needs network, `reviewer`, was not exercised after the provider swap.
- **Design assumption**: "Reviewers are read-only, therefore they do not need network." That is false in this codebase because review context comes from GitHub, not only from the local checkout.

## Fixes Applied

- **Reviewer-specific network access enabled:** `src/agents/spawn.ts` now derives `networkAccessEnabled` from the agent type and allows it only for `reviewer`. Workers and context agents remain network-disabled.
- **Provider logging improved:** the spawn log line now records whether network access is enabled for the current agent profile.

## Deferred

- **Automated coverage for provider profiles:** there is still no unit test that asserts sandbox and network behavior per agent type. Revisit trigger: next change to `spawn.ts` or agent profile behavior.

## Lessons Encoded

### 1. Preserve agent-type capability nuance when moving enforcement layers
When a migration replaces fine-grained tool restrictions with coarser sandbox settings, capability decisions must be remapped per agent type, not applied globally. This lesson is encoded directly in `src/agents/spawn.ts` via `resolveNetworkAccess()` and the surrounding comment.

## Hotspots

- **`src/agents/spawn.ts`** -- first retro appearance in this repo. It is now the primary migration seam for agent runtime behavior and should be treated as a high-risk file for future changes.
