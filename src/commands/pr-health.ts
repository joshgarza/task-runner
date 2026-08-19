import type { Command } from "commander";
import { prHealth } from "../runner/pr-health.ts";
import { detectProjectFromCwd } from "../config.ts";
import { log } from "../logger.ts";

export function registerPrHealthCommand(program: Command): void {
  program
    .command("pr-health")
    .description("Reconcile Linear issues with GitHub PR status")
    .option("--team <key>", "Team key (e.g. JOS) — auto-detected from cwd if omitted")
    .option("--project <name>", "Linear project name to filter by")
    .option("--dry-run", "Preview changes without applying")
    .action(async (opts) => {
      try {
        const detected = detectProjectFromCwd();
        const team = opts.team ?? detected?.team;

        if (!team) {
          log("ERROR", "pr-health", "--team is required (could not auto-detect from cwd)");
          process.exit(1);
        }

        const results = await prHealth({
          team,
          project: opts.project ?? detected?.project,
          dryRun: opts.dryRun,
        });

        console.log("\n--- Results ---");
        for (const result of results) {
          const icon =
            result.action === "transitioned-done"
              ? "[+]"
              : result.action === "transitioned-todo"
                ? "[~]"
                : "[-]";
          console.log(`${icon} ${result.identifier}: ${result.title}`);
          console.log(`    PR: ${result.prUrl} (${result.prState})`);
          console.log(`    ${result.reason}`);
        }

        const done = results.filter((result) => result.action === "transitioned-done").length;
        const todo = results.filter((result) => result.action === "transitioned-todo").length;
        const skipped = results.filter((result) => result.action === "skipped").length;
        console.log(`\nTotal: ${done} merged, ${todo} closed, ${skipped} skipped`);
      } catch (err: any) {
        log("ERROR", "pr-health", `Failed: ${err.message}`);
        process.exit(1);
      }
    });
}
