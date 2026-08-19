import type { Command } from "commander";
import { listTickets } from "../runner/list-tickets.ts";
import { log } from "../logger.ts";

export function registerListTicketsCommand(program: Command): void {
  program
    .command("list-tickets")
    .description("List Linear issues with filtering")
    .requiredOption("--team <key>", "Team key (e.g. JOS)")
    .option("--status <states...>", "Filter by workflow state names")
    .option("--project <name>", "Filter by Linear project name")
    .option("--labels <labels...>", "Filter by label names")
    .option("--comments", "Include comment bodies for each issue")
    .action(async (opts) => {
      try {
        await listTickets({
          team: opts.team,
          status: opts.status,
          project: opts.project,
          labels: opts.labels,
          comments: opts.comments,
        });
      } catch (err: any) {
        log("ERROR", "list-tickets", `Failed: ${err.message}`);
        process.exit(1);
      }
    });
}
