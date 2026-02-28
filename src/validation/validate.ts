// Post-agent checks: commits exist, tests pass, lint clean

import { spawnSync } from "node:child_process";
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
    const result = spawnSync(
      "git",
      ["log", `origin/${defaultBranch}..HEAD`, "--oneline"],
      { cwd: worktreePath, timeout: 10_000, encoding: "utf-8" }
    );

    if (result.status !== 0) {
      errors.push(`Failed to check commits: ${result.stderr?.slice(0, 200)}`);
    } else if (!result.stdout.trim()) {
      errors.push("No new commits found. Agent did not commit any changes.");
    } else {
      const commitCount = result.stdout.trim().split("\n").length;
      log("INFO", issueId, `Found ${commitCount} new commit(s)`);
    }
  } catch (err: any) {
    errors.push(`Failed to check commits: ${err.message?.slice(0, 200)}`);
  }

  // 2. Run tests
  {
    const [cmd, ...args] = teamConfig.testCommand.split(/\s+/);
    const result = spawnSync(cmd, args, {
      cwd: worktreePath,
      timeout: 120_000, // 2 minutes for tests
      encoding: "utf-8",
      stdio: "pipe",
    });
    if (result.status !== 0) {
      const output = result.stdout?.slice(0, 500) || result.stderr?.slice(0, 500) || "";
      errors.push(`Tests failed: ${output}`);
    } else {
      log("OK", issueId, "Tests passed");
    }
  }

  // 3. Run linter
  {
    const [cmd, ...args] = teamConfig.lintCommand.split(/\s+/);
    const result = spawnSync(cmd, args, {
      cwd: worktreePath,
      timeout: 60_000,
      encoding: "utf-8",
      stdio: "pipe",
    });
    if (result.status !== 0) {
      const output = result.stdout?.slice(0, 500) || result.stderr?.slice(0, 500) || "";
      warnings.push(`Lint issues: ${output}`);
    } else {
      log("OK", issueId, "Lint passed");
    }
  }

  // 4. Run build/type check (if configured)
  if (teamConfig.buildCommand) {
    const [cmd, ...args] = teamConfig.buildCommand.split(/\s+/);
    const result = spawnSync(cmd, args, {
      cwd: worktreePath,
      timeout: 120_000,
      encoding: "utf-8",
      stdio: "pipe",
    });
    if (result.status !== 0) {
      const output = result.stdout?.slice(0, 500) || result.stderr?.slice(0, 500) || "";
      errors.push(`Build failed: ${output}`);
    } else {
      log("OK", issueId, "Build/tsc passed");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
