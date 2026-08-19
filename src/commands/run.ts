import type { Command } from "commander";
import { runIssue } from "../runner/run-issue.ts";
import { log } from "../logger.ts";
import { parseReasoningEffort } from "./parsers.ts";

export function registerRunCommand(program: Command): void {
  program
    .command("run <identifier>")
    .description("Run a single Linear issue through the full pipeline")
    .option("--model <model>", "Codex model to use")
    .option(
      "--reasoning-effort <level>",
      "Reasoning effort: minimal, low, medium, high, xhigh",
      parseReasoningEffort
    )
    .option("--max-attempts <n>", "Maximum retry attempts", (value: string) => parseInt(value, 10))
    .option("--dry-run", "Fetch and validate without running agent")
    .action(async (identifier: string, opts) => {
      try {
        const result = await runIssue(identifier, {
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          maxAttempts: opts.maxAttempts,
          dryRun: opts.dryRun,
        });

        if (result.success) {
          log("OK", identifier, "Pipeline complete");
          if (result.prUrl) console.log(`\nPR: ${result.prUrl}`);
          if (result.reviewRequested !== undefined) {
            console.log(
              `Native Codex review: ${result.reviewRequested ? "REQUESTED" : "REQUEST FAILED"}`
            );
          }
        } else {
          log("ERROR", identifier, `Pipeline failed: ${result.error}`);
          process.exit(1);
        }
      } catch (err: any) {
        log("ERROR", identifier, `Unexpected error: ${err.message}`);
        process.exit(1);
      }
    });
}
