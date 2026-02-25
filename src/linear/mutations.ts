// Transition state, add comment, create child issue in Linear

import { getLinearClient } from "./client.ts";

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

  await client.issueUpdate(issueId, { stateId: targetState.id });
}

/**
 * Add a comment to an issue
 */
export async function addComment(issueId: string, body: string): Promise<void> {
  const client = getLinearClient();
  await client.commentCreate({ issueId, body });
}

/**
 * Create a standalone issue in a team
 */
export async function createIssue(
  teamKey: string,
  title: string,
  opts: {
    description?: string;
    labelNames?: string[];
    priority?: number;
    projectName?: string;
    stateName?: string;
  } = {}
): Promise<{ identifier: string; url: string }> {
  const client = getLinearClient();

  // Find team
  const teams = await client.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team not found: ${teamKey}`);

  const input: any = {
    teamId: team.id,
    title,
  };

  if (opts.description) {
    input.description = opts.description;
  }

  if (opts.priority !== undefined) {
    input.priority = opts.priority;
  }

  // Resolve label IDs
  if (opts.labelNames && opts.labelNames.length > 0) {
    const teamLabels = await team.labels();
    const labelIds = opts.labelNames
      .map((name) => teamLabels.nodes.find((l: any) => l.name === name)?.id)
      .filter((id): id is string => !!id);

    if (labelIds.length > 0) {
      input.labelIds = labelIds;
    }
  }

  // Resolve project ID
  if (opts.projectName) {
    const projects = await client.projects({
      filter: { name: { eq: opts.projectName } },
      first: 1,
    });
    const project = projects.nodes[0];
    if (project) {
      input.projectId = project.id;
    }
  }

  // Resolve state ID
  if (opts.stateName) {
    const states = await team.states();
    const state = states.nodes.find((s: any) => s.name === opts.stateName);
    if (state) {
      input.stateId = state.id;
    }
  }

  const result = await client.issueCreate(input);
  const issue = await result.issue;

  return {
    identifier: issue?.identifier ?? "unknown",
    url: issue?.url ?? "",
  };
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

  const result = await client.issueCreate({
    teamId: team.id,
    title,
    description,
    parentId,
    labelIds,
  });

  const issue = await result.issue;
  return issue?.identifier ?? "unknown";
}
