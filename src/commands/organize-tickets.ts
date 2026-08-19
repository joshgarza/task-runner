import type { Command } from "commander";
import { organizeTickets } from "../runner/organize-tickets.ts";
import { detectProjectFromCwd } from "../config.ts";
import { log } from "../logger.ts";

export function registerOrganizeTicketsCommand(program: Command): void {
  program
    .command("organize-tickets")
    .description("Triage Linear tickets and label unblocked ones as agent-ready")
    .option("--team <key>", "Team key (e.g. JOS) — auto-detected from cwd if omitted")
    .option("--project <name>", "Linear project name to filter by")
    .option("--states <states...>", "Workflow states to include (default: Todo, Backlog)")
    .option("--add-label <labels...>", "Labels to add to unblocked tickets (default: agent-ready)")
    .option("--remove-label <labels...>", "Labels to remove from unblocked tickets")
    .option("--context", "Gather codebase context via LLM for unblocked tickets (requires --project)")
    .option("--dry-run", "Preview changes without applying")
    .action(async (opts) => {
      try {
        const detected = detectProjectFromCwd();
        const team = opts.team ?? detected?.team;
        const project = opts.project ?? detected?.project;

        if (!team) {
          log("ERROR", "organize", "--team is required (could not auto-detect from cwd)");
          process.exit(1);
        }

        if (opts.context && !project) {
          log("ERROR", "organize", "--context requires --project to determine the repo path");
          process.exit(1);
        }

        const results = await organizeTickets({
          team,
          project,
          states: opts.states,
          addLabels: opts.addLabel,
          removeLabels: opts.removeLabel,
          context: opts.context,
          dryRun: opts.dryRun,
        });

        console.log("\n--- Results ---");
        for (const result of results) {
          const icon =
            result.action === "labeled" ? "[+]" : result.action === "blocked" ? "[x]" : "[-]";
          const context = result.contextGathered ? " (context added)" : "";
          console.log(`${icon} ${result.identifier}: ${result.title}${context}`);
          console.log(`    ${result.reason}`);
        }

        const labeled = results.filter((result) => result.action === "labeled").length;
        const blocked = results.filter((result) => result.action === "blocked").length;
        const skipped = results.filter((result) => result.action === "skipped").length;
        console.log(`\nTotal: ${labeled} labeled, ${blocked} blocked, ${skipped} skipped`);
      } catch (err: any) {
        log("ERROR", "organize", `Failed: ${err.message}`);
        process.exit(1);
      }
    });
}
