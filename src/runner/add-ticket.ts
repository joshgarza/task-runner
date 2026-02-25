// Create a new Linear issue from CLI arguments

import { createIssue } from "../linear/mutations.ts";
import { loadConfig } from "../config.ts";
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

  // Require --project or infer from config
  let projectName = opts.project;
  if (!projectName) {
    const config = loadConfig();
    const projectKeys = Object.keys(config.projects);
    if (projectKeys.length === 1) {
      projectName = projectKeys[0];
      log("INFO", "add-ticket", `No --project specified, using "${projectName}" from config`);
    } else {
      throw new Error(
        `--project is required. Available projects: ${projectKeys.join(", ")}`
      );
    }
  }

  log("INFO", "add-ticket", `Creating issue: "${title}" in team ${opts.team}`);

  const result = await createIssue({
    teamKey: opts.team,
    title,
    description: opts.description,
    labelNames,
    priority: opts.priority,
    projectName,
    stateName: opts.state,
  });

  log("OK", "add-ticket", `Created ${result.identifier}: ${result.url}`);
  return result;
}
