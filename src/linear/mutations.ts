// Transition state, add comment, create/add issues in Linear

import { getLinearClient } from "./client.ts";
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

  const states = await team.states();
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

  // Find label IDs
  const teamLabels = await team.labels();
  const labelIds = labelNames
    .map((name) => teamLabels.nodes.find((l) => l.name === name)?.id)
    .filter((id): id is string => !!id);

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

  // Resolve label IDs
  const teamLabels = await team.labels();
  const labelIds: string[] = [];
  for (const name of opts.labelNames) {
    const label = teamLabels.nodes.find((l) => l.name === name);
    if (label) {
      labelIds.push(label.id);
    } else {
      log("WARN", "add-ticket", `Label "${name}" not found in team ${opts.teamKey}. Skipping.`);
    }
  }

  // Build create payload
  const payload: Record<string, unknown> = {
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
      log("WARN", "add-ticket", `Project "${opts.projectName}" not found. Skipping.`);
    }
  }

  // Resolve state by name
  if (opts.stateName) {
    const states = await team.states();
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

  const result = await client.issueCreate(payload as any);
  const issue = await result.issue;

  return {
    identifier: issue?.identifier ?? "unknown",
    url: issue?.url ?? "",
  };
}
