// Shared label-resolution utilities with pagination and workspace-label support

import { getLinearClient } from "./client.ts";
import { log } from "../logger.ts";

/**
 * Collect all nodes from a paginated Linear connection
 */
export async function collectAllNodes<T>(connection: { nodes: T[]; fetchNext: () => Promise<{ nodes: T[]; fetchNext: () => Promise<any>; pageInfo: { hasNextPage: boolean } }>; pageInfo: { hasNextPage: boolean } }): Promise<T[]> {
  const all: T[] = [...connection.nodes];
  let current = connection;
  while (current.pageInfo.hasNextPage) {
    current = await current.fetchNext();
    all.push(...current.nodes);
  }
  return all;
}

/**
 * Build a name→ID map of all labels available to a team.
 * Includes both team-scoped and workspace-level labels, and paginates
 * to avoid missing labels when there are more than one page.
 */
export async function resolveTeamLabels(teamKey: string): Promise<Map<string, string>> {
  const client = getLinearClient();
  const teams = await client.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team not found: ${teamKey}`);

  const labelMap = new Map<string, string>();

  // Fetch team-scoped labels (paginated)
  const teamLabelsConn = await team.labels({ first: 250 });
  const teamLabels = await collectAllNodes(teamLabelsConn);
  for (const label of teamLabels) {
    labelMap.set((label as any).name, (label as any).id);
  }

  // Fetch workspace-level labels (paginated) so labels not scoped to a
  // team are still resolved (e.g. a workspace-level "agent-ready" label)
  const wsLabelsConn = await client.issueLabels({ first: 250 });
  const wsLabels = await collectAllNodes(wsLabelsConn);
  for (const label of wsLabels) {
    // Team labels take precedence — only add workspace labels that are not
    // already in the map
    if (!labelMap.has((label as any).name)) {
      labelMap.set((label as any).name, (label as any).id);
    }
  }

  return labelMap;
}

/**
 * Resolve label names to IDs for a given team.
 * When strict is true, throws on missing labels instead of skipping.
 */
export async function resolveLabels(
  teamKey: string,
  labelNames: string[],
  context: string = "linear",
  opts: { strict?: boolean } = {}
): Promise<string[]> {
  const labelMap = await resolveTeamLabels(teamKey);
  const labelIds: string[] = [];
  for (const name of labelNames) {
    const id = labelMap.get(name);
    if (id) {
      labelIds.push(id);
    } else if (opts.strict) {
      const available = [...labelMap.keys()].join(", ");
      throw new Error(`Label "${name}" not found in team ${teamKey}. Available: ${available}`);
    } else {
      log("WARN", context, `Label "${name}" not found in team ${teamKey}. Skipping.`);
    }
  }
  return labelIds;
}
