// Formatted comment builders for Linear
//
// Each function takes typed parameters and returns a markdown string.
// The addComment function in mutations.ts stays unchanged as the transport layer.

import type { ContextResult } from "../types.ts";

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/**
 * Sentinel string used by organize-tickets.ts for idempotency checking.
 * If this changes, update the check in organize-tickets.ts too.
 */
export const CONTEXT_SENTINEL = "## Codebase Context (auto-generated)";
export const AGENT_FAILURE_QUARANTINE_MARKER = "agent-failures-quarantined";

export function startWork(opts: {
  identifier: string;
  title: string;
  executionRoute: string;
  model: string;
  reasoningEffort: string;
  maxAttempts: number;
}): string {
  return [
    `## Agent Starting Work`,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Issue** | ${opts.identifier}: ${opts.title} |`,
    `| **Execution** | \`${opts.executionRoute}\` |`,
    `| **Model** | \`${opts.model}\` |`,
    `| **Reasoning** | \`${opts.reasoningEffort}\` |`,
    `| **Max attempts** | ${opts.maxAttempts} |`,
    `| **Started** | ${timestamp()} |`,
  ].join("\n");
}

export function prCreated(opts: {
  prUrl: string;
  commitCount: number;
  filesChanged: number;
}): string {
  return [
    `## PR Created`,
    ``,
    `**Link:** [${opts.prUrl}](${opts.prUrl})`,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Commits** | ${opts.commitCount} |`,
    `| **Files changed** | ${opts.filesChanged} |`,
  ].join("\n");
}

export function agentFailed(opts: {
  attempts: number;
  maxAttempts: number;
  errors: string;
}): string {
  return [
    `## Agent Failed`,
    ``,
    `All ${opts.maxAttempts} attempt(s) exhausted.`,
    ``,
    `### Errors`,
    ``,
    "```",
    opts.errors.slice(0, 2000),
    "```",
    ``,
    `| | |`,
    `|---|---|`,
    `| **Attempts** | ${opts.attempts}/${opts.maxAttempts} |`,
    `| **Time** | ${timestamp()} |`,
    ``,
    `### Next Steps`,
    ``,
    `- Review the errors above and update the ticket description with more context`,
    `- Check whether the issue should use local, cloud, or human-gated execution`,
    `- Re-queue by moving the ticket back to **Todo** with the \`agent-ready\` label`,
  ].join("\n");
}

export function nativeReviewRequested(opts: {
  prUrl: string;
  requested: boolean;
  error?: string;
}): string {
  if (opts.requested) {
    return [
      "## Native Codex Review Requested",
      "",
      `Codex was asked to review [the pull request](${opts.prUrl}) on GitHub. Review feedback and discussion stay on the PR.`,
    ].join("\n");
  }

  return [
    "## Native Codex Review Request Failed",
    "",
    `The pull request is ready for review, but TaskRunner could not post the Codex review request: ${opts.error ?? "unknown error"}`,
    "",
    `**PR:** [${opts.prUrl}](${opts.prUrl})`,
  ].join("\n");
}

export function rollback(opts: {
  error: string;
  attempts: number;
  countAsAgentFailure?: boolean;
}): string {
  return [
    opts.countAsAgentFailure === false
      ? `## Cloud Delegation Failed, Rolled Back to Todo`
      : `🤖 Agent failed, rolled back to Todo`,
    ``,
    `### Error`,
    ``,
    "```",
    opts.error.slice(0, 2000),
    "```",
    ``,
    `| | |`,
    `|---|---|`,
    `| **Attempts** | ${opts.attempts} |`,
    `| **Time** | ${timestamp()} |`,
    ``,
    `### Next Steps`,
    ``,
    `- Review the error and update the ticket with additional context`,
    `- If the work requires operations access, route it to human-gated ops`,
    `- Re-queue by adding the \`agent-ready\` label`,
  ].join("\n");
}

export function agentFailureQuarantined(opts: {
  failureCount: number;
  totalFailureCount: number;
  agentLabel: string;
  agentFailedLabel: string;
}): string {
  return [
    `## Removed from Agent Queue`,
    ``,
    `Agent failed ${opts.failureCount} times, removing from queue. Requires human triage.`,
    ``,
    `The \`${opts.agentFailedLabel}\` label was added and the \`${opts.agentLabel}\` label was removed.`,
    `To re-queue after triage, remove \`${opts.agentFailedLabel}\` and re-add \`${opts.agentLabel}\`.`,
    ``,
    `<!-- ${AGENT_FAILURE_QUARANTINE_MARKER}:${opts.totalFailureCount} -->`,
  ].join("\n");
}

/**
 * Format codebase context gathered by the context agent.
 * Moved from organize-tickets.ts for consistency.
 */
export function codebaseContext(context: ContextResult): string {
  const lines: string[] = [CONTEXT_SENTINEL, ""];

  lines.push(context.codeContext, "");

  if (context.relevantFiles.length > 0) {
    lines.push("### Relevant Files", "");
    for (const file of context.relevantFiles) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
  }

  if (context.acceptanceCriteria.length > 0) {
    lines.push("### Suggested Acceptance Criteria", "");
    for (const criterion of context.acceptanceCriteria) {
      lines.push(`- [ ] ${criterion}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
