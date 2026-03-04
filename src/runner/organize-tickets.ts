// Triage Linear tickets and label unblocked ones as agent-ready

import { loadConfig, getProjectConfig } from "../config.ts";
import { log } from "../logger.ts";
import { fetchIssuesByTeamAndStates, fetchBlockingRelations } from "../linear/queries.ts";
import { transitionIssue, addComment } from "../linear/mutations.ts";
import { collectAllNodes, resolveTeamLabels, applyLabelChanges } from "../linear/labels.ts";
import { getLinearClient } from "../linear/client.ts";
import { spawnAgent } from "../agents/spawn.ts";
import { buildContextPrompt } from "../agents/context-prompt.ts";
import type { OrganizeTicketsOptions, OrganizeTicketResult, ContextResult, LinearIssue } from "../types.ts";

/**
 * Spawn a headless Claude instance to gather codebase context for a ticket.
 * Returns parsed context or null on failure.
 */
function gatherContext(issue: LinearIssue, repoPath: string): ContextResult | null {
  const config = loadConfig();
  const prompt = buildContextPrompt(issue);

  log("INFO", issue.identifier, `Gathering codebase context...`);

  const result = spawnAgent({
    prompt,
    cwd: repoPath,
    model: config.defaults.contextModel,
    maxTurns: config.defaults.contextMaxTurns,
    maxBudgetUsd: config.defaults.contextMaxBudgetUsd,
    agentType: "context",
    timeoutMs: config.defaults.agentTimeoutMs,
    context: `context-${issue.identifier}`,
  });

  if (!result.success) {
    log("WARN", issue.identifier, `Context agent failed (exit=${result.exitCode})`);
    return null;
  }

  // Parse the JSON output (claude --output-format json wraps in { result: ... })
  let text = result.output;
  try {
    const parsed = JSON.parse(result.output);
    if (parsed.result) text = parsed.result;
  } catch {
    // Use raw output
  }

  const jsonMatch = text.match(/\{[\s\S]*"relevantFiles"[\s\S]*\}/);
  if (!jsonMatch) {
    log("WARN", issue.identifier, `No structured context found in agent output`);
    return null;
  }

  try {
    const context = JSON.parse(jsonMatch[0]) as ContextResult;
    log("OK", issue.identifier, `Context gathered: ${context.relevantFiles.length} files, ${context.acceptanceCriteria.length} criteria`);
    return context;
  } catch {
    log("WARN", issue.identifier, `Failed to parse context JSON`);
    return null;
  }
}

/**
 * Format context result as a Linear comment body
 */
function formatContextComment(context: ContextResult): string {
  const lines: string[] = ["## Codebase Context (auto-generated)", ""];

  lines.push(context.codeContext, "");

  if (context.relevantFiles.length > 0) {
    lines.push("### Relevant Files", "");
    for (const file of context.relevantFiles) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
  }

  if (context.acceptanceCriteria.length > 0) {
    lines.push("### Suggested Acceptance Criteria", "");
    for (const criterion of context.acceptanceCriteria) {
      lines.push(`- [ ] ${criterion}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function organizeTickets(opts: OrganizeTicketsOptions): Promise<OrganizeTicketResult[]> {
  const config = loadConfig();
  const dryRun = opts.dryRun ?? false;
  const targetStates = opts.states ?? [config.linear.todoState, "Backlog"];
  const agentLabel = config.linear.agentLabel;
  const todoState = config.linear.todoState;

  const addLabels = opts.addLabels ?? [agentLabel];
  const removeLabels = opts.removeLabels ?? [];

  const prefix = dryRun ? "[dry-run] " : "";

  log("INFO", "organize", `${prefix}Fetching issues for team ${opts.team} in states: ${targetStates.join(", ")}`);

  // Fetch issues
  const issues = await fetchIssuesByTeamAndStates(opts.team, targetStates, opts.project);

  if (issues.length === 0) {
    log("INFO", "organize", `${prefix}No issues found`);
    return [];
  }

  log("INFO", "organize", `${prefix}Found ${issues.length} issue(s) to evaluate`);

  // Resolve team label names to IDs
  const teamLabels = await resolveTeamLabels(opts.team);

  // Validate requested labels exist
  for (const name of [...addLabels, ...removeLabels]) {
    if (!teamLabels.has(name)) {
      log("WARN", "organize", `Label "${name}" not found in team ${opts.team}`);
    }
  }

  const results: OrganizeTicketResult[] = [];

  for (const issue of issues) {
    // Reject tickets requiring human approval — never label these agent-ready,
    // and strip any stale agent-ready or agent:<type> labels that may exist.
    if (issue.labels.includes(config.linear.needsApprovalLabel)) {
      const staleAgentLabels = issue.labels.filter(
        (l) => l === agentLabel || l.startsWith("agent:")
      );
      let labelsRemoved: string[] = [];

      if (staleAgentLabels.length > 0) {
        const result = await applyLabelChanges(issue.id, teamLabels, [], staleAgentLabels, dryRun);
        labelsRemoved = result.labelsRemoved;
        if (labelsRemoved.length > 0) {
          log("INFO", issue.identifier, `${prefix}Removed stale labels: ${labelsRemoved.join(", ")}`);
        }
      }

      log("INFO", issue.identifier, `${prefix}Needs human approval — skipping`);
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        action: "blocked",
        labelsAdded: [],
        labelsRemoved,
        reason: "Needs human approval",
      });
      continue;
    }

    // Always check blocking relations first — a ticket may have been labeled
    // agent-ready in a previous run but gained blockers since then.
    const allBlockers = await fetchBlockingRelations(issue.id);
    const activeBlockers = allBlockers.filter((b) => !b.done);

    if (activeBlockers.length > 0) {
      const blockerList = activeBlockers.map((b) => `${b.identifier} (${b.stateName})`);

      // Strip addLabels (e.g. agent-ready) from blocked tickets to prevent
      // drain from picking them up and immediately failing.
      const hasAnyAddLabel = addLabels.some((l) => issue.labels.includes(l));
      let labelsRemoved: string[] = [];

      if (hasAnyAddLabel) {
        const result = await applyLabelChanges(issue.id, teamLabels, [], addLabels, dryRun);
        labelsRemoved = result.labelsRemoved;
        if (labelsRemoved.length > 0) {
          log("INFO", issue.identifier, `${prefix}Removed stale labels: ${labelsRemoved.join(", ")}`);
        }
      }

      log("INFO", issue.identifier, `${prefix}Blocked by: ${blockerList.join(", ")}`);
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        action: "blocked",
        labelsAdded: [],
        labelsRemoved,
        blockedBy: activeBlockers.map((b) => b.identifier),
        reason: `Blocked by ${blockerList.join(", ")}`,
      });
      continue;
    }

    // Skip unblocked issues that already have all target labels and state
    const hasAllAddLabels = addLabels.every((l) => issue.labels.includes(l));
    const hasNoRemoveLabels = removeLabels.every((l) => !issue.labels.includes(l));

    if (hasAllAddLabels && hasNoRemoveLabels && issue.stateName === todoState) {
      log("INFO", issue.identifier, `${prefix}Already organized, skipping`);
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        action: "skipped",
        labelsAdded: [],
        labelsRemoved: [],
        reason: "Already has target labels",
      });
      continue;
    }

    // Not blocked — gather context if enabled
    let contextGathered = false;
    if (opts.context && opts.project && !dryRun) {
      try {
        // Check if a context comment already exists to avoid duplicates on re-runs
        const client = getLinearClient();
        const fullIssue = await client.issue(issue.id);
        const commentsConn = await fullIssue.comments({ first: 250 });
        const allComments = await collectAllNodes(commentsConn);
        const hasContext = allComments.some((c: any) =>
          c.body?.startsWith("## Codebase Context (auto-generated)")
        );

        if (hasContext) {
          log("INFO", issue.identifier, `Context comment already exists, skipping`);
        } else {
          const projectConfig = getProjectConfig(opts.project);
          const context = gatherContext(issue, projectConfig.repoPath);
          if (context) {
            const comment = formatContextComment(context);
            await addComment(issue.id, comment);
            contextGathered = true;
          }
        }
      } catch (err: any) {
        log("WARN", issue.identifier, `Context gathering failed: ${err.message}`);
      }
    }

    // Apply label changes
    const { labelsAdded, labelsRemoved } = await applyLabelChanges(
      issue.id,
      teamLabels,
      addLabels,
      removeLabels,
      dryRun
    );

    // Transition to Todo if not already there
    let stateChange: string | undefined;
    if (issue.stateName !== todoState) {
      if (!dryRun) {
        await transitionIssue(issue.id, opts.team, todoState);
      }
      stateChange = `${issue.stateName} -> ${todoState}`;
    }

    const changes: string[] = [];
    if (labelsAdded.length > 0) changes.push(`+${labelsAdded.join(", +")}`);
    if (labelsRemoved.length > 0) changes.push(`-${labelsRemoved.join(", -")}`);
    if (stateChange) changes.push(stateChange);
    const changeStr = changes.length > 0 ? changes.join("; ") : "no changes needed";

    log("OK", issue.identifier, `${prefix}${changeStr}`);

    results.push({
      identifier: issue.identifier,
      title: issue.title,
      action: "labeled",
      labelsAdded,
      labelsRemoved,
      stateChange,
      contextGathered: contextGathered || undefined,
      reason: `Unblocked: ${changeStr}`,
    });
  }

  // Summary
  const labeled = results.filter((r) => r.action === "labeled").length;
  const blocked = results.filter((r) => r.action === "blocked").length;
  const skipped = results.filter((r) => r.action === "skipped").length;
  log("INFO", "organize", `${prefix}Summary: ${labeled} labeled, ${blocked} blocked, ${skipped} skipped`);

  return results;
}
