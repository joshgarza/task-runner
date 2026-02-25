#!/usr/bin/env node

// Entry: run <id>, drain, review <pr>, standup

import { Command } from "commander";
import { runIssue } from "./runner/run-issue.ts";
import { drain } from "./runner/drain.ts";
import { reviewPR } from "./runner/review.ts";
import { standup } from "./runner/standup.ts";
import { addTicket } from "./runner/add-ticket.ts";
import { log } from "./logger.ts";

const program = new Command();

program
  .name("task-runner")
  .description("Linear-powered agent orchestration for Claude Code")
  .version("0.1.0");

program
  .command("run <identifier>")
  .description("Run a single Linear issue through the full pipeline")
  .option("--model <model>", "Claude model to use")
  .option("--max-turns <n>", "Maximum agent turns", (v: string) => parseInt(v, 10))
  .option("--max-budget-usd <n>", "Maximum budget in USD", parseFloat)
  .option("--max-attempts <n>", "Maximum retry attempts", (v: string) => parseInt(v, 10))
  .option("--dry-run", "Fetch and validate without running agent")
  .action(async (identifier: string, opts) => {
    try {
      const result = await runIssue(identifier, {
        model: opts.model,
        maxTurns: opts.maxTurns,
        maxBudgetUsd: opts.maxBudgetUsd,
        maxAttempts: opts.maxAttempts,
        dryRun: opts.dryRun,
      });

      if (result.success) {
        log("OK", identifier, `Pipeline complete`);
        if (result.prUrl) console.log(`\nPR: ${result.prUrl}`);
        if (result.reviewVerdict) {
          console.log(`Review: ${result.reviewVerdict.approved ? "APPROVED" : "NEEDS FIXES"}`);
          console.log(`Summary: ${result.reviewVerdict.summary}`);
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

program
  .command("drain")
  .description("Drain all agent-ready issues sequentially")
  .option("--label <label>", "Label to filter by")
  .option("--project <project>", "Linear project name to filter by")
  .option("--limit <n>", "Maximum issues to process", (v: string) => parseInt(v, 10))
  .action(async (opts) => {
    try {
      const results = await drain({
        label: opts.label,
        project: opts.project,
        limit: opts.limit,
      });

      const succeeded = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;
      console.log(`\nDrain complete: ${succeeded} succeeded, ${failed} failed`);

      if (failed > 0) process.exit(1);
    } catch (err: any) {
      log("ERROR", null, `Drain failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("review <pr-url>")
  .description("Review an existing PR standalone")
  .action(async (prUrl: string) => {
    try {
      const verdict = await reviewPR(prUrl);
      process.exit(verdict.approved ? 0 : 1);
    } catch (err: any) {
      log("ERROR", "review", `Review failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("standup")
  .description("Daily standup digest from Linear activity")
  .option("--days <n>", "Number of days to look back", (v: string) => parseInt(v, 10), 1)
  .option("--project <project>", "Linear project name to filter by")
  .action(async (opts) => {
    try {
      await standup({ days: opts.days, project: opts.project });
    } catch (err: any) {
      log("ERROR", "standup", `Standup failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("add-ticket <title>")
  .description("Create a new Linear issue")
  .requiredOption("-t, --team <key>", "Team key (e.g. JOS)")
  .option("-d, --description <text>", "Issue description (markdown supported)")
  .option("-l, --label <name>", 'Label name (repeatable, default: "needs review")', (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option("-p, --priority <n>", "Priority: 1=urgent, 2=high, 3=medium, 4=low", (v: string) => parseInt(v, 10))
  .option("--project <name>", "Linear project name")
  .option("-s, --state <name>", "Workflow state name")
  .option("-e, --estimate <n>", "Estimate points", (v: string) => parseInt(v, 10))
  .action(async (title: string, opts) => {
    try {
      const result = await addTicket({
        title,
        team: opts.team,
        description: opts.description,
        label: opts.label,
        priority: opts.priority,
        project: opts.project,
        state: opts.state,
        estimate: opts.estimate,
      });

      console.log(`\nCreated: ${result.identifier}`);
      console.log(`URL: ${result.url}`);
    } catch (err: any) {
      log("ERROR", "add-ticket", `Failed: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
