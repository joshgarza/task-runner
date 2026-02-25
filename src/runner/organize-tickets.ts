// Triage Linear tickets and label unblocked ones as agent-ready

import { loadConfig, getProjectConfig } from "../config.ts";
import { log } from "../logger.ts";
import { fetchIssuesByTeamAndStates, fetchBlockingRelations } from "../linear/queries.ts";
import { transitionIssue, setIssueLabels, addComment } from "../linear/mutations.ts";
import { getLinearClient } from "../linear/client.ts";
import { spawnAgent } from "../agents/spawn.ts";
import { buildContextPrompt } from "../agents/context-prompt.ts";
import type { OrganizeTicketsOptions, OrganizeTicketResult, ContextResult, LinearIssue } from "../types.ts";

/**
 * Collect all nodes from a paginated Linear connection
 */
async function collectAllNodes<T>(connection: { nodes: T[]; fetchNext: () => Promise<{ nodes: T[]; fetchNext: () => Promise<any>; pageInfo: { hasNextPage: boolean } }>; pageInfo: { hasNextPage: boolean } }): Promise<T[]> {
  const all: T[] = [...connection.nodes];
  let current = connection;
  while (current.pageInfo.hasNextPage) {
    current = await current.fetchNext();
    all.push(...current.nodes);
  }
  return all;
}

/**
 * Resolve label names to IDs for a given team.
 * Includes both team-scoped and workspace-level labels, and paginates
 * to avoid missing labels when there are more than one page.
 */
async function resolveTeamLabels(teamKey: string): Promise<Map<string, string>> {
  const client = getLinearClient();
  const teams = await client.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team not found: ${teamKey}`);

  const labelMap = new Map<string, string>();

  // Fetch team-scoped labels (paginated)
  const teamLabelsConn = await team.labels({ first: 250 });
  const teamLabels = await collectAllNodes(teamLabelsConn);
  for (const label of teamLabels) {
    labelMap.set((label as any).name, (label as any).id);
  }

  // Fetch workspace-level labels (paginated) so labels not scoped to a
  // team are still resolved (e.g. a workspace-level "agent-ready" label)
  const wsLabelsConn = await client.issueLabels({ first: 250 });
  const wsLabels = await collectAllNodes(wsLabelsConn);
  for (const label of wsLabels) {
    // Team labels take precedence — only add workspace labels that are not
    // already in the map
    if (!labelMap.has((label as any).name)) {
      labelMap.set((label as any).name, (label as any).id);
    }
  }

  return labelMap;
}

/**
 * Get the current label IDs for an issue (paginated to handle >50 labels)
 */
async function getIssueLabelIds(issueId: string): Promise<string[]> {
  const client = getLinearClient();
  const issue = await client.issue(issueId);
  const labelsConn = await issue.labels({ first: 250 });
  const allLabels = await collectAllNodes(labelsConn);
  return allLabels.map((l: any) => l.id);
}

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
    toolsFile: "context-tools.json",
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
    // Skip issues that already have all the labels we'd add and none we'd remove
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

    // Check for blocking relations
    const allBlockers = await fetchBlockingRelations(issue.id);
    const activeBlockers = allBlockers.filter((b) => !b.done);

    if (activeBlockers.length > 0) {
      const blockerList = activeBlockers.map((b) => `${b.identifier} (${b.stateName})`);
      log("INFO", issue.identifier, `${prefix}Blocked by: ${blockerList.join(", ")}`);
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        action: "blocked",
        labelsAdded: [],
        labelsRemoved: [],
        blockedBy: activeBlockers.map((b) => b.identifier),
        reason: `Blocked by ${blockerList.join(", ")}`,
      });
      continue;
    }

    // Not blocked — gather context if enabled
    let contextGathered = false;
    if (opts.context && opts.project && !dryRun) {
      try {
        const projectConfig = getProjectConfig(opts.project);
        const context = gatherContext(issue, projectConfig.repoPath);
        if (context) {
          const comment = formatContextComment(context);
          await addComment(issue.id, comment);
          contextGathered = true;
        }
      } catch (err: any) {
        log("WARN", issue.identifier, `Context gathering failed: ${err.message}`);
      }
    }

    // Apply label changes
    const labelsAdded: string[] = [];
    const labelsRemoved: string[] = [];

    if (!dryRun) {
      const currentLabelIds = await getIssueLabelIds(issue.id);
      const newLabelIds = new Set(currentLabelIds);

      for (const name of addLabels) {
        const id = teamLabels.get(name);
        if (id && !newLabelIds.has(id)) {
          newLabelIds.add(id);
          labelsAdded.push(name);
        }
      }

      for (const name of removeLabels) {
        const id = teamLabels.get(name);
        if (id && newLabelIds.has(id)) {
          newLabelIds.delete(id);
          labelsRemoved.push(name);
        }
      }

      if (labelsAdded.length > 0 || labelsRemoved.length > 0) {
        await setIssueLabels(issue.id, [...newLabelIds]);
      }
    } else {
      // Dry run — compute what would change
      for (const name of addLabels) {
        if (!issue.labels.includes(name) && teamLabels.has(name)) {
          labelsAdded.push(name);
        }
      }

      for (const name of removeLabels) {
        if (issue.labels.includes(name) && teamLabels.has(name)) {
          labelsRemoved.push(name);
        }
      }
    }

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
