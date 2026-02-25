# PR Review Retro: PR #6 — feat: Add cron scripts for drain and standup
**Date**: 2026-02-24 | **Branch**: feat/cron-setup | **Findings**: 2 bugs, 1 suggestion

## What Was Found

Both cron wrapper scripts (`scripts/cron-drain.sh`, `scripts/cron-standup.sh`) used `set -euo pipefail` but ran the main `node` command without capturing its exit code. If the command failed, `set -e` terminated the script immediately, so the "finished" log marker was never written. This made failures invisible in the logs -- you would see a "started" line with no corresponding "finished" line and no exit code. A separate suggestion flagged the hardcoded nvm path (`v24.12.0`), which will silently break on the next node upgrade.

## Root Cause

**Technical why chain:**
1. The "finished" log marker was never written on failure.
2. Because `set -euo pipefail` exits the script immediately on any non-zero command.
3. Because the `node ... drain` command was called bare, without `|| rc=$?` to absorb the non-zero exit.
4. Because `set -euo pipefail` was applied as a defensive default (which is correct) without accounting for the interaction with log-bookending (start/finish markers around a command that can fail).

**Systemic cause:** `set -e` is a global behavior modifier that changes error semantics for every subsequent command. Any pattern that requires guaranteed completion after a potentially-failing command -- log markers, temp file cleanup, metric emission -- must explicitly guard against `set -e` by capturing the exit code (`|| rc=$?`) or using a `trap`. This is the shell equivalent of the "single-owner cleanup" lesson from PR #4: cleanup/observability code must not depend on normal flow continuing after a failure.

## Fixes Applied

- **Exit code capture (both scripts):** Wrapped the `node` command with `rc=0; ... || rc=$?` so the log block always completes. The "finished" marker now includes the exit code (`exit=$rc`). The captured code is propagated via `exit $rc` so cron can still detect failures for error notifications. Applied in commit `a4a1d17`.

## Deferred

- **Hardcoded nvm path (`v24.12.0`):** The path will break on the next node upgrade. Suggested alternatives: `$(dirname "$(readlink -f "$(which node)")")` or sourcing `$NVM_DIR/nvm.sh`. Skipped as non-critical -- the scripts work today and the breakage will be immediately obvious (command not found). Revisit trigger: next node version upgrade.

## Lessons Encoded

- **MEMORY.md addition:** Added a bullet about `set -e` interaction with observability/cleanup patterns in shell scripts. This generalizes the PR #4 "single-owner cleanup" lesson to the shell domain.

## Hotspots

- `scripts/cron-drain.sh` and `scripts/cron-standup.sh` -- new files, first appearance. Both scripts are near-identical (same structure, differ only in command name and log file). If a third cron command is added, consider extracting a shared `cron-wrapper.sh` that takes the command and log file as arguments.
