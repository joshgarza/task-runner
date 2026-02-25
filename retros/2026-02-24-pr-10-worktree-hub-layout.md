# PR Review Retro: PR #10 — fix: resolve git dir for hub-based bare repo layouts
**Date**: 2026-02-24 | **Branch**: fix/worktree-hub-layout-detection | **Findings**: 0 (clean)

## What Was Found

Clean review. The `resolveGitDir()` helper correctly detects both traditional repos (`.git` at root) and hub layouts (`.git` at `repoPath/main/`). All five `cwd` references in `createWorktree()` and `removeWorktree()` are updated consistently. `getWorktreePath()` correctly continues using raw `repoPath` since worktrees should live under the hub directory, not under `main/`.

## Root Cause

The original code assumed `repoPath` from config always points to a directory that is itself a git repository. In the hub/bare-repo layout used by this project, `repoPath` points to the hub directory (e.g., `/home/josh/coding/claude/task-runner/`) which contains worktrees but is not itself a git repo. The actual git-capable directory is `repoPath/main/`.

## Fixes Applied

- None needed -- review was clean.

## Deferred

- `review.ts` line 77 also uses `projectConfig.repoPath` as `cwd` for spawning the review agent. In a hub layout this puts the agent in a non-git directory, but `gh` PR commands don't strictly require a git repo, so this works today. Worth noting if review agent failures surface later.

## Lessons Encoded

- None -- straightforward fix with clear root cause, no systemic pattern to encode.

## Hotspots

- None. First retro appearance of `src/git/worktree.ts`.
