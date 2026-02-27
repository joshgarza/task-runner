// Create/remove worktrees in target repo

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../logger.ts";
import { execGit, validateBranchName } from "./exec.ts";

const WORKTREE_DIR = ".task-runner-worktrees";

/**
 * Resolve the git-capable directory from a repoPath.
 * - Traditional repo: repoPath/.git exists → use repoPath
 * - Hub layout: repoPath/main/.git exists → use repoPath/main
 */
function resolveGitDir(repoPath: string): string {
  if (existsSync(resolve(repoPath, ".git"))) {
    return repoPath;
  }
  const hubMain = resolve(repoPath, "main");
  if (existsSync(resolve(hubMain, ".git"))) {
    return hubMain;
  }
  throw new Error(
    `No git repository found at ${repoPath} (checked .git and main/.git)`
  );
}

export function getWorktreePath(repoPath: string, issueId: string): string {
  return resolve(repoPath, WORKTREE_DIR, issueId);
}

export function getBranchName(issueId: string): string {
  return `task-runner/${issueId.toLowerCase()}`;
}

/**
 * Create a worktree for an issue.
 * Creates a new branch from origin/main (or specified default branch).
 */
export function createWorktree(
  repoPath: string,
  issueId: string,
  defaultBranch: string
): string {
  validateBranchName(defaultBranch);

  const worktreePath = getWorktreePath(repoPath, issueId);
  const branch = getBranchName(issueId);
  const gitDir = resolveGitDir(repoPath);

  if (existsSync(worktreePath)) {
    log("WARN", issueId, `Worktree already exists at ${worktreePath}, removing first`);
    removeWorktree(repoPath, issueId);
  }

  // Fetch latest from remote
  execGit(["fetch", "origin"], { cwd: gitDir, timeout: 30_000 });

  // Create worktree with new branch from origin/defaultBranch
  execGit(
    ["worktree", "add", "-b", branch, worktreePath, `origin/${defaultBranch}`],
    { cwd: gitDir, timeout: 30_000 }
  );

  log("INFO", issueId, `Created worktree at ${worktreePath} (branch: ${branch})`);
  return worktreePath;
}

/**
 * Remove a worktree and its local branch.
 * Pass deleteRemote: true to also delete the remote branch (e.g. on failure rollback).
 */
export function removeWorktree(repoPath: string, issueId: string, deleteRemote = false): void {
  const worktreePath = getWorktreePath(repoPath, issueId);
  const branch = getBranchName(issueId);
  const gitDir = resolveGitDir(repoPath);

  try {
    execGit(["worktree", "remove", worktreePath, "--force"], {
      cwd: gitDir,
      timeout: 15_000,
    });
  } catch {
    // May already be removed
  }

  try {
    execGit(["branch", "-D", branch], {
      cwd: gitDir,
      timeout: 10_000,
    });
  } catch {
    // Branch may not exist
  }

  if (deleteRemote) {
    try {
      execGit(["push", "origin", "--delete", branch], {
        cwd: gitDir,
        timeout: 15_000,
      });
    } catch {
      // Remote branch may not exist
    }
  }

  log("INFO", issueId, "Cleaned up worktree and branch");
}
