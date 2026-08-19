import type { Command } from "commander";
import { standup } from "../runner/standup.ts";
import { detectProjectFromCwd } from "../config.ts";
import { log } from "../logger.ts";

export function registerStandupCommand(program: Command): void {
  program
    .command("standup")
    .description("Daily standup digest from Linear activity")
    .option("--days <n>", "Number of days to look back", (value: string) => parseInt(value, 10), 1)
    .option("--project <project>", "Linear project name to filter by")
    .action(async (opts) => {
      try {
        const detected = detectProjectFromCwd();
        await standup({ days: opts.days, project: opts.project ?? detected?.project });
      } catch (err: any) {
        log("ERROR", "standup", `Standup failed: ${err.message}`);
        process.exit(1);
      }
    });
}
