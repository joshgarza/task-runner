// Transition state, add comment, create/add issues in Linear

import type { LinearDocument } from "@linear/sdk";
import { getLinearClient } from "./client.ts";
import { resolveLabels, collectAllNodes } from "./labels.ts";
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
  labelNames: string[],
  projectId?: string | null
): Promise<string> {
  const client = getLinearClient();

  // Find team
  const teams = await client.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team not found: ${teamKey}`);

  // Resolve label IDs (paginated, includes workspace labels)
  const labelIds = await resolveLabels(teamKey, labelNames, "create-child-issue");

  const payload: LinearDocument.IssueCreateInput = {
    teamId: team.id,
    title,
    description,
    parentId,
    labelIds,
    ...(projectId ? { projectId } : {}),
  };

  const result = await client.createIssue(payload);

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
 * Create a new label in Linear, scoped to a team or workspace-wide.
 * Pre-checks for duplicate names in the target scope.
 */
export async function createLabel(opts: {
  name: string;
  teamKey?: string;
  color?: string;
  description?: string;
}): Promise<{ name: string; id: string }> {
  const client = getLinearClient();

  let teamId: string | undefined;

  if (opts.teamKey) {
    // Resolve team and check for duplicate name among team labels
    const teams = await client.teams({ filter: { key: { eq: opts.teamKey } } });
    const team = teams.nodes[0];
    if (!team) throw new Error(`Team not found: ${opts.teamKey}`);
    teamId = team.id;

    // Check only team-scoped labels (not workspace labels) for duplicates
    const teamLabelsConn = await team.labels({ first: 250 });
    const teamLabels = await collectAllNodes(teamLabelsConn);
    const duplicate = teamLabels.find((l: any) => l.name === opts.name);
    if (duplicate) {
      throw new Error(`Label "${opts.name}" already exists in team ${opts.teamKey}`);
    }
  } else {
    // Check workspace-level labels for duplicate (exclude team-scoped labels)
    const wsLabels = await client.issueLabels({
      first: 250,
      filter: { name: { eq: opts.name } },
    });
    for (const label of wsLabels.nodes) {
      const labelTeam = await (label as any).team;
      if (!labelTeam) {
        throw new Error(`Label "${opts.name}" already exists at the workspace level`);
      }
    }
  }

  const payload: { name: string; teamId?: string; color?: string; description?: string } = {
    name: opts.name,
  };
  if (teamId) payload.teamId = teamId;
  if (opts.color) payload.color = opts.color;
  if (opts.description) payload.description = opts.description;

  const result = await client.createIssueLabel(payload);
  const label = await result.issueLabel;

  return {
    name: label?.name ?? opts.name,
    id: label?.id ?? "unknown",
  };
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
