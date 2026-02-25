// Update an existing Linear issue from CLI arguments

import { fetchIssue } from "../linear/queries.ts";
import { updateIssue } from "../linear/mutations.ts";
import { log } from "../logger.ts";

export interface EditTicketOptions {
  title?: string;
  description?: string;
  priority?: number;
  labels?: string[];
  addLabels?: string[];
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

  // If --add-labels is used, merge with existing labels instead of replacing
  let labelNames = opts.labels;
  if (opts.addLabels && opts.addLabels.length > 0) {
    if (labelNames) {
      log("WARN", "edit-ticket", "--labels and --add-labels both specified; --add-labels takes precedence");
    }
    // Merge: existing labels + new labels, deduplicated
    labelNames = [...new Set([...issue.labels, ...opts.addLabels])];
  }

  await updateIssue(issue.id, issue.teamKey, {
    title: opts.title,
    description: opts.description,
    priority: opts.priority,
    labelNames,
    stateName: opts.status,
    assigneeEmail: opts.assignee,
  });

  log("OK", "edit-ticket", `Updated ${issue.identifier}: ${issue.url}`);
  return { identifier: issue.identifier, url: issue.url };
}
