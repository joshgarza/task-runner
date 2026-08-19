import type { Command } from "commander";
import { createLabel } from "../runner/create-label.ts";
import { detectProjectFromCwd } from "../config.ts";
import { log } from "../logger.ts";

export function registerCreateLabelCommand(program: Command): void {
  program
    .command("create-label <name>")
    .description("Create a new label in Linear")
    .option("--team <key>", "Team key (e.g. JOS) — auto-detected from cwd if omitted")
    .option("--color <hex>", "Label color as hex (e.g. #ff0000)")
    .option("--description <text>", "Label description")
    .action(async (name: string, opts) => {
      try {
        const detected = detectProjectFromCwd();
        const team = opts.team ?? detected?.team;

        const result = await createLabel(name, {
          team,
          color: opts.color,
          description: opts.description,
        });
        console.log(`\nCreated label: ${result.name} (${result.id})`);
      } catch (err: any) {
        log("ERROR", "create-label", `Failed to create label: ${err.message}`);
        process.exit(1);
      }
    });
}
