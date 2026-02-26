// Transition state, add comment, create/add issues in Linear

import type { LinearDocument } from "@linear/sdk";
import { getLinearClient } from "./client.ts";
import { resolveLabels } from "./labels.ts";
import { log } from "../logger.ts";

/**
 * Transition an issue to a new state by name
 */
export async function transitionIssue(
  issueId: string,
  teamKey: string,
  targetStateName: string
): Promise<void> {
  const client = getLinearClient();

  // Find the team's workflow states
  const teams = await client.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team not found: ${teamKey}`);

  const states = await team.states({ first: 250 });
  const targetState = states.nodes.find((s) => s.name === targetStateName);
  if (!targetState) {
    throw new Error(
      `State "${targetStateName}" not found in team ${teamKey}. Available: ${states.nodes.map((s) => s.name).join(", ")}`
    );
  }

  await client.updateIssue(issueId, { stateId: targetState.id });
}

/**
 * Add a comment to an issue
 */
export async function addComment(issueId: string, body: string): Promise<void> {
  const client = getLinearClient();
  await client.createComment({ issueId, body });
}

/**
 * Create a child issue (for review feedback requiring fixes)
 */
export async function createChildIssue(
  parentId: string,
  teamKey: string,
  title: string,
  description: string,
  labelNames: string[]
): Promise<string> {
  const client = getLinearClient();

  // Find team
  const teams = await client.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team not found: ${teamKey}`);

  // Resolve label IDs (paginated, includes workspace labels)
  const labelIds = await resolveLabels(teamKey, labelNames, "create-child-issue");

  const result = await client.createIssue({
    teamId: team.id,
    title,
    description,
    parentId,
    labelIds,
  });

  const issue = await result.issue;
  return issue?.identifier ?? "unknown";
}

/**
 * Update an existing issue's fields
 */
export async function updateIssue(
  issueId: string,
  teamKey: string,
  opts: {
    title?: string;
    description?: string;
    priority?: number;
    labelNames?: string[];
    stateName?: string;
    assigneeEmail?: string;
  }
): Promise<void> {
  const client = getLinearClient();

  // Find team (needed for resolving labels and states)
  const teams = await client.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team not found: ${teamKey}`);

  const payload: LinearDocument.IssueUpdateInput = {};

  if (opts.title !== undefined) {
    payload.title = opts.title;
  }

  if (opts.description !== undefined) {
    payload.description = opts.description;
  }

  if (opts.priority !== undefined) {
    payload.priority = opts.priority;
  }

  // Resolve labels by name (paginated, includes workspace labels)
  if (opts.labelNames !== undefined) {
    payload.labelIds = await resolveLabels(teamKey, opts.labelNames, "edit-ticket");
  }

  // Resolve state by name
  if (opts.stateName) {
    const states = await team.states({ first: 250 });
    const state = states.nodes.find((s) => s.name === opts.stateName);
    if (state) {
      payload.stateId = state.id;
    } else {
      throw new Error(
        `State "${opts.stateName}" not found in team ${teamKey}. Available: ${states.nodes.map((s) => s.name).join(", ")}`
      );
    }
  }

  // Resolve assignee by email
  if (opts.assigneeEmail) {
    const users = await client.users({ filter: { email: { eq: opts.assigneeEmail } } });
    const user = users.nodes[0];
    if (user) {
      payload.assigneeId = user.id;
    } else {
      throw new Error(`User not found with email: ${opts.assigneeEmail}`);
    }
  }

  if (Object.keys(payload).length === 0) {
    throw new Error("No fields to update");
  }

  await client.updateIssue(issueId, payload);
}

/**
 * Set the labels on an issue (replaces all labels)
 */
export async function setIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
  const client = getLinearClient();
  await client.updateIssue(issueId, { labelIds });
}

/**
 * Create a new issue in Linear
 */
export async function createIssue(opts: {
  teamKey: string;
  title: string;
  description?: string;
  labelNames: string[];
  priority?: number;
  projectName?: string;
  stateName?: string;
}): Promise<{ identifier: string; url: string }> {
  const client = getLinearClient();

  // Find team
  const teams = await client.teams({ filter: { key: { eq: opts.teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team not found: ${opts.teamKey}`);

  // Resolve label IDs (paginated, includes workspace labels, strict: throw on missing)
  const labelIds = await resolveLabels(opts.teamKey, opts.labelNames, "add-ticket", { strict: true });

  // Build create payload
  const payload: LinearDocument.IssueCreateInput = {
    teamId: team.id,
    title: opts.title,
    labelIds,
  };

  if (opts.description) {
    payload.description = opts.description;
  }

  if (opts.priority !== undefined) {
    payload.priority = opts.priority;
  }

  // Resolve project by name
  if (opts.projectName) {
    const projects = await client.projects({
      filter: { name: { eq: opts.projectName } },
      first: 1,
    });
    const project = projects.nodes[0];
    if (project) {
      payload.projectId = project.id;
    } else {
      throw new Error(`Project "${opts.projectName}" not found in Linear`);
    }
  }

  // Resolve state by name
  if (opts.stateName) {
    const states = await team.states({ first: 250 });
    const state = states.nodes.find((s) => s.name === opts.stateName);
    if (state) {
      payload.stateId = state.id;
    } else {
      log(
        "WARN",
        "add-ticket",
        `State "${opts.stateName}" not found in team ${opts.teamKey}. Available: ${states.nodes.map((s) => s.name).join(", ")}`
      );
    }
  }

  const result = await client.createIssue(payload);
  const issue = await result.issue;

  return {
    identifier: issue?.identifier ?? "unknown",
    url: issue?.url ?? "",
  };
}
