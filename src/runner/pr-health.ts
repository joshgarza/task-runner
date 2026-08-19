// Reconcile Linear issues with GitHub PR status

import { spawnSync } from "node:child_process";
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

export interface PrSnapshot {
  url: string;
  state: string;
  createdAt: string;
}

const RUNNER_COMMENT_PR_REGEX =
  /(?:^|\n)🤖 PR created:\s*(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)(?=\s|$)/g;
const RUNNER_DESCRIPTION_PR_REGEX =
  /(?:^|\n)PR:\s*(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)(?=\s|$)/g;

/**
 * Extract only the PR URL markers written by run-issue.ts.
 * Other PR URLs may be ordinary ticket context and must not veto reconciliation.
 */
export function extractPrUrls(
  comments: string[],
  description: string | null = null
): string[] {
  const urls: string[] = [];

  if (description) {
    for (const match of description.matchAll(RUNNER_DESCRIPTION_PR_REGEX)) {
      urls.push(match[1]);
    }
  }

  for (const comment of comments) {
    for (const match of comment.matchAll(RUNNER_COMMENT_PR_REGEX)) {
      urls.push(match[1]);
    }
  }

  return urls;
}

/**
 * Check PR state and creation time via gh CLI.
 */
function getPrSnapshot(prUrl: string): PrSnapshot | null {
  const result = spawnSync("gh", ["pr", "view", prUrl, "--json", "state,createdAt"], {
    timeout: 15_000,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    log("WARN", "pr-health", `Failed to check PR state for ${prUrl}: ${stderr}`);
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    if (!parsed.state || !parsed.createdAt) {
      log("WARN", "pr-health", `Missing PR state or creation time for ${prUrl}`);
      return null;
    }
    return { url: prUrl, state: parsed.state, createdAt: parsed.createdAt };
  } catch {
    log("WARN", "pr-health", `Failed to parse PR metadata JSON for ${prUrl}`);
    return null;
  }
}

export function selectNewestPr(snapshots: PrSnapshot[]): PrSnapshot | null {
  if (snapshots.length === 0) return null;
  return snapshots.reduce((newest, candidate) =>
    Date.parse(candidate.createdAt) > Date.parse(newest.createdAt) ? candidate : newest
  );
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
    const prUrls = extractPrUrls(issue.comments, issue.description);

    if (prUrls.length === 0) {
      log("INFO", issue.identifier, `${prefix}No PR URL found on issue, skipping`);
      continue;
    }

    const snapshots: PrSnapshot[] = [];
    let metadataComplete = true;
    for (const prUrl of new Set(prUrls)) {
      const snapshot = getPrSnapshot(prUrl);
      if (!snapshot) {
        metadataComplete = false;
        log("WARN", issue.identifier, `${prefix}Could not determine PR metadata for ${prUrl}`);
        break;
      }
      snapshots.push(snapshot);
    }

    if (!metadataComplete) {
      continue;
    }

    const newestPr = selectNewestPr(snapshots);
    if (!newestPr) continue;
    const { url: prUrl, state: prState } = newestPr;

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
