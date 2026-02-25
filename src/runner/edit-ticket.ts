// Update an existing Linear issue from CLI arguments

import { fetchIssue } from "../linear/queries.ts";
import { updateIssue } from "../linear/mutations.ts";
import { log } from "../logger.ts";

export interface EditTicketOptions {
  title?: string;
  description?: string;
  priority?: number;
  labels?: string[];
  status?: string;
  assignee?: string;
}

export async function editTicket(
  identifier: string,
  opts: EditTicketOptions
): Promise<{ identifier: string; url: string }> {
  log("INFO", "edit-ticket", `Updating issue: ${identifier}`);

  // Fetch the issue to get its ID and team key
  const issue = await fetchIssue(identifier);

  await updateIssue(issue.id, issue.teamKey, {
    title: opts.title,
    description: opts.description,
    priority: opts.priority,
    labelNames: opts.labels,
    stateName: opts.status,
    assigneeEmail: opts.assignee,
  });

  log("OK", "edit-ticket", `Updated ${issue.identifier}: ${issue.url}`);
  return { identifier: issue.identifier, url: issue.url };
}
