#!/usr/bin/env node

// Entry: run <id>, drain, review <pr>, standup

import { Command } from "commander";
import { runIssue } from "./runner/run-issue.ts";
import { drain } from "./runner/drain.ts";
import { reviewPR } from "./runner/review.ts";
import { standup } from "./runner/standup.ts";
import { addTicket } from "./runner/add-ticket.ts";
import { editTicket } from "./runner/edit-ticket.ts";
import { organizeTickets } from "./runner/organize-tickets.ts";
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
  .option("--dry-run", "List agent-ready issues without processing them")
  .action(async (opts) => {
    try {
      const results = await drain({
        label: opts.label,
        project: opts.project,
        limit: opts.limit,
        dryRun: opts.dryRun,
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
  .requiredOption("--team <key>", "Team key (e.g. JOS)")
  .option("--description <text>", "Issue description")
  .option("--labels <labels...>", 'Space-separated labels (default: "needs review")')
  .option("--priority <n>", "Priority (0=none, 1=urgent, 2=high, 3=medium, 4=low)", (v: string) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 0 || n > 4) throw new Error(`Invalid priority: ${v}. Must be 0-4.`);
    return n;
  })
  .option("--project <name>", "Linear project name")
  .option("--state <name>", "Workflow state name")
  .action(async (title: string, opts) => {
    try {
      const result = await addTicket(title, {
        team: opts.team,
        description: opts.description,
        labels: opts.labels,
        priority: opts.priority,
        project: opts.project,
        state: opts.state,
      });
      console.log(`\nCreated: ${result.identifier}`);
      if (result.url) console.log(`URL: ${result.url}`);
    } catch (err: any) {
      log("ERROR", "add-ticket", `Failed to create issue: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("edit-ticket <identifier>")
  .description("Update an existing Linear issue")
  .option("--title <text>", "New title")
  .option("--description <text>", "New description")
  .option("--priority <n>", "Priority (0=none, 1=urgent, 2=high, 3=medium, 4=low)", (v: string) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 0 || n > 4) throw new Error(`Invalid priority: ${v}. Must be 0-4.`);
    return n;
  })
  .option("--labels <labels...>", "Space-separated labels (replaces existing)")
  .option("--status <name>", "Workflow state name")
  .option("--assignee <email>", "Assignee email address")
  .action(async (identifier: string, opts) => {
    try {
      const result = await editTicket(identifier, {
        title: opts.title,
        description: opts.description,
        priority: opts.priority,
        labels: opts.labels,
        status: opts.status,
        assignee: opts.assignee,
      });
      console.log(`\nUpdated: ${result.identifier}`);
      if (result.url) console.log(`URL: ${result.url}`);
    } catch (err: any) {
      log("ERROR", "edit-ticket", `Failed to update issue: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("organize-tickets")
  .description("Triage Linear tickets and label unblocked ones as agent-ready")
  .requiredOption("--team <key>", "Team key (e.g. JOS)")
  .option("--project <name>", "Linear project name to filter by")
  .option("--states <states...>", "Workflow states to include (default: Todo, Backlog)")
  .option("--add-label <labels...>", "Labels to add to unblocked tickets (default: agent-ready)")
  .option("--remove-label <labels...>", "Labels to remove from unblocked tickets")
  .option("--context", "Gather codebase context via LLM for unblocked tickets (requires --project)")
  .option("--dry-run", "Preview changes without applying")
  .action(async (opts) => {
    try {
      if (opts.context && !opts.project) {
        log("ERROR", "organize", "--context requires --project to determine the repo path");
        process.exit(1);
      }

      const results = await organizeTickets({
        team: opts.team,
        project: opts.project,
        states: opts.states,
        addLabels: opts.addLabel,
        removeLabels: opts.removeLabel,
        context: opts.context,
        dryRun: opts.dryRun,
      });

      // Print summary table
      console.log("\n--- Results ---");
      for (const r of results) {
        const icon = r.action === "labeled" ? "[+]" : r.action === "blocked" ? "[x]" : "[-]";
        const ctx = r.contextGathered ? " (context added)" : "";
        console.log(`${icon} ${r.identifier}: ${r.title}${ctx}`);
        console.log(`    ${r.reason}`);
      }

      const labeled = results.filter((r) => r.action === "labeled").length;
      const blocked = results.filter((r) => r.action === "blocked").length;
      const skipped = results.filter((r) => r.action === "skipped").length;
      console.log(`\nTotal: ${labeled} labeled, ${blocked} blocked, ${skipped} skipped`);
    } catch (err: any) {
      log("ERROR", "organize", `Failed: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
