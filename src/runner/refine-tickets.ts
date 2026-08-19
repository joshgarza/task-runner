// Refine Linear tickets with local Codex codebase exploration, execution
// routing, and blocking relations.

import { loadConfig, getProjectConfig } from "../config.ts";
import { log } from "../logger.ts";
import { fetchIssuesByTeamAndStates, fetchIssue } from "../linear/queries.ts";
import { updateIssue, createBlockingRelation, setIssueLabels } from "../linear/mutations.ts";
import { resolveTeamLabels } from "../linear/labels.ts";
import { getLinearClient } from "../linear/client.ts";
import { collectAllNodes } from "../linear/labels.ts";
import { runLocalCodex } from "../agents/spawn.ts";
import { buildRefinePrompt, REFINE_AGENT_OUTPUT_SCHEMA } from "../prompts/refine-prompt.ts";
import { EXECUTION_ROUTES } from "../execution-route.ts";
import type {
  RefineTicketsOptions,
  RefineTicketResult,
  RefineAgentOutput,
  LinearIssue,
} from "../types.ts";

const REFINED_MARKER = "<!-- refined -->";

function isAlreadyRefined(description: string | null): boolean {
  return !!description && description.includes(REFINED_MARKER);
}

/**
 * Parse the exploration agent's JSON output into a structured result.
 */
function parseRefineOutput(raw: string, issueId: string): RefineAgentOutput | null {
  try {
    return JSON.parse(raw) as RefineAgentOutput;
  } catch (err: any) {
    log("WARN", issueId, `No structured output found in refine agent response: ${err.message}`);
    return null;
  }
}

/**
 * Build the updated description with codebase context and refined marker.
 */
function buildRefinedDescription(
  original: string | null,
  addendum: string,
  relevantFiles: string[]
): string {
  const parts: string[] = [];

  if (original) {
    parts.push(original);
  }

  parts.push("");
  parts.push("## Codebase Context (auto-generated)");
  parts.push("");
  parts.push(addendum);

  if (relevantFiles.length > 0) {
    parts.push("");
    parts.push("### Relevant Files");
    parts.push("");
    for (const file of relevantFiles) {
      parts.push(`- \`${file}\``);
    }
  }

  parts.push("");
  parts.push(REFINED_MARKER);

  return parts.join("\n");
}

/**
 * Resolve blocking relations from dependency identifiers.
 * Returns only valid issue IDs that exist in Linear.
 */
async function resolveBlockingIssueIds(
  dependencies: string[],
  issueIdentifier: string
): Promise<{ identifier: string; id: string }[]> {
  const resolved: { identifier: string; id: string }[] = [];

  for (const dep of dependencies) {
    try {
      const depIssue = await fetchIssue(dep);
      resolved.push({ identifier: depIssue.identifier, id: depIssue.id });
    } catch (err: any) {
      log("WARN", issueIdentifier, `Dependency "${dep}" not found, skipping`);
    }
  }

  return resolved;
}

/**
 * Check if a blocking relation already exists between two issues.
 */
async function hasBlockingRelation(
  blockedIssueId: string,
  blockerIssueId: string
): Promise<boolean> {
  const client = getLinearClient();
  const issue = await client.issue(blockedIssueId);

  const relations = await issue.relations({ first: 250 });
  for (const rel of relations.nodes) {
    if (rel.type === "blocked_by") {
      const related = await rel.relatedIssue;
      if (related?.id === blockerIssueId) return true;
    }
  }

  if (typeof issue.inverseRelations === "function") {
    const inverseRelations = await issue.inverseRelations({ first: 250 });
    for (const rel of inverseRelations.nodes) {
      if (rel.type === "blocks") {
        const source = await rel.issue;
        if (source?.id === blockerIssueId) return true;
      }
    }
  }

  return false;
}

export async function refineTickets(
  opts: RefineTicketsOptions
): Promise<RefineTicketResult[]> {
  const config = loadConfig();
  const dryRun = opts.dryRun ?? false;
  const prefix = dryRun ? "[dry-run] " : "";
  const targetStates = [config.linear.todoState, "Backlog"];

  log("INFO", "refine", `${prefix}Fetching tickets for team ${opts.team} in states: ${targetStates.join(", ")}`);

  // Fetch all candidate tickets
  const issues = await fetchIssuesByTeamAndStates(opts.team, targetStates, opts.project);

  if (issues.length === 0) {
    log("INFO", "refine", `${prefix}No tickets found`);
    return [];
  }

  log("INFO", "refine", `${prefix}Found ${issues.length} ticket(s) to evaluate`);

  // Build sibling identifier list (for dependency detection)
  const siblingIdentifiers = issues.map((i) => i.identifier);

  // Determine repo path for agent cwd (if project is specified)
  let repoPath: string | undefined;
  if (opts.project) {
    try {
      const projectConfig = getProjectConfig(opts.project);
      repoPath = projectConfig.repoPath;
    } catch (err: any) {
      log("WARN", "refine", `Could not resolve repo path for project "${opts.project}": ${err.message}`);
    }
  }

  const results: RefineTicketResult[] = [];

  for (const issue of issues) {
    // Skip already-refined tickets
    if (isAlreadyRefined(issue.description)) {
      log("INFO", issue.identifier, `${prefix}Already refined, skipping`);
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        action: "skipped",
        reason: "Already refined",
      });
      continue;
    }

    // Spawn exploration agent
    const prompt = buildRefinePrompt(issue, [...EXECUTION_ROUTES], siblingIdentifiers);
    const agentCwd = repoPath ?? process.cwd();

    log("INFO", issue.identifier, `${prefix}Spawning refine agent...`);

    if (dryRun) {
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        action: "skipped",
        reason: "Dry run, would spawn refine agent",
      });
      continue;
    }

    const agentResult = await runLocalCodex({
      prompt,
      cwd: agentCwd,
      model: config.defaults.contextModel,
      reasoningEffort: config.defaults.contextReasoningEffort,
      profile: "read",
      timeoutMs: config.defaults.agentTimeoutMs,
      context: `refine-${issue.identifier}`,
      outputSchema: REFINE_AGENT_OUTPUT_SCHEMA,
    });

    if (!agentResult.success) {
      log("WARN", issue.identifier, `Refine agent failed (exit=${agentResult.exitCode})`);
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        action: "failed",
        reason: `Agent failed with exit code ${agentResult.exitCode}`,
      });
      continue;
    }

    // Parse agent output
    const output = parseRefineOutput(agentResult.output, issue.identifier);
    if (!output) {
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        action: "failed",
        reason: "Could not parse agent output",
      });
      continue;
    }

    // Build the description, but do not persist the refined marker until the
    // execution route has been stored successfully.
    const newDescription = buildRefinedDescription(
      issue.description,
      output.descriptionAddendum,
      output.relevantFiles
    );

    if (!EXECUTION_ROUTES.includes(output.executionRoute)) {
      const reason = `Codex suggested unknown route "${output.executionRoute}"`;
      log("WARN", issue.identifier, reason);
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        action: "failed",
        reason,
      });
      continue;
    }

    // Replace legacy agent labels and any prior execution route with the
    // suggested route. This must succeed before the refined marker is written,
    // otherwise an ops recommendation could be retried later as local work.
    const executionLabel = `execution:${output.executionRoute}`;
    try {
      const client = getLinearClient();
      const fullIssue = await client.issue(issue.id);
      const labelsConn = await fullIssue.labels({ first: 250 });
      const allLabels = await collectAllNodes(labelsConn);
      const retainedLabelIds = allLabels
        .filter((label: any) =>
          !label.name.startsWith("agent:") && !label.name.startsWith("execution:")
        )
        .map((label: any) => label.id);

      const teamLabels = await resolveTeamLabels(opts.team);
      const executionLabelId = teamLabels.get(executionLabel);
      if (!executionLabelId) {
        throw new Error(`Label "${executionLabel}" not found in team ${opts.team}`);
      }

      await setIssueLabels(issue.id, [...retainedLabelIds, executionLabelId]);
      log("OK", issue.identifier, `Set execution route: ${output.executionRoute}`);
    } catch (err: any) {
      const reason = `Failed to set execution route: ${err.message}`;
      log("WARN", issue.identifier, reason);
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        action: "failed",
        reason,
      });
      continue;
    }

    try {
      await updateIssue(issue.id, opts.team, { description: newDescription });
      log("OK", issue.identifier, `Description updated with codebase context`);
    } catch (err: any) {
      const reason = `Failed to update description: ${err.message}`;
      log("WARN", issue.identifier, reason);
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        action: "failed",
        executionRoute: output.executionRoute,
        reason,
      });
      continue;
    }

    // Wire blocking relations from dependencies
    const dependenciesAdded: string[] = [];
    if (output.dependencies.length > 0) {
      const blockers = await resolveBlockingIssueIds(output.dependencies, issue.identifier);

      for (const blocker of blockers) {
        try {
          const exists = await hasBlockingRelation(issue.id, blocker.id);
          if (exists) {
            log("INFO", issue.identifier, `Blocking relation with ${blocker.identifier} already exists`);
            continue;
          }

          await createBlockingRelation(issue.id, blocker.id);
          dependenciesAdded.push(blocker.identifier);
          log("OK", issue.identifier, `Added blocking relation: blocked by ${blocker.identifier}`);
        } catch (err: any) {
          log("WARN", issue.identifier, `Failed to create relation with ${blocker.identifier}: ${err.message}`);
        }
      }
    }

    results.push({
      identifier: issue.identifier,
      title: issue.title,
      action: "refined",
      executionRoute: output.executionRoute,
      dependenciesAdded: dependenciesAdded.length > 0 ? dependenciesAdded : undefined,
      reason: `Refined: execution=${output.executionRoute}, deps=${output.dependencies.length}, files=${output.relevantFiles.length}`,
    });
  }

  // Summary
  const refined = results.filter((r) => r.action === "refined").length;
  const skipped = results.filter((r) => r.action === "skipped").length;
  const failed = results.filter((r) => r.action === "failed").length;
  log("INFO", "refine", `${prefix}Summary: ${refined} refined, ${skipped} skipped, ${failed} failed`);

  return results;
}
