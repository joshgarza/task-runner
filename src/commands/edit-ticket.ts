import type { Command } from "commander";
import { editTicket } from "../runner/edit-ticket.ts";
import { log } from "../logger.ts";
import { parsePriority } from "./parsers.ts";

export function registerEditTicketCommand(program: Command): void {
  program
    .command("edit-ticket <identifier>")
    .description("Update an existing Linear issue")
    .option("--title <text>", "New title")
    .option("--description <text>", "New description")
    .option(
      "--priority <n>",
      "Priority (0=none, 1=urgent, 2=high, 3=medium, 4=low)",
      parsePriority
    )
    .option("--labels <labels...>", "Space-separated labels (replaces existing)")
    .option("--add-labels <labels...>", "Space-separated labels to add (preserves existing)")
    .option(
      "--remove-labels <labels...>",
      "Space-separated labels to remove (preserves existing)"
    )
    .option("--status <name>", "Workflow state name")
    .option("--assignee <email>", "Assignee email address")
    .option("--comment <text>", "Add a comment to the issue")
    .action(async (identifier: string, opts) => {
      try {
        const result = await editTicket(identifier, {
          title: opts.title,
          description: opts.description,
          priority: opts.priority,
          labels: opts.labels,
          addLabels: opts.addLabels,
          removeLabels: opts.removeLabels,
          status: opts.status,
          assignee: opts.assignee,
          comment: opts.comment,
        });
        console.log(`\nUpdated: ${result.identifier}`);
        if (result.url) console.log(`URL: ${result.url}`);
      } catch (err: any) {
        log("ERROR", "edit-ticket", `Failed to update issue: ${err.message}`);
        process.exit(1);
      }
    });
}
