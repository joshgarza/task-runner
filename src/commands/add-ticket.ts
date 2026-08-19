import type { Command } from "commander";
import { addTicket } from "../runner/add-ticket.ts";
import { detectProjectFromCwd } from "../config.ts";
import { log } from "../logger.ts";
import { parsePriority } from "./parsers.ts";

export function registerAddTicketCommand(program: Command): void {
  program
    .command("add-ticket <title>")
    .description("Create a new Linear issue")
    .option("--team <key>", "Team key (e.g. JOS) — auto-detected from cwd if omitted")
    .option("--description <text>", "Issue description")
    .option("--labels <labels...>", 'Space-separated labels (default: "needs review")')
    .option(
      "--priority <n>",
      "Priority (0=none, 1=urgent, 2=high, 3=medium, 4=low)",
      parsePriority
    )
    .option("--project <name>", "Linear project name")
    .option("--state <name>", "Workflow state name")
    .action(async (title: string, opts) => {
      try {
        const detected = detectProjectFromCwd();
        const team = opts.team ?? detected?.team;
        if (!team) {
          log("ERROR", "add-ticket", "--team is required (could not auto-detect from cwd)");
          process.exit(1);
        }

        const result = await addTicket(title, {
          team,
          description: opts.description,
          labels: opts.labels,
          priority: opts.priority,
          project: opts.project ?? detected?.project,
          state: opts.state,
        });
        console.log(`\nCreated: ${result.identifier}`);
        if (result.url) console.log(`URL: ${result.url}`);
      } catch (err: any) {
        log("ERROR", "add-ticket", `Failed to create issue: ${err.message}`);
        process.exit(1);
      }
    });
}
