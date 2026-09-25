// Post-agent checks: commits exist, tests pass, lint clean

import { execSync } from "node:child_process";
import { log } from "../logger.ts";
import { execGit, validateBranchName } from "../git/exec.ts";
import type { ValidationResult, ProjectConfig } from "../types.ts";

/**
 * Validate that the agent produced meaningful output:
 * - New commits exist beyond the base branch
 * - Tests pass
 * - Lint passes
 * - TypeScript compiles (if buildCommand configured)
 */
export function validateAgentOutput(
  worktreePath: string,
  defaultBranch: string,
  teamConfig: ProjectConfig,
  issueId: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let validatedHead: string | undefined;

  // Tests must exercise committed output, not an uncommitted fix that will be
  // absent from the PR. Refuse to discard unfinished output during cleanup.
  function checkCommittedOutput(): void {
    try {
      const status = execGit(["status", "--porcelain", "--untracked-files=normal"], {
        cwd: worktreePath, timeout: 10_000,
      });
      if (status) errors.push("Uncommitted changes remain. Commit the completed task before publishing.");
      const head = execGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeout: 10_000 });
      if (validatedHead && head !== validatedHead) errors.push("HEAD changed during validation.");
      validatedHead ??= head;
    } catch (err: any) {
      errors.push(`Failed to verify committed output: ${err.message?.slice(0, 200)}`);
    }
  }

  checkCommittedOutput();

  // 1. Check for new commits
  try {
    validateBranchName(defaultBranch);
    const commits = execGit(
      ["log", `origin/${defaultBranch}..HEAD`, "--oneline"],
      { cwd: worktreePath, timeout: 10_000 }
    );

    if (!commits) {
      errors.push("No new commits found. Agent did not commit any changes.");
    } else {
      const commitCount = commits.split("\n").length;
      log("INFO", issueId, `Found ${commitCount} new commit(s)`);
    }
  } catch (err: any) {
    errors.push(`Failed to check commits: ${err.message?.slice(0, 200)}`);
  }

  // 2. Run tests
  try {
    execSync(teamConfig.testCommand, {
      cwd: worktreePath,
      timeout: 120_000, // 2 minutes for tests
      encoding: "utf-8",
      stdio: "pipe",
    });
    log("OK", issueId, "Tests passed");
  } catch (err: any) {
    const output = err.stdout?.slice(0, 500) || err.message?.slice(0, 500) || "";
    errors.push(`Tests failed: ${output}`);
  }

  // 3. Run linter
  try {
    execSync(teamConfig.lintCommand, {
      cwd: worktreePath,
      timeout: 60_000,
      encoding: "utf-8",
      stdio: "pipe",
    });
    log("OK", issueId, "Lint passed");
  } catch (err: any) {
    const output = err.stdout?.slice(0, 500) || err.message?.slice(0, 500) || "";
    warnings.push(`Lint issues: ${output}`);
  }

  // 4. Run build/type check (if configured)
  if (teamConfig.buildCommand) {
    try {
      execSync(teamConfig.buildCommand, {
        cwd: worktreePath,
        timeout: 120_000,
        encoding: "utf-8",
        stdio: "pipe",
      });
      log("OK", issueId, "Build/tsc passed");
    } catch (err: any) {
      const output = err.stdout?.slice(0, 500) || err.message?.slice(0, 500) || "";
      errors.push(`Build failed: ${output}`);
    }
  }

  checkCommittedOutput();

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
