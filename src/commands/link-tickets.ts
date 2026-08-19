import type { Command } from "commander";
import { linkTickets } from "../runner/link-tickets.ts";
import { log } from "../logger.ts";

export function registerLinkTicketsCommand(program: Command): void {
  program
    .command("link-tickets <issueA> <issueB>")
    .description("Create a relation between two Linear issues (default: issueA blocks issueB)")
    .option("--type <type>", "Relation type: blocks, duplicate, related", "blocks")
    .action(async (issueA: string, issueB: string, opts) => {
      try {
        await linkTickets(issueA, issueB, opts.type);
        console.log(`\nLinked: ${issueA} ${opts.type} ${issueB}`);
      } catch (err: any) {
        log("ERROR", "link-tickets", `Failed to link issues: ${err.message}`);
        process.exit(1);
      }
    });
}
