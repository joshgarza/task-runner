// Formatted comment builders for Linear
//
// Each function takes typed parameters and returns a markdown string.
// The addComment function in mutations.ts stays unchanged as the transport layer.

import type { ReviewVerdict, ContextResult } from "../types.ts";

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/**
 * Sentinel string used by organize-tickets.ts for idempotency checking.
 * If this changes, update the check in organize-tickets.ts too.
 */
export const CONTEXT_SENTINEL = "## Codebase Context (auto-generated)";

export function startWork(opts: {
  identifier: string;
  title: string;
  agentType: string;
  model: string;
  maxTurns: number;
  maxAttempts: number;
}): string {
  return [
    `## Agent Starting Work`,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Issue** | ${opts.identifier}: ${opts.title} |`,
    `| **Agent** | \`${opts.agentType}\` |`,
    `| **Model** | \`${opts.model}\` |`,
    `| **Max turns** | ${opts.maxTurns} |`,
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
    `- Check if the issue requires capabilities not available to the agent`,
    `- Re-queue by moving the ticket back to **Todo** with the \`agent-ready\` label`,
  ].join("\n");
}

export function reviewPassed(opts: {
  verdict: ReviewVerdict;
  prUrl: string;
}): string {
  const check = (pass: boolean) => pass ? "pass" : "fail";
  return [
    `## Review Passed`,
    ``,
    opts.verdict.summary,
    ``,
    `| Check | Status |`,
    `|-------|--------|`,
    `| Tests | ${check(opts.verdict.testsPass)} |`,
    `| Lint | ${check(opts.verdict.lintPass)} |`,
    `| TypeScript | ${check(opts.verdict.tscPass)} |`,
    ``,
    `**PR:** [${opts.prUrl}](${opts.prUrl})`,
  ].join("\n");
}

export function rollback(opts: {
  error: string;
  attempts: number;
}): string {
  return [
    `## Agent Failed, Rolled Back to Todo`,
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
    `- If the error is a permission issue, check agent type capabilities`,
    `- Re-queue by adding the \`agent-ready\` label`,
  ].join("\n");
}

export function escalationNeeded(opts: {
  baseAgentType: string;
  missingCapabilities: string[];
  proposalId: string;
}): string {
  return [
    `## Agent Permission Escalation Needed`,
    ``,
    `Agent type \`${opts.baseAgentType}\` failed with missing capabilities:`,
    ...opts.missingCapabilities.map((c) => `- \`${c}\``),
    ``,
    `**Proposal ID:** \`${opts.proposalId}\``,
    ``,
    `### Actions`,
    ``,
    `**Approve:**`,
    "```bash",
    `node --experimental-strip-types src/cli.ts approve-agent ${opts.proposalId}`,
    "```",
    ``,
    `**Reject:**`,
    "```bash",
    `node --experimental-strip-types src/cli.ts approve-agent ${opts.proposalId} --reject --reason "..."`,
    "```",
  ].join("\n");
}

export function proposalApproved(opts: {
  proposalId: string;
  proposedAgentType: string;
}): string {
  return [
    `## Proposal Approved`,
    ``,
    `Proposal \`${opts.proposalId}\` approved.`,
    `New agent type \`${opts.proposedAgentType}\` added to registry.`,
    ``,
    `Ticket re-queued for processing.`,
  ].join("\n");
}

export function proposalRejected(opts: {
  proposalId: string;
  reason: string;
}): string {
  return [
    `## Proposal Rejected`,
    ``,
    `Proposal \`${opts.proposalId}\` rejected.`,
    ``,
    `**Reason:** ${opts.reason}`,
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
