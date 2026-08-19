import type { Command } from "commander";
import { refineTickets } from "../runner/refine-tickets.ts";
import { detectProjectFromCwd } from "../config.ts";
import { log } from "../logger.ts";

export function registerRefineTicketsCommand(program: Command): void {
  program
    .command("refine-tickets")
    .description("Refine Linear tickets with codebase context, execution routing, and blocking relations")
    .option("--team <key>", "Team key (e.g. JOS) — auto-detected from cwd if omitted")
    .option("--project <name>", "Linear project name to filter by")
    .option("--dry-run", "Preview which tickets would be refined without making changes")
    .action(async (opts) => {
      try {
        const detected = detectProjectFromCwd();
        const team = opts.team ?? detected?.team;
        const project = opts.project ?? detected?.project;

        if (!team) {
          log("ERROR", "refine", "--team is required (could not auto-detect from cwd)");
          process.exit(1);
        }

        const results = await refineTickets({
          team,
          project,
          dryRun: opts.dryRun,
        });

        console.log("\n--- Results ---");
        for (const result of results) {
          const icon =
            result.action === "refined" ? "[+]" : result.action === "skipped" ? "[-]" : "[!]";
          const dependencies = result.dependenciesAdded?.length
            ? ` (deps: ${result.dependenciesAdded.join(", ")})`
            : "";
          const route = result.executionRoute ? ` [${result.executionRoute}]` : "";
          console.log(`${icon} ${result.identifier}: ${result.title}${route}${dependencies}`);
          console.log(`    ${result.reason}`);
        }

        const refined = results.filter((result) => result.action === "refined").length;
        const skipped = results.filter((result) => result.action === "skipped").length;
        const failed = results.filter((result) => result.action === "failed").length;
        console.log(`\nTotal: ${refined} refined, ${skipped} skipped, ${failed} failed`);

        if (failed > 0) process.exit(1);
      } catch (err: any) {
        log("ERROR", "refine", `Failed: ${err.message}`);
        process.exit(1);
      }
    });
}
