// Post-agent checks: commits exist, tests pass, lint clean

import { monitoredExecution } from "../lifecycle/execution.ts";
import type { TaskRunnerConfig } from "../types.ts";
import { runValidationCommand } from "./process.ts";
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
export async function validateAgentOutput(
  worktreePath: string,
  defaultBranch: string,
  teamConfig: ProjectConfig,
  issueId: string,
  signal?: AbortSignal,
  diskConfig?: TaskRunnerConfig
): Promise<ValidationResult> {
  if (diskConfig) return await monitoredExecution({ kind: 'validation', path: worktreePath, branch: defaultBranch, project: teamConfig, identifier: issueId }, diskConfig, signal) as ValidationResult;
  if (signal?.aborted) return { valid: false, retryable: false, errors: ['Disk safety cancelled validation'], warnings: [], cancelled: true };
  const errors: string[] = [];
  const warnings: string[] = [];
  let validatedHead: string | undefined;
  let retryable = true;

  // Tests must exercise committed output, not an uncommitted fix that will be
  // absent from the PR. Refuse to discard unfinished output during cleanup.
  function checkCommittedOutput(): void {
    try {
      const status = execGit(["status", "--porcelain", "--untracked-files=normal"], {
        cwd: worktreePath, timeout: 10_000,
      });
      if (status) errors.push("Uncommitted changes remain. Commit the completed task before publishing.");
      const head = execGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeout: 10_000 });
      if (validatedHead && head !== validatedHead) {
        errors.push("HEAD changed during validation. Preserve and triage before retrying.");
        retryable = false;
      }
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
    await runValidationCommand(teamConfig.testCommand, worktreePath, 120_000, signal);
    log("OK", issueId, "Tests passed");
  } catch (err: any) {
    const output = err.stdout?.slice(0, 500) || err.message?.slice(0, 500) || "";
    errors.push(`Tests failed: ${output}`);
  }

  if (signal?.aborted) return { valid: false, retryable: false, errors: [...errors, "Disk safety cancelled validation"], warnings };

  // 3. Run linter
  try {
    await runValidationCommand(teamConfig.lintCommand, worktreePath, 60_000, signal);
    log("OK", issueId, "Lint passed");
  } catch (err: any) {
    const output = err.stdout?.slice(0, 500) || err.message?.slice(0, 500) || "";
    warnings.push(`Lint issues: ${output}`);
  }

  // 4. Run build/type check (if configured)
  if (teamConfig.buildCommand) {
    try {
      await runValidationCommand(teamConfig.buildCommand, worktreePath, 120_000, signal);
      log("OK", issueId, "Build/tsc passed");
    } catch (err: any) {
      const output = err.stdout?.slice(0, 500) || err.message?.slice(0, 500) || "";
      errors.push(`Build failed: ${output}`);
    }
  }

  if (signal?.aborted) return { valid: false, retryable: false, errors: [...errors, "Disk safety cancelled validation"], warnings };
  checkCommittedOutput();

  return {
    valid: errors.length === 0,
    retryable,
    errors,
    warnings,
  };
}
