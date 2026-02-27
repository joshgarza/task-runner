#!/usr/bin/env node

// Entry: run <id>, drain, review <pr>, standup

import { Command } from "commander";
import { runIssue } from "./runner/run-issue.ts";
import { drain } from "./runner/drain.ts";
import { reviewPR } from "./runner/review.ts";
import { standup } from "./runner/standup.ts";
import { addTicket } from "./runner/add-ticket.ts";
import { editTicket } from "./runner/edit-ticket.ts";
import { createLabel } from "./runner/create-label.ts";
import { listTickets } from "./runner/list-tickets.ts";
import { organizeTickets } from "./runner/organize-tickets.ts";
import { loadRegistry, listAgentTypes, resolveAgentType } from "./agents/registry.ts";
import { listProposals, approveProposal, rejectProposal, getProposal } from "./agents/proposals.ts";
import { loadConfig, detectProjectFromCwd } from "./config.ts";
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
  .description("Drain all agent-ready issues with configurable concurrency")
  .option("--label <label>", "Label to filter by")
  .option("--project <project>", "Linear project name to filter by")
  .option("--limit <n>", "Maximum issues to process", (v: string) => parseInt(v, 10))
  .option("--concurrency <n>", "Number of parallel agents (default: from config)", (v: string) => parseInt(v, 10))
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
      const detected = detectProjectFromCwd();
      await standup({ days: opts.days, project: opts.project ?? detected?.project });
    } catch (err: any) {
      log("ERROR", "standup", `Standup failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("add-ticket <title>")
  .description("Create a new Linear issue")
  .option("--team <key>", "Team key (e.g. JOS) — auto-detected from cwd if omitted")
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
      const detected = detectProjectFromCwd();
      const team = opts.team ?? detected?.team;
      if (!team) {
        log("ERROR", "add-ticket", "--team is required (could not auto-detect from cwd)");
        process.exit(1);
      }

      const result = await addTicket(title, {
        team,
        description: opts.description,
        labels: opts.labels,
        priority: opts.priority,
        project: opts.project ?? detected?.project,
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
  .option("--add-labels <labels...>", "Space-separated labels to add (preserves existing)")
  .option("--status <name>", "Workflow state name")
  .option("--assignee <email>", "Assignee email address")
  .action(async (identifier: string, opts) => {
    try {
      const result = await editTicket(identifier, {
        title: opts.title,
        description: opts.description,
        priority: opts.priority,
        labels: opts.labels,
        addLabels: opts.addLabels,
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

program
  .command("list-tickets")
  .description("List Linear issues with filtering")
  .requiredOption("--team <key>", "Team key (e.g. JOS)")
  .option("--status <states...>", "Filter by workflow state names")
  .option("--project <name>", "Filter by Linear project name")
  .option("--labels <labels...>", "Filter by label names")
  .option("--comments", "Include comment bodies for each issue")
  .action(async (opts) => {
    try {
      await listTickets({
        team: opts.team,
        status: opts.status,
        project: opts.project,
        labels: opts.labels,
        comments: opts.comments,
      });
    } catch (err: any) {
      log("ERROR", "list-tickets", `Failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("organize-tickets")
  .description("Triage Linear tickets and label unblocked ones as agent-ready")
  .option("--team <key>", "Team key (e.g. JOS) — auto-detected from cwd if omitted")
  .option("--project <name>", "Linear project name to filter by")
  .option("--states <states...>", "Workflow states to include (default: Todo, Backlog)")
  .option("--add-label <labels...>", "Labels to add to unblocked tickets (default: agent-ready)")
  .option("--remove-label <labels...>", "Labels to remove from unblocked tickets")
  .option("--context", "Gather codebase context via LLM for unblocked tickets (requires --project)")
  .option("--dry-run", "Preview changes without applying")
  .action(async (opts) => {
    try {
      const detected = detectProjectFromCwd();
      const team = opts.team ?? detected?.team;
      const project = opts.project ?? detected?.project;

      if (!team) {
        log("ERROR", "organize", "--team is required (could not auto-detect from cwd)");
        process.exit(1);
      }

      if (opts.context && !project) {
        log("ERROR", "organize", "--context requires --project to determine the repo path");
        process.exit(1);
      }

      const results = await organizeTickets({
        team,
        project,
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

program
  .command("list-agents")
  .description("Show all registered agent types")
  .option("--verbose", "Show full tool list for each agent type")
  .action((opts) => {
    try {
      const registry = loadRegistry();
      const types = listAgentTypes(registry);

      console.log("\n--- Agent Types ---\n");
      for (const agent of types) {
        console.log(`  ${agent.name}`);
        console.log(`    ${agent.description}`);
        console.log(`    Tools: ${agent.tools.length} | Budget: $${agent.maxBudgetUsd} | Turns: ${agent.maxTurns}`);
        console.log(`    Created by: ${agent.audit.createdBy}`);
        if (opts.verbose) {
          console.log(`    Tools list:`);
          for (const tool of agent.tools) {
            console.log(`      - ${tool}`);
          }
        }
        console.log();
      }
      console.log(`Total: ${types.length} agent types`);
    } catch (err: any) {
      log("ERROR", "list-agents", `Failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("pending-proposals")
  .description("List agent type proposals awaiting human approval")
  .option("--all", "Show all proposals (including resolved)")
  .action((opts) => {
    try {
      const proposals = opts.all ? listProposals() : listProposals("pending");

      if (proposals.length === 0) {
        console.log("\nNo pending proposals.");
        return;
      }

      console.log("\n--- Proposals ---\n");
      for (const p of proposals) {
        const statusIcon = p.status === "pending" ? "[?]" : p.status === "approved" ? "[+]" : "[-]";
        console.log(`  ${statusIcon} ${p.id}`);
        console.log(`    Issue: ${p.issueIdentifier} — ${p.issueTitle}`);
        console.log(`    Base type: ${p.baseAgentType} → Proposed: ${p.proposedAgentType}`);
        console.log(`    Missing: ${p.failureAnalysis.missingCapabilities.join(", ") || "unknown"}`);
        console.log(`    Created: ${p.createdAt}`);
        if (p.status !== "pending") {
          console.log(`    Status: ${p.status}${p.rejectionReason ? ` (${p.rejectionReason})` : ""}`);
        }
        console.log();
      }

      const pending = proposals.filter((p) => p.status === "pending").length;
      console.log(`Total: ${proposals.length} proposals (${pending} pending)`);
    } catch (err: any) {
      log("ERROR", "pending-proposals", `Failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("approve-agent <id>")
  .description("Approve or reject an agent type proposal")
  .option("--reject", "Reject the proposal instead of approving")
  .option("--reason <text>", "Reason for rejection (required with --reject)")
  .action(async (id: string, opts) => {
    try {
      // Show proposal details first
      const proposal = getProposal(id);
      console.log(`\nProposal: ${proposal.id}`);
      console.log(`Issue: ${proposal.issueIdentifier} — ${proposal.issueTitle}`);
      console.log(`Base type: ${proposal.baseAgentType}`);
      console.log(`Proposed type: ${proposal.proposedAgentType}`);
      console.log(`Proposed tools:`);
      for (const tool of proposal.proposedTools) {
        console.log(`  - ${tool}`);
      }
      console.log(`Budget: $${proposal.proposedMaxBudgetUsd} | Turns: ${proposal.proposedMaxTurns}`);
      console.log();

      if (opts.reject) {
        if (!opts.reason) {
          log("ERROR", "approve-agent", "--reason is required when rejecting");
          process.exit(1);
        }
        const result = await rejectProposal(id, opts.reason);
        console.log(`Rejected proposal ${result.id}`);
      } else {
        const config = loadConfig();
        const result = await approveProposal(id, config);
        console.log(`Approved proposal ${result.id}`);
        console.log(`New agent type "${result.proposedAgentType}" added to registry`);
      }
    } catch (err: any) {
      log("ERROR", "approve-agent", `Failed: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
