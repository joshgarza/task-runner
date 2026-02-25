// List Linear issues with filtering and optional comment display

import { fetchFilteredIssues } from "../linear/queries.ts";
import { log } from "../logger.ts";

export interface ListTicketsOptions {
  team: string;
  status?: string[];
  project?: string;
  labels?: string[];
  comments?: boolean;
}

export async function listTickets(opts: ListTicketsOptions): Promise<void> {
  log("INFO", "list-tickets", `Fetching issues for team ${opts.team}...`);

  const issues = await fetchFilteredIssues({
    teamKey: opts.team,
    stateNames: opts.status,
    projectName: opts.project,
    labelNames: opts.labels,
    includeComments: opts.comments,
  });

  if (issues.length === 0) {
    console.log("\nNo issues found matching the given filters.");
    return;
  }

  // Group by state
  const groups: Record<string, typeof issues> = {};
  for (const issue of issues) {
    const state = issue.stateName;
    if (!groups[state]) groups[state] = [];
    groups[state].push(issue);
  }

  // Print output
  console.log(`\n--- ${issues.length} issue(s) ---`);

  for (const [state, stateIssues] of Object.entries(groups)) {
    console.log(`\n### ${state} (${stateIssues.length})`);
    for (const issue of stateIssues) {
      const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
      const project = issue.projectName ? ` (${issue.projectName})` : "";
      console.log(`  ${issue.identifier}: ${issue.title}${labels}${project}`);
      console.log(`    ${issue.url}`);

      if (opts.comments && issue.comments.length > 0) {
        console.log(`    Comments (${issue.comments.length}):`);
        for (const comment of issue.comments) {
          const lines = comment.split("\n");
          for (const line of lines) {
            console.log(`      ${line}`);
          }
          console.log("");
        }
      }
    }
  }
}
