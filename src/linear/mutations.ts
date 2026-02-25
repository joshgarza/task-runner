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

/**
 * Create a new standalone issue
 */
export async function createIssue(opts: {
  teamKey: string;
  title: string;
  description?: string;
  labelNames: string[];
  priority?: number;
  projectName?: string;
  stateName?: string;
  estimate?: number;
}): Promise<{ identifier: string; url: string }> {
  const client = getLinearClient();

  // Find team
  const teams = await client.teams({ filter: { key: { eq: opts.teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team not found: ${opts.teamKey}`);

  // Resolve label IDs
  const teamLabels = await team.labels();
  const labelIds = opts.labelNames
    .map((name) => teamLabels.nodes.find((l) => l.name === name)?.id)
    .filter((id): id is string => !!id);

  const missingLabels = opts.labelNames.filter(
    (name) => !teamLabels.nodes.find((l) => l.name === name)
  );
  if (missingLabels.length > 0) {
    throw new Error(
      `Labels not found in team ${opts.teamKey}: ${missingLabels.join(", ")}. Available: ${teamLabels.nodes.map((l: any) => l.name).join(", ")}`
    );
  }

  // Build create payload
  const payload: any = {
    teamId: team.id,
    title: opts.title,
    labelIds,
  };

  if (opts.description) payload.description = opts.description;
  if (opts.priority !== undefined) payload.priority = opts.priority;
  if (opts.estimate !== undefined) payload.estimate = opts.estimate;

  // Resolve project ID if provided
  if (opts.projectName) {
    const projects = await client.projects({
      filter: { name: { eq: opts.projectName } },
      first: 1,
    });
    const project = projects.nodes[0];
    if (!project) throw new Error(`Project not found: ${opts.projectName}`);
    payload.projectId = project.id;
  }

  // Resolve state ID if provided
  if (opts.stateName) {
    const states = await team.states();
    const state = states.nodes.find((s) => s.name === opts.stateName);
    if (!state) {
      throw new Error(
        `State "${opts.stateName}" not found in team ${opts.teamKey}. Available: ${states.nodes.map((s) => s.name).join(", ")}`
      );
    }
    payload.stateId = state.id;
  }

  const result = await client.issueCreate(payload);
  const issue = await result.issue;
  if (!issue) throw new Error("Failed to create issue");

  return { identifier: issue.identifier, url: issue.url };
}
