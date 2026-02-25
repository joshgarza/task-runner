// Fetch issues, states, comments, labels from Linear

import { getLinearClient } from "./client.ts";
import type { LinearIssue } from "../types.ts";

/**
 * Build a LinearIssue from a raw Linear SDK issue object
 */
async function toLinearIssue(issue: any): Promise<LinearIssue> {
  const state = await issue.state;
  const team = await issue.team;
  const project = await issue.project;
  const labelsConn = await issue.labels();
  const commentsConn = await issue.comments();

  if (!team) {
    throw new Error(`Issue ${issue.identifier} has no team`);
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    teamKey: team.key,
    teamName: team.name,
    stateName: state?.name ?? "Unknown",
    stateId: state?.id ?? "",
    projectName: project?.name ?? null,
    labels: labelsConn.nodes.map((l: any) => l.name),
    comments: commentsConn.nodes.map((c: any) => c.body),
    url: issue.url,
    branchName: issue.branchName,
  };
}

/**
 * Fetch a single issue by identifier (e.g. "JOS-123")
 */
export async function fetchIssue(identifier: string): Promise<LinearIssue> {
  const client = getLinearClient();

  // Parse identifier (e.g. "JOS-47") into team key and number
  const match = identifier.match(/^([A-Z]+)-(\d+)$/);
  if (!match) {
    throw new Error(`Invalid issue identifier format: ${identifier}. Expected format: TEAM-123`);
  }
  const [, teamKey, number] = match;

  const issues = await client.issues({
    filter: {
      team: { key: { eq: teamKey } },
      number: { eq: parseInt(number, 10) },
    },
    first: 1,
  });

  const issue = issues.nodes[0];
  if (!issue) {
    throw new Error(`Issue not found: ${identifier}`);
  }

  return toLinearIssue(issue);
}

/**
 * Fetch all issues with a given label, filtered by state and optionally by project name
 */
export async function fetchAgentReadyIssues(
  labelName: string,
  stateName: string,
  projectName?: string
): Promise<LinearIssue[]> {
  const client = getLinearClient();

  // Build filter
  const filter: any = {
    labels: { name: { eq: labelName } },
    state: { name: { eq: stateName } },
  };

  if (projectName) {
    filter.project = { name: { eq: projectName } };
  }

  const issues = await client.issues({
    filter,
    first: 50,
  });

  const results: LinearIssue[] = [];
  for (const issue of issues.nodes) {
    results.push(await toLinearIssue(issue));
  }

  return results;
}

/**
 * Fetch recent activity for standup digest
 */
export async function fetchRecentActivity(
  days: number,
  projectName?: string
): Promise<LinearIssue[]> {
  const client = getLinearClient();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const filter: any = {
    updatedAt: { gte: since },
  };

  if (projectName) {
    filter.project = { name: { eq: projectName } };
  }

  const issues = await client.issues({
    filter,
    first: 100,
  });

  const results: LinearIssue[] = [];
  for (const issue of issues.nodes) {
    const team = await issue.team;
    if (!team) continue;

    const state = await issue.state;
    const project = await issue.project;
    const labelsConn = await issue.labels();

    results.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      teamKey: team.key,
      teamName: team.name,
      stateName: state?.name ?? "Unknown",
      stateId: state?.id ?? "",
      projectName: project?.name ?? null,
      labels: labelsConn.nodes.map((l: any) => l.name),
      comments: [],
      url: issue.url,
      branchName: issue.branchName,
    });
  }

  return results;
}
