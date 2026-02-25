// Drain all "agent-ready" issues with configurable concurrency

import { loadConfig } from "../config.ts";
import { log } from "../logger.ts";
import { acquireLock, releaseLock } from "../lock.ts";
import { fetchAgentReadyIssues, fetchStaleIssues } from "../linear/queries.ts";
import { runIssue } from "./run-issue.ts";
import type { DrainOptions, LinearIssue, RunResult } from "../types.ts";

export async function drain(options: DrainOptions = {}): Promise<RunResult[]> {
  const config = loadConfig();

  const label = options.label ?? config.linear.agentLabel;
  const limit = options.limit ?? 50;
  const concurrency = options.concurrency ?? config.defaults.drainConcurrency;

  if (!acquireLock()) {
    log("WARN", null, "Lock held by another worker, skipping drain");
    return [];
  }

  try {
    // If a specific project is given, only fetch for that project.
    // Otherwise, fetch all agent-ready issues across all projects.
    const projectNames = options.project
      ? [options.project]
      : Object.keys(config.projects);

    // Check for stale in-progress issues (agent-labeled but stuck in In Progress)
    for (const projectName of projectNames) {
      try {
        const stale = await fetchStaleIssues(label, config.linear.inProgressState, projectName);
        for (const issue of stale) {
          log("WARN", issue.identifier, `Stale: "${issue.title}" is In Progress with "${label}" label — may need manual attention (${issue.url})`);
        }
      } catch {
        // Non-fatal — don't block drain over stale check
      }
    }

    // Collect all issues across projects, respecting the limit
    const allIssues: LinearIssue[] = [];
    for (const projectName of projectNames) {
      log("INFO", null, `Fetching "${label}" issues for project "${projectName}"...`);

      let issues;
      try {
        issues = await fetchAgentReadyIssues(label, config.linear.todoState, projectName);
      } catch (err: any) {
        log("ERROR", null, `Failed to fetch issues for "${projectName}": ${err.message}`);
        continue;
      }

      if (issues.length === 0) {
        log("INFO", null, `No "${label}" issues found for "${projectName}"`);
        continue;
      }

      log("INFO", null, `Found ${issues.length} issue(s) for "${projectName}"`);

      for (const issue of issues) {
        if (allIssues.length >= limit) break;
        allIssues.push(issue);
      }

      if (allIssues.length >= limit) {
        log("INFO", null, `Reached limit (${limit}), stopping fetch`);
        break;
      }
    }

    // Handle dry run
    if (options.dryRun) {
      const results: RunResult[] = allIssues.map((issue) => {
        const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
        log("INFO", issue.identifier, `[dry-run] ${issue.title} | project: ${issue.projectName ?? "none"}${labels} (${issue.url})`);
        return {
          issueId: issue.identifier,
          success: true,
          durationMs: 0,
          attempts: 0,
        };
      });
      logSummary(results, true);
      return results;
    }

    // Process issues with concurrency pool
    log("INFO", null, `Processing ${allIssues.length} issue(s) with concurrency ${concurrency}`);
    const results = await runWithConcurrency(allIssues, concurrency);

    logSummary(results, false);
    return results;
  } finally {
    releaseLock();
  }
}

async function runWithConcurrency(
  issues: LinearIssue[],
  concurrency: number
): Promise<RunResult[]> {
  const results: RunResult[] = new Array(issues.length);

  if (concurrency <= 1) {
    // Sequential — preserves original behavior
    for (let i = 0; i < issues.length; i++) {
      results[i] = await processIssue(issues[i]);
    }
    return results;
  }

  // Parallel — process up to `concurrency` issues at a time.
  // Uses indexed assignment so results maintain input order regardless
  // of which worker resolves first.
  let index = 0;

  async function worker(): Promise<void> {
    while (index < issues.length) {
      const i = index++;
      results[i] = await processIssue(issues[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, issues.length) },
    () => worker()
  );
  await Promise.allSettled(workers);

  return results;
}

async function processIssue(issue: LinearIssue): Promise<RunResult> {
  log("INFO", null, `Processing ${issue.identifier}: ${issue.title}`);

  try {
    const result = await runIssue(issue.identifier);

    if (result.success) {
      log("OK", issue.identifier, `Pipeline complete — PR: ${result.prUrl}`);
    } else {
      log("ERROR", issue.identifier, `Pipeline failed: ${result.error}`);
    }

    return result;
  } catch (err: any) {
    log("ERROR", issue.identifier, `Unexpected error: ${err.message}`);
    return {
      issueId: issue.identifier,
      success: false,
      error: err.message,
      durationMs: 0,
      attempts: 0,
    };
  }
}

function logSummary(results: RunResult[], dryRun: boolean): void {
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const suffix = dryRun ? " (dry run)" : "";
  log("INFO", null, `Drain complete${suffix} — ${succeeded} succeeded, ${failed} failed, ${results.length} total`);
}
