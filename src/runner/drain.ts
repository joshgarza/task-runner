// Drain all "agent-ready" issues with configurable concurrency

import { loadConfig } from "../config.ts";
import { log } from "../logger.ts";
import { acquireLock, releaseLock } from "../lock.ts";
import { fetchAgentReadyIssues, fetchStaleIssues, fetchForwardBlockCount } from "../linear/queries.ts";
import { runIssue } from "./run-issue.ts";
import { runWithConcurrency } from "../concurrency.ts";
import { resolveExecutionRoute } from "../execution-route.ts";
import {
  getDrainFailurePolicy,
  getDrainFailureStatus,
  quarantineDrainFailure,
} from "./drain-failures.ts";
import type { DrainOptions, LinearIssue, RunResult } from "../types.ts";

export async function drain(options: DrainOptions = {}): Promise<RunResult[]> {
  const config = loadConfig();

  const label = options.label ?? config.linear.agentLabel;
  const limit = options.limit ?? 50;
  const concurrency = options.concurrency ?? config.defaults.drainConcurrency;
  const drainFailurePolicy = getDrainFailurePolicy(config);

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
          if (!isLocalStaleIssue(issue)) continue;
          log("WARN", issue.identifier, `Stale: "${issue.title}" is In Progress with "${label}" label — may need manual attention (${issue.url})`);
        }
      } catch {
        // Non-fatal — don't block drain over stale check
      }
    }

    // Collect all issues across projects, respecting the limit
    // Query both Todo and Backlog — matches the valid states in run-issue.ts
    const fetchStates = [config.linear.todoState, "Backlog"];
    const allIssues: LinearIssue[] = [];
    for (const projectName of projectNames) {
      log("INFO", null, `Fetching "${label}" issues for project "${projectName}"...`);

      let issues;
      try {
        issues = await fetchAgentReadyIssues(
          label,
          fetchStates,
          projectName,
          label === config.linear.agentLabel ? config.linear.agentFailedLabel : undefined
        );
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

    // Dry runs report queue removals but never mutate Linear.
    if (options.dryRun) {
      const results: RunResult[] = allIssues.map((issue) => {
        const status = getDrainFailureStatus(issue, drainFailurePolicy);
        if (status.shouldQuarantine) {
          log(
            "INFO",
            issue.identifier,
            `[dry-run] Would skip and remove from queue after ${status.failureCount} failed run(s); requires human triage (${issue.url})`
          );
        } else {
          const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
          log("INFO", issue.identifier, `[dry-run] ${issue.title} | project: ${issue.projectName ?? "none"}${labels} (${issue.url})`);
        }

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

    // Quarantine exhausted local queue items before prioritizing runnable work.
    const runnableIssues: LinearIssue[] = [];
    const quarantineResults: RunResult[] = [];
    for (const issue of allIssues) {
      const status = getDrainFailureStatus(issue, drainFailurePolicy);
      if (!status.shouldQuarantine) {
        runnableIssues.push(issue);
        continue;
      }

      try {
        await quarantineDrainFailure(issue, drainFailurePolicy);
        log("WARN", issue.identifier, `Removed from agent queue after ${status.failureCount} failed run(s); requires human triage`);
        quarantineResults.push({
          issueId: issue.identifier,
          success: true,
          durationMs: 0,
          attempts: 0,
        });
      } catch (err: any) {
        log("ERROR", issue.identifier, `Failed to remove from agent queue: ${err.message}`);
        quarantineResults.push({
          issueId: issue.identifier,
          success: false,
          error: err.message,
          durationMs: 0,
          attempts: 0,
        });
      }
    }

    // Prioritize: sort by forward block count (most-blocking first)
    if (runnableIssues.length > 1) {
      try {
        log("INFO", null, "Fetching dependency counts for prioritization...");
        const blockCounts = await Promise.all(
          runnableIssues.map((issue) => fetchForwardBlockCount(issue.id))
        );

        // Build indexed pairs and stable-sort descending by block count
        const indexed = runnableIssues.map((issue, i) => ({ issue, blockCount: blockCounts[i], originalIndex: i }));
        indexed.sort((a, b) => b.blockCount - a.blockCount || a.originalIndex - b.originalIndex);

        // Replace runnableIssues in-place with sorted order
        for (let i = 0; i < indexed.length; i++) {
          runnableIssues[i] = indexed[i].issue;
        }

        // Log prioritized order
        for (let i = 0; i < indexed.length; i++) {
          const entry = indexed[i];
          const suffix = entry.blockCount > 0 ? ` (blocks ${entry.blockCount} issue(s))` : "";
          log("INFO", entry.issue.identifier, `Priority #${i + 1}: ${entry.issue.title}${suffix}`);
        }
      } catch (err: any) {
        log("WARN", null, `Failed to fetch dependency counts, proceeding with original order: ${err.message}`);
      }
    }

    // Process issues with concurrency pool
    log("INFO", null, `Processing ${runnableIssues.length} issue(s) with concurrency ${concurrency}`);
    const processedResults = await runWithConcurrency(runnableIssues, concurrency, processIssue);
    const results = [...quarantineResults, ...processedResults];

    logSummary(results, false);
    return results;
  } finally {
    releaseLock();
  }
}

async function processIssue(issue: LinearIssue): Promise<RunResult> {
  log("INFO", null, `Processing ${issue.identifier}: ${issue.title}`);

  try {
    const result = await runIssue(issue.identifier);

    if (result.success) {
      log("OK", issue.identifier, formatSuccessfulRun(result));
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

export function isLocalStaleIssue(issue: Pick<LinearIssue, "labels">): boolean {
  try {
    return resolveExecutionRoute(issue.labels).route !== "cloud";
  } catch {
    return true;
  }
}

export function formatSuccessfulRun(result: RunResult): string {
  if (result.executionRoute === "cloud") {
    return "Cloud delegation complete";
  }
  return result.prUrl ? `Pipeline complete: PR ${result.prUrl}` : "Pipeline complete";
}

function logSummary(results: RunResult[], dryRun: boolean): void {
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const suffix = dryRun ? " (dry run)" : "";
  log("INFO", null, `Drain complete${suffix} — ${succeeded} succeeded, ${failed} failed, ${results.length} total`);
}
