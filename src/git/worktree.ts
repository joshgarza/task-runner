// Create/remove worktrees in target repo

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../logger.ts";

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

export function getBranchName(issueId: string, prefix = "task-runner"): string {
  return `${prefix}/${issueId.toLowerCase()}`;
}

/**
 * Create a worktree for an issue.
 * Creates a new branch from origin/main (or specified default branch).
 */
export function createWorktree(
  repoPath: string,
  issueId: string,
  defaultBranch: string,
  branchPrefix?: string
): string {
  const worktreePath = getWorktreePath(repoPath, issueId);
  const branch = getBranchName(issueId, branchPrefix);
  const gitDir = resolveGitDir(repoPath);

  if (existsSync(worktreePath)) {
    log("WARN", issueId, `Worktree already exists at ${worktreePath}, removing first`);
    removeWorktree(repoPath, issueId, false, branchPrefix);
  }

  // Fetch latest from remote
  execSync("git fetch origin", {
    cwd: gitDir,
    timeout: 30_000,
    encoding: "utf-8",
  });

  // Create worktree with new branch from origin/defaultBranch
  execSync(
    `git worktree add -b "${branch}" "${worktreePath}" "origin/${defaultBranch}"`,
    {
      cwd: gitDir,
      timeout: 30_000,
      encoding: "utf-8",
    }
  );

  log("INFO", issueId, `Created worktree at ${worktreePath} (branch: ${branch})`);
  return worktreePath;
}

/**
 * Remove a worktree and its local branch.
 * Pass deleteRemote: true to also delete the remote branch (e.g. on failure rollback).
 */
export function removeWorktree(repoPath: string, issueId: string, deleteRemote = false, branchPrefix?: string): void {
  const worktreePath = getWorktreePath(repoPath, issueId);
  const branch = getBranchName(issueId, branchPrefix);
  const gitDir = resolveGitDir(repoPath);

  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: gitDir,
      timeout: 15_000,
      encoding: "utf-8",
    });
  } catch {
    // May already be removed
  }

  try {
    execSync(`git branch -D "${branch}"`, {
      cwd: gitDir,
      timeout: 10_000,
      encoding: "utf-8",
    });
  } catch {
    // Branch may not exist
  }

  if (deleteRemote) {
    try {
      execSync(`git push origin --delete "${branch}"`, {
        cwd: gitDir,
        timeout: 15_000,
        encoding: "utf-8",
      });
    } catch {
      // Remote branch may not exist
    }
  }

  log("INFO", issueId, "Cleaned up worktree and branch");
}
