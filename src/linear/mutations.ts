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
