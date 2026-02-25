// Create a new Linear issue via CLI

import { createIssue } from "../linear/mutations.ts";
import { log } from "../logger.ts";

const DEFAULT_LABEL = "needs review";

export interface AddTicketOptions {
  title: string;
  team: string;
  description?: string;
  label?: string[];
  priority?: number;
  project?: string;
  state?: string;
  estimate?: number;
}

export async function addTicket(
  opts: AddTicketOptions
): Promise<{ identifier: string; url: string }> {
  const labelNames =
    opts.label && opts.label.length > 0 ? opts.label : [DEFAULT_LABEL];

  log("INFO", "add-ticket", `Creating issue: "${opts.title}" in team ${opts.team}`);
  log("INFO", "add-ticket", `Labels: ${labelNames.join(", ")}`);

  const result = await createIssue({
    teamKey: opts.team,
    title: opts.title,
    description: opts.description,
    labelNames,
    priority: opts.priority,
    projectName: opts.project,
    stateName: opts.state,
    estimate: opts.estimate,
  });

  log("OK", "add-ticket", `Created ${result.identifier}: ${result.url}`);
  return result;
}
