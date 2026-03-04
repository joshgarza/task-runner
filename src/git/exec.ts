// Shell-safe git command execution helpers

import { execFileSync } from "node:child_process";

const BRANCH_NAME_RE = /^[A-Za-z0-9._\-/]+$/;

/**
 * Validate that a branch name contains only safe characters.
 * Rejects names with shell metacharacters (;, &, |, $, `, etc.).
 */
export function validateBranchName(name: string): void {
  if (!name || !BRANCH_NAME_RE.test(name)) {
    throw new Error(
      `Invalid branch name: "${name}". Must match ${BRANCH_NAME_RE}`
    );
  }
}

export interface ExecGitOptions {
  cwd?: string;
  timeout?: number;
}

/**
 * Execute a git command safely using execFileSync (no shell interpolation).
 * Arguments are passed directly to the git binary, preventing command injection.
 */
export function execGit(
  args: string[],
  opts: ExecGitOptions = {}
): string {
  return execFileSync("git", args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 30_000,
    encoding: "utf-8",
  }).trim();
}

/**
 * Execute a gh CLI command safely using execFileSync (no shell interpolation).
 * Arguments are passed directly to the gh binary, preventing command injection.
 */
export function execGh(
  args: string[],
  opts: ExecGitOptions = {}
): string {
  return execFileSync("gh", args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 30_000,
    encoding: "utf-8",
  }).trim();
}
