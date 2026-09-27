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
export function resolveGitDir(repoPath: string): string {
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
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(issueId)) throw new Error("Invalid issue identifier");
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
  branchPrefix?: string,
  reuseBranch = false
): string {
  validateBranchName(defaultBranch);

  const worktreePath = getWorktreePath(repoPath, issueId);
  const branch = getBranchName(issueId, branchPrefix);
  const gitDir = resolveGitDir(repoPath);

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree already exists at ${worktreePath}. Preserve and triage it before retrying; TaskRunner will not overwrite retained output.`);
  }

  // Fetch latest from remote
  execGit(["fetch", "origin"], { cwd: gitDir, timeout: 30_000 });

  // Reuse a preserved recovery branch when recreating a removed checkout.
  const existingBranch = execGit(["branch", "--list", branch], { cwd: gitDir });

  if (existingBranch && !reuseBranch) throw new Error("Existing branch requires explicit lifecycle ownership before reuse");

  // Create worktree with new branch from origin/defaultBranch
  execGit(
    existingBranch
      ? ["worktree", "add", worktreePath, branch]
      : ["worktree", "add", "-b", branch, worktreePath, `origin/${defaultBranch}`],
    { cwd: gitDir, timeout: 30_000 }
  );

  log("INFO", issueId, `Created worktree at ${worktreePath} (branch: ${branch})`);
  return worktreePath;
}
