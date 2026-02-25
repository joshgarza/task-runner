// Create a new Linear issue via CLI

import { createIssue } from "../linear/mutations.ts";
import { log } from "../logger.ts";
import type { AddTicketOptions } from "../types.ts";

const DEFAULT_LABEL = "needs review";

export async function addTicket(
  title: string,
  opts: AddTicketOptions
): Promise<void> {
  const labels = opts.label && opts.label.length > 0 ? opts.label : [DEFAULT_LABEL];

  log("INFO", null, `Creating issue: "${title}" in team ${opts.team}`);

  const { identifier, url } = await createIssue(opts.team, title, {
    description: opts.description,
    labelNames: labels,
    priority: opts.priority,
    projectName: opts.project,
    stateName: opts.state,
  });

  log("OK", identifier, `Issue created: ${url}`);
  console.log(`\n${identifier}: ${url}`);
}
