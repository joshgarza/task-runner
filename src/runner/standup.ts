// Daily digest from Linear activity

import { loadConfig } from "../config.ts";
import { log } from "../logger.ts";
import { fetchRecentActivity } from "../linear/queries.ts";

interface StandupOptions {
  days?: number;
  project?: string;
}

type RecentActivityFetcher = typeof fetchRecentActivity;

export async function standup(
  options: StandupOptions = {},
  fetchActivity: RecentActivityFetcher = fetchRecentActivity
): Promise<void> {
  const days = options.days ?? 1;

  log("INFO", "standup", `Generating digest for last ${days} day(s)...`);

  let issues: Awaited<ReturnType<RecentActivityFetcher>>;
  try {
    issues = await fetchActivity(days, options.project);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to query Linear activity: ${detail}`, { cause: error });
  }

  if (issues.length === 0) {
    console.log("\nNo activity in the last " + days + " day(s).");
    return;
  }

  const config = loadConfig();

  // Group by state
  const groups: Record<string, typeof issues> = {};
  for (const issue of issues) {
    const state = issue.stateName;
    if (!groups[state]) groups[state] = [];
    groups[state].push(issue);
  }

  // Format output
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  console.log(`\n📋 Standup Digest (since ${since})`);
  console.log("=".repeat(50));

  for (const [state, stateIssues] of Object.entries(groups)) {
    console.log(`\n### ${state} (${stateIssues.length})`);
    for (const issue of stateIssues) {
      const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
      console.log(`  - ${issue.identifier}: ${issue.title}${labels}`);
    }
  }

  // Agent-specific stats
  const agentLabel = config.linear.agentLabel;
  const agentIssues = issues.filter((i) => i.labels.includes(agentLabel));
  if (agentIssues.length > 0) {
    console.log(`\n### Agent Activity (${agentIssues.length})`);
    for (const issue of agentIssues) {
      console.log(`  - ${issue.identifier}: ${issue.title} → ${issue.stateName}`);
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log(`Total: ${issues.length} issue(s) across ${Object.keys(groups).length} state(s)`);
}
