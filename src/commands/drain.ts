import type { Command } from "commander";
import { drain } from "../runner/drain.ts";
import { log } from "../logger.ts";

export function registerDrainCommand(program: Command): void {
  program
    .command("drain")
    .description("Drain all agent-ready issues with configurable concurrency")
    .option("--label <label>", "Label to filter by")
    .option("--project <project>", "Linear project name to filter by")
    .option("--limit <n>", "Maximum issues to process", (value: string) => parseInt(value, 10))
    .option(
      "--concurrency <n>",
      "Number of parallel agents (default: from config)",
      (value: string) => parseInt(value, 10)
    )
    .option("--dry-run", "List agent-ready issues without processing them")
    .action(async (opts) => {
      try {
        const results = await drain({
          label: opts.label,
          project: opts.project,
          limit: opts.limit,
          concurrency: opts.concurrency,
          dryRun: opts.dryRun,
        });

        const succeeded = results.filter((result) => result.success).length;
        const failed = results.filter((result) => !result.success).length;
        console.log(`\nDrain complete: ${succeeded} succeeded, ${failed} failed`);

        if (failed > 0) process.exit(1);
      } catch (err: any) {
        log("ERROR", null, `Drain failed: ${err.message}`);
        process.exit(1);
      }
    });
}
