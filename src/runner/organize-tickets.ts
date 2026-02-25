// Triage Linear tickets and label unblocked ones as agent-ready

import { loadConfig } from "../config.ts";
import { log } from "../logger.ts";
import { fetchIssuesByTeamAndStates, fetchBlockingRelations } from "../linear/queries.ts";
import { transitionIssue, setIssueLabels } from "../linear/mutations.ts";
import { getLinearClient } from "../linear/client.ts";
import type { OrganizeTicketsOptions, OrganizeTicketResult } from "../types.ts";

/**
 * Resolve label names to IDs for a given team
 */
async function resolveTeamLabels(teamKey: string): Promise<Map<string, string>> {
  const client = getLinearClient();
  const teams = await client.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`Team not found: ${teamKey}`);

  const labels = await team.labels();
  const labelMap = new Map<string, string>();
  for (const label of labels.nodes) {
    labelMap.set(label.name, label.id);
  }
  return labelMap;
}

/**
 * Get the current label IDs for an issue
 */
async function getIssueLabelIds(issueId: string): Promise<string[]> {
  const client = getLinearClient();
  const issue = await client.issue(issueId);
  const labels = await issue.labels();
  return labels.nodes.map((l: any) => l.id);
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

    // Not blocked — apply label changes
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
