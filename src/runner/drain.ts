// Loop through all "agent-ready" issues sequentially

import { loadConfig } from "../config.ts";
import { log } from "../logger.ts";
import { acquireLock, releaseLock } from "../lock.ts";
import { fetchAgentReadyIssues, fetchStaleIssues } from "../linear/queries.ts";
import { runIssue } from "./run-issue.ts";
import type { DrainOptions, RunResult } from "../types.ts";

export async function drain(options: DrainOptions = {}): Promise<RunResult[]> {
  const config = loadConfig();

  const label = options.label ?? config.linear.agentLabel;
  const limit = options.limit ?? 50;

  if (!acquireLock()) {
    log("WARN", null, "Lock held by another worker, skipping drain");
    return [];
  }

  const results: RunResult[] = [];

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
        if (results.length >= limit) {
          log("INFO", null, `Reached limit (${limit}), stopping`);
          break;
        }

        if (options.dryRun) {
          const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
          log("INFO", issue.identifier, `[dry-run] ${issue.title} | project: ${issue.projectName ?? "none"}${labels} (${issue.url})`);
          results.push({
            issueId: issue.identifier,
            success: true,
            durationMs: 0,
            attempts: 0,
          });
          continue;
        }

        log("INFO", null, `Processing ${issue.identifier}: ${issue.title}`);

        try {
          const result = await runIssue(issue.identifier);
          results.push(result);

          if (result.success) {
            log("OK", issue.identifier, `Pipeline complete — PR: ${result.prUrl}`);
          } else {
            log("ERROR", issue.identifier, `Pipeline failed: ${result.error}`);
          }
        } catch (err: any) {
          log("ERROR", issue.identifier, `Unexpected error: ${err.message}`);
          results.push({
            issueId: issue.identifier,
            success: false,
            error: err.message,
            durationMs: 0,
            attempts: 0,
          });
        }
      }
    }

    // Summary
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const suffix = options.dryRun ? " (dry run)" : "";
    log("INFO", null, `Drain complete${suffix} — ${succeeded} succeeded, ${failed} failed, ${results.length} total`);
  } finally {
    releaseLock();
  }

  return results;
}
