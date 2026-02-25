// Proposal CRUD: create, list, approve, reject agent type proposals

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "../logger.ts";
import { addAgentType, loadRegistry, resolveAgentType } from "./registry.ts";
import type {
  AgentProposal,
  FailureAnalysis,
  LinearIssue,
  TaskRunnerConfig,
} from "../types.ts";

const PROPOSALS_DIR = resolve(import.meta.dirname, "proposals");

function ensureProposalsDir(): void {
  if (!existsSync(PROPOSALS_DIR)) {
    mkdirSync(PROPOSALS_DIR, { recursive: true });
  }
}

function proposalPath(id: string): string {
  return resolve(PROPOSALS_DIR, `${id}.json`);
}

/**
 * Create a proposal for a new agent type based on a permission failure.
 * Builds proposed tools from the base type + missing capabilities.
 * Swaps labels on the Linear issue: remove agent-ready, add needs-human-approval.
 */
export async function createProposal(opts: {
  issue: LinearIssue;
  baseAgentType: string;
  failureAnalysis: FailureAnalysis;
  config: TaskRunnerConfig;
}): Promise<AgentProposal> {
  ensureProposalsDir();

  const { issue, baseAgentType, failureAnalysis, config } = opts;

  // Resolve the base agent's current tools
  const registry = loadRegistry();
  const baseResolved = resolveAgentType(baseAgentType, registry);

  // Build proposed tools: base tools + suggested missing tools
  const proposedTools = [
    ...new Set([...baseResolved.tools, ...failureAnalysis.suggestedTools]),
  ];

  // Generate a descriptive name for the proposed type
  const proposedName = `${baseAgentType}-${issue.identifier.toLowerCase()}`;

  const proposal: AgentProposal = {
    id: randomUUID(),
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    baseAgentType,
    proposedAgentType: proposedName,
    proposedTools,
    proposedMaxBudgetUsd: baseResolved.maxBudgetUsd,
    proposedMaxTurns: baseResolved.maxTurns,
    failureAnalysis,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  writeFileSync(proposalPath(proposal.id), JSON.stringify(proposal, null, 2) + "\n");

  // Swap labels on Linear issue: remove agent-ready, add needs-human-approval
  try {
    const { updateIssue } = await import("../linear/mutations.ts");
    const { resolveTeamLabels } = await import("../linear/labels.ts");

    const labelMap = await resolveTeamLabels(issue.teamKey);
    const currentLabelIds = issue.labels
      .map((name) => labelMap.get(name))
      .filter((id): id is string => id !== undefined);

    // Remove agent-ready, add needs-human-approval
    const agentReadyId = labelMap.get(config.linear.agentLabel);
    const needsApprovalId = labelMap.get(config.linear.needsApprovalLabel);

    const newLabelIds = currentLabelIds.filter((id) => id !== agentReadyId);
    if (needsApprovalId && !newLabelIds.includes(needsApprovalId)) {
      newLabelIds.push(needsApprovalId);
    }

    const { setIssueLabels } = await import("../linear/mutations.ts");
    await setIssueLabels(issue.id, newLabelIds);

    // Post comment with proposal details
    const { addComment } = await import("../linear/mutations.ts");
    const comment = [
      `🤖 **Agent permission escalation needed**`,
      "",
      `Agent type \`${baseAgentType}\` failed with missing capabilities:`,
      ...failureAnalysis.missingCapabilities.map((c) => `- \`${c}\``),
      "",
      `**Proposal ID:** \`${proposal.id}\``,
      "",
      "To approve:",
      "```bash",
      `node --experimental-strip-types src/cli.ts approve-agent ${proposal.id}`,
      "```",
      "",
      "To reject:",
      "```bash",
      `node --experimental-strip-types src/cli.ts approve-agent ${proposal.id} --reject --reason "..."`,
      "```",
    ].join("\n");
    await addComment(issue.id, comment);
  } catch (err: any) {
    log("WARN", issue.identifier, `Failed to update labels/comment for proposal: ${err.message}`);
  }

  log("INFO", "proposals", `Created proposal ${proposal.id} for ${issue.identifier}`);
  return proposal;
}

/**
 * List all proposals, optionally filtered by status.
 */
export function listProposals(
  status?: AgentProposal["status"]
): AgentProposal[] {
  ensureProposalsDir();

  const files = readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith(".json"));
  const proposals: AgentProposal[] = [];

  for (const file of files) {
    const proposal = JSON.parse(
      readFileSync(resolve(PROPOSALS_DIR, file), "utf-8")
    ) as AgentProposal;

    if (!status || proposal.status === status) {
      proposals.push(proposal);
    }
  }

  // Sort by creation date, newest first
  proposals.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return proposals;
}

/**
 * Get a single proposal by ID.
 */
export function getProposal(id: string): AgentProposal {
  const path = proposalPath(id);
  if (!existsSync(path)) {
    throw new Error(`Proposal not found: ${id}`);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as AgentProposal;
}

/**
 * Approve a proposal: add the new type to the registry,
 * swap labels back on the issue, and mark the proposal as approved.
 */
export async function approveProposal(
  id: string,
  config: TaskRunnerConfig
): Promise<AgentProposal> {
  const proposal = getProposal(id);

  if (proposal.status !== "pending") {
    throw new Error(
      `Proposal ${id} is already ${proposal.status}. Cannot approve.`
    );
  }

  // Add new agent type to registry
  addAgentType(proposal.proposedAgentType, {
    description: `Auto-generated for ${proposal.issueIdentifier}: ${proposal.issueTitle}`,
    tools: proposal.proposedTools,
    maxBudgetUsd: proposal.proposedMaxBudgetUsd,
    maxTurns: proposal.proposedMaxTurns,
    audit: {
      createdBy: `proposal:${proposal.id}`,
      createdAt: new Date().toISOString(),
      reason: `Approved escalation from "${proposal.baseAgentType}" for ${proposal.issueIdentifier}`,
    },
  });

  // Update proposal status
  proposal.status = "approved";
  proposal.resolvedAt = new Date().toISOString();
  writeFileSync(proposalPath(id), JSON.stringify(proposal, null, 2) + "\n");

  // Swap labels on Linear: remove needs-human-approval, add agent-ready + agent:<newType>
  try {
    const { fetchIssue } = await import("../linear/queries.ts");
    const { resolveTeamLabels } = await import("../linear/labels.ts");
    const { setIssueLabels, addComment } = await import("../linear/mutations.ts");

    const issue = await fetchIssue(proposal.issueIdentifier);
    const labelMap = await resolveTeamLabels(issue.teamKey);
    const currentLabelIds = issue.labels
      .map((name) => labelMap.get(name))
      .filter((lid): lid is string => lid !== undefined);

    const needsApprovalId = labelMap.get(config.linear.needsApprovalLabel);
    const agentReadyId = labelMap.get(config.linear.agentLabel);
    const agentTypeLabel = `agent:${proposal.proposedAgentType}`;
    const agentTypeLabelId = labelMap.get(agentTypeLabel);

    // Remove needs-human-approval, add agent-ready
    const newLabelIds = currentLabelIds.filter((lid) => lid !== needsApprovalId);
    if (agentReadyId && !newLabelIds.includes(agentReadyId)) {
      newLabelIds.push(agentReadyId);
    }
    if (agentTypeLabelId && !newLabelIds.includes(agentTypeLabelId)) {
      newLabelIds.push(agentTypeLabelId);
    }

    await setIssueLabels(issue.id, newLabelIds);
    await addComment(
      issue.id,
      `🤖 Proposal \`${id}\` approved. New agent type \`${proposal.proposedAgentType}\` added to registry. Ticket re-queued for processing.`
    );
  } catch (err: any) {
    log("WARN", "proposals", `Failed to update labels after approval: ${err.message}`);
  }

  log("OK", "proposals", `Approved proposal ${id} → agent type "${proposal.proposedAgentType}"`);
  return proposal;
}

/**
 * Reject a proposal: mark rejected, post reason as comment.
 */
export async function rejectProposal(
  id: string,
  reason: string
): Promise<AgentProposal> {
  const proposal = getProposal(id);

  if (proposal.status !== "pending") {
    throw new Error(
      `Proposal ${id} is already ${proposal.status}. Cannot reject.`
    );
  }

  proposal.status = "rejected";
  proposal.rejectionReason = reason;
  proposal.resolvedAt = new Date().toISOString();
  writeFileSync(proposalPath(id), JSON.stringify(proposal, null, 2) + "\n");

  // Post rejection comment on Linear
  try {
    const { fetchIssue } = await import("../linear/queries.ts");
    const { addComment } = await import("../linear/mutations.ts");

    const issue = await fetchIssue(proposal.issueIdentifier);
    await addComment(
      issue.id,
      `🤖 Proposal \`${id}\` rejected.\n\nReason: ${reason}`
    );
  } catch (err: any) {
    log("WARN", "proposals", `Failed to post rejection comment: ${err.message}`);
  }

  log("INFO", "proposals", `Rejected proposal ${id}: ${reason}`);
  return proposal;
}
