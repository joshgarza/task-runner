import type { Command } from "commander";
import { requestCodexReview } from "../runner/review.ts";
import { log } from "../logger.ts";

export function registerReviewCommand(program: Command): void {
  program
    .command("review <pr-url>")
    .description("Request a native Codex review on an existing GitHub PR")
    .action(async (prUrl: string) => {
      try {
        const result = await requestCodexReview(prUrl);
        if (!result.requested) {
          log("ERROR", "review", `Review request failed: ${result.error}`);
          process.exit(1);
        }
      } catch (err: any) {
        log("ERROR", "review", `Review failed: ${err.message}`);
        process.exit(1);
      }
    });
}
