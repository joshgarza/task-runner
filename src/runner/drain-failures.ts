import { resolveExecutionRoute } from "../execution-route.ts";
import { applyLabelChanges, resolveTeamLabels } from "../linear/labels.ts";
import { addComment } from "../linear/mutations.ts";
import * as comments from "../linear/comments.ts";
import type { LinearIssue, TaskRunnerConfig } from "../types.ts";

export const AGENT_FAILURE_PATTERN = /^🤖 Agent failed/;

export interface DrainFailurePolicy {
  agentLabel: string;
  agentFailedLabel: string;
  maxDrainFailures: number;
}

export interface DrainFailureStatus {
  applies: boolean;
  hasAgentFailedLabel: boolean;
  totalFailureCount: number;
  acknowledgedFailureCount: number;
  failureCount: number;
  shouldQuarantine: boolean;
}

export interface DrainFailureDependencies {
  resolveTeamLabels: typeof resolveTeamLabels;
  applyLabelChanges: typeof applyLabelChanges;
  addComment: typeof addComment;
}

const defaultDependencies: DrainFailureDependencies = {
  resolveTeamLabels,
  applyLabelChanges,
  addComment,
};

export function getDrainFailurePolicy(config: TaskRunnerConfig): DrainFailurePolicy {
  return {
    agentLabel: config.linear.agentLabel,
    agentFailedLabel: config.linear.agentFailedLabel,
    maxDrainFailures: config.defaults.maxDrainFailures,
  };
}

export function countAgentFailures(issueComments: string[]): number {
  return issueComments.filter((body) => AGENT_FAILURE_PATTERN.test(body)).length;
}

export function countAcknowledgedAgentFailures(issueComments: string[]): number {
  const marker = new RegExp(
    `<!-- ${comments.AGENT_FAILURE_QUARANTINE_MARKER}:(\\d+) -->`
  );
  let acknowledged = 0;

  for (const body of issueComments) {
    const match = body.match(marker);
    if (match) acknowledged = Math.max(acknowledged, Number(match[1]));
  }

  return acknowledged;
}

export function getDrainFailureStatus(
  issue: Pick<LinearIssue, "labels" | "comments">,
  policy: DrainFailurePolicy
): DrainFailureStatus {
  const totalFailureCount = countAgentFailures(issue.comments);
  const acknowledgedFailureCount = countAcknowledgedAgentFailures(issue.comments);
  const failureCount = Math.max(0, totalFailureCount - acknowledgedFailureCount);
  const hasAgentFailedLabel = issue.labels.includes(policy.agentFailedLabel);

  let isLocal = false;
  try {
    isLocal = resolveExecutionRoute(issue.labels).route === "local";
  } catch {
    // Invalid routing is rejected by run-issue. Do not mutate it here.
  }

  const applies = isLocal && issue.labels.includes(policy.agentLabel);

  return {
    applies,
    hasAgentFailedLabel,
    totalFailureCount,
    acknowledgedFailureCount,
    failureCount,
    shouldQuarantine:
      applies && !hasAgentFailedLabel && failureCount >= policy.maxDrainFailures,
  };
}

export async function quarantineDrainFailure(
  issue: Pick<LinearIssue, "id" | "teamKey" | "labels" | "comments">,
  policy: DrainFailurePolicy,
  dryRun = false,
  deps: DrainFailureDependencies = defaultDependencies
): Promise<DrainFailureStatus> {
  const status = getDrainFailureStatus(issue, policy);
  if (!status.shouldQuarantine || dryRun) return status;

  const teamLabels = await deps.resolveTeamLabels(issue.teamKey);
  for (const label of [policy.agentLabel, policy.agentFailedLabel]) {
    if (!teamLabels.has(label)) {
      throw new Error(`Label "${label}" not found in team ${issue.teamKey}`);
    }
  }

  await deps.applyLabelChanges(
    issue.id,
    teamLabels,
    [policy.agentFailedLabel],
    [policy.agentLabel],
    false
  );
  await deps.addComment(
    issue.id,
    comments.agentFailureQuarantined({
      failureCount: status.failureCount,
      totalFailureCount: status.totalFailureCount,
      agentLabel: policy.agentLabel,
      agentFailedLabel: policy.agentFailedLabel,
    })
  );

  return status;
}
