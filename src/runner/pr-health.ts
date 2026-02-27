// Reconcile Linear issues with GitHub PR status

import { execSync } from "node:child_process";
import { loadConfig } from "../config.ts";
import { log } from "../logger.ts";
import { fetchFilteredIssues } from "../linear/queries.ts";
import { transitionIssue, addComment, setIssueLabels } from "../linear/mutations.ts";
import { resolveTeamLabels, collectAllNodes } from "../linear/labels.ts";
import { getLinearClient } from "../linear/client.ts";
import type { LinearIssue } from "../types.ts";

export interface PrHealthOptions {
  team: string;
  project?: string;
  dryRun?: boolean;
}

export interface PrHealthResult {
  identifier: string;
  title: string;
  prUrl: string;
  prState: string;
  action: "transitioned-done" | "transitioned-todo" | "skipped";
  reason: string;
}

const PR_URL_REGEX = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/;

/**
 * Extract PR URLs from Linear issue comments.
 * Matches the format used by run-issue.ts: "PR created: <url>"
 */
function extractPrUrls(comments: string[]): string[] {
  const urls: string[] = [];
  for (const comment of comments) {
    const match = comment.match(PR_URL_REGEX);
    if (match) {
      urls.push(match[0]);
    }
  }
  return urls;
}

/**
 * Check PR state via gh CLI. Returns "MERGED", "CLOSED", or "OPEN".
 */
function getPrState(prUrl: string): string | null {
  try {
    const result = execSync(`gh pr view "${prUrl}" --json state`, {
      timeout: 15_000,
      encoding: "utf-8",
    });
    const parsed = JSON.parse(result.trim());
    return parsed.state ?? null;
  } catch (err: any) {
    log("WARN", "pr-health", `Failed to check PR state for ${prUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Check if a comment with the given prefix already exists on the issue.
 * Used for idempotency: avoids posting duplicate comments.
 */
async function hasCommentWithPrefix(issueId: string, prefix: string): Promise<boolean> {
  const client = getLinearClient();
  const issue = await client.issue(issueId);
  const commentsConn = await issue.comments({ first: 250 });
  const allComments = await collectAllNodes(commentsConn);
  return allComments.some((c: any) => c.body?.startsWith(prefix));
}

/**
 * Remove the agent-ready label from an issue (if present).
 */
async function removeAgentLabel(
  issue: LinearIssue,
  agentLabelName: string,
  agentLabelId: string | undefined,
  dryRun: boolean
): Promise<boolean> {
  if (!agentLabelId) return false;
  if (!issue.labels.includes(agentLabelName)) return false;

  if (dryRun) return true;

  const client = getLinearClient();
  const fullIssue = await client.issue(issue.id);
  const labelsConn = await fullIssue.labels({ first: 250 });
  const allLabels = await collectAllNodes(labelsConn);
  const currentLabelIds = allLabels.map((l: any) => l.id);
  const newLabelIds = currentLabelIds.filter((id: string) => id !== agentLabelId);

  if (newLabelIds.length < currentLabelIds.length) {
    await setIssueLabels(issue.id, newLabelIds);
    return true;
  }
  return false;
}

/**
 * Poll Linear issues in In Review / In Progress, check their linked PRs,
 * and reconcile state accordingly.
 */
export async function prHealth(options: PrHealthOptions): Promise<PrHealthResult[]> {
  const config = loadConfig();
  const dryRun = options.dryRun ?? false;
  const prefix = dryRun ? "[dry-run] " : "";

  // Fetch issues in In Review and In Progress states
  const stateNames = [config.linear.inReviewState, config.linear.inProgressState];
  const issues = await fetchFilteredIssues({
    teamKey: options.team,
    stateNames,
    projectName: options.project,
    includeComments: true,
  });

  if (issues.length === 0) {
    log("INFO", "pr-health", `${prefix}No issues in ${stateNames.join(" / ")} states`);
    return [];
  }

  log("INFO", "pr-health", `${prefix}Found ${issues.length} issue(s) to check`);

  // Resolve the agent-ready label ID for removal
  const teamLabels = await resolveTeamLabels(options.team);
  const agentLabelId = teamLabels.get(config.linear.agentLabel);

  const results: PrHealthResult[] = [];

  for (const issue of issues) {
    const prUrls = extractPrUrls(issue.comments);

    if (prUrls.length === 0) {
      log("INFO", issue.identifier, `${prefix}No PR URL found in comments, skipping`);
      continue;
    }

    // Use the last PR URL (most recent)
    const prUrl = prUrls[prUrls.length - 1];
    const prState = getPrState(prUrl);

    if (!prState) {
      log("WARN", issue.identifier, `${prefix}Could not determine PR state for ${prUrl}`);
      continue;
    }

    if (prState === "OPEN") {
      log("INFO", issue.identifier, `${prefix}PR is still open: ${prUrl}`);
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        prUrl,
        prState,
        action: "skipped",
        reason: "PR still open",
      });
      continue;
    }

    if (prState === "MERGED") {
      // Check idempotency: don't transition if already Done
      if (issue.stateName === config.linear.doneState) {
        log("INFO", issue.identifier, `${prefix}Already in ${config.linear.doneState}, skipping`);
        results.push({
          identifier: issue.identifier,
          title: issue.title,
          prUrl,
          prState,
          action: "skipped",
          reason: `Already in ${config.linear.doneState}`,
        });
        continue;
      }

      // Check idempotency: don't post duplicate comment
      const commentPrefix = "PR merged:";
      const alreadyCommented = await hasCommentWithPrefix(issue.id, commentPrefix);

      if (!dryRun) {
        await transitionIssue(issue.id, issue.teamKey, config.linear.doneState);
        if (!alreadyCommented) {
          await addComment(issue.id, `${commentPrefix} ${prUrl}`);
        }
      }

      log("OK", issue.identifier, `${prefix}PR merged, transitioned to ${config.linear.doneState}`);
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        prUrl,
        prState,
        action: "transitioned-done",
        reason: `PR merged, transitioned to ${config.linear.doneState}`,
      });
      continue;
    }

    if (prState === "CLOSED") {
      // Check idempotency: don't transition if already in Todo
      if (issue.stateName === config.linear.todoState) {
        log("INFO", issue.identifier, `${prefix}Already in ${config.linear.todoState}, skipping`);
        results.push({
          identifier: issue.identifier,
          title: issue.title,
          prUrl,
          prState,
          action: "skipped",
          reason: `Already in ${config.linear.todoState}`,
        });
        continue;
      }

      // Check idempotency: don't post duplicate comment
      const commentPrefix = "PR closed:";
      const alreadyCommented = await hasCommentWithPrefix(issue.id, commentPrefix);

      const removedLabel = await removeAgentLabel(issue, config.linear.agentLabel, agentLabelId, dryRun);

      if (!dryRun) {
        await transitionIssue(issue.id, issue.teamKey, config.linear.todoState);
        if (!alreadyCommented) {
          await addComment(issue.id, `${commentPrefix} ${prUrl} (closed without merging)`);
        }
      }

      const labelNote = removedLabel ? ", removed agent-ready label" : "";
      log("OK", issue.identifier, `${prefix}PR closed without merge, transitioned to ${config.linear.todoState}${labelNote}`);
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        prUrl,
        prState,
        action: "transitioned-todo",
        reason: `PR closed without merge, transitioned to ${config.linear.todoState}${labelNote}`,
      });
      continue;
    }

    // Unknown state
    log("WARN", issue.identifier, `${prefix}Unknown PR state: ${prState}`);
  }

  return results;
}
