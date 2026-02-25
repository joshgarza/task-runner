// Post-agent checks: commits exist, tests pass, lint clean

import { execSync } from "node:child_process";
import { log } from "../logger.ts";
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

  // 1. Check for new commits
  try {
    const commits = execSync(
      `git log "origin/${defaultBranch}..HEAD" --oneline`,
      { cwd: worktreePath, timeout: 10_000, encoding: "utf-8" }
    ).trim();

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

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
