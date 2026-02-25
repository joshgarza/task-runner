// Create a new Linear issue from CLI arguments

import { createIssue } from "../linear/mutations.ts";
import { log } from "../logger.ts";

const DEFAULT_LABEL = "needs review";

export interface AddTicketOptions {
  team: string;
  description?: string;
  labels?: string[];
  priority?: number;
  project?: string;
  state?: string;
}

export async function addTicket(
  title: string,
  opts: AddTicketOptions
): Promise<{ identifier: string; url: string }> {
  const labelNames =
    opts.labels && opts.labels.length > 0 ? opts.labels : [DEFAULT_LABEL];

  log("INFO", "add-ticket", `Creating issue: "${title}" in team ${opts.team}`);

  const result = await createIssue({
    teamKey: opts.team,
    title,
    description: opts.description,
    labelNames,
    priority: opts.priority,
    projectName: opts.project,
    stateName: opts.state,
  });

  log("OK", "add-ticket", `Created ${result.identifier}: ${result.url}`);
  return result;
}
