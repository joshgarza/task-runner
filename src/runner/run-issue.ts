// Full pipeline: fetch → worktree → agent → validate → push → PR → review

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, getProjectConfig } from "../config.ts";
import { log, logToFile } from "../logger.ts";
import { fetchIssue, fetchBlockingRelations } from "../linear/queries.ts";
import { transitionIssue, addComment, createChildIssue } from "../linear/mutations.ts";
import { createWorktree, removeWorktree } from "../git/worktree.ts";
import { getBranchName } from "../git/worktree.ts";
import { hasCommits, pushBranch, createPR, addPRLabel, addPRComment } from "../git/branch.ts";
import { spawnAgent } from "../agents/spawn.ts";
import { loadRegistry } from "../agents/registry.ts";
import { dispatch } from "../agents/dispatcher.ts";
import { analyzeFailure } from "../agents/failure-analysis.ts";
import { createProposal } from "../agents/proposals.ts";
import { buildWorkerPrompt } from "../agents/worker-prompt.ts";
import { buildReviewPrompt } from "../agents/review-prompt.ts";
import { validateAgentOutput } from "../validation/validate.ts";
import type { RunOptions, RunResult, ReviewVerdict } from "../types.ts";

export async function runIssue(
  identifier: string,
  options: RunOptions = {}
): Promise<RunResult> {
  const startTime = Date.now();
  const config = loadConfig();

  const model = options.model ?? config.defaults.model;
  const maxTurns = options.maxTurns ?? config.defaults.maxTurns;
  const maxBudgetUsd = options.maxBudgetUsd ?? config.defaults.maxBudgetUsd;
  const maxAttempts = options.maxAttempts ?? config.defaults.maxAttempts;

  let transitionedToInProgress = false;

  log("INFO", identifier, `Starting pipeline (model: ${model}, attempts: ${maxAttempts})`);

  // 1. Fetch issue from Linear
  let issue;
  try {
    issue = await fetchIssue(identifier);
    log("INFO", identifier, `Fetched: "${issue.title}" (state: ${issue.stateName}, project: ${issue.projectName ?? "none"})`);
  } catch (err: any) {
    return failure(identifier, `Failed to fetch issue: ${err.message}`, startTime, 0);
  }

  if (options.dryRun) {
    log("INFO", identifier, "Dry run — stopping after fetch");
    return {
      issueId: identifier,
      success: true,
      durationMs: Date.now() - startTime,
      attempts: 0,
    };
  }

  // 2. Validate state
  const validStates = [config.linear.todoState, "Backlog"];
  if (!validStates.includes(issue.stateName)) {
    return failure(
      identifier,
      `Issue is in "${issue.stateName}" state, expected one of: ${validStates.join(", ")}`,
      startTime,
      0
    );
  }

  // 2.3. Reject tickets requiring human approval
  if (issue.labels.includes(config.linear.needsApprovalLabel)) {
    return failure(
      identifier,
      `Issue has "${config.linear.needsApprovalLabel}" label — requires human approval before agent can proceed`,
      startTime,
      0
    );
  }

  // 2.5. Blocking safety net — re-check blocking relations before committing resources
  try {
    const blockers = await fetchBlockingRelations(issue.id);
    const activeBlockers = blockers.filter((b) => !b.done);
    if (activeBlockers.length > 0) {
      const blockerList = activeBlockers.map((b) => `${b.identifier} ("${b.title}", ${b.stateName})`).join(", ");
      return failure(
        identifier,
        `Issue is blocked by ${activeBlockers.length} active issue(s): ${blockerList}`,
        startTime,
        0
      );
    }
  } catch (err: any) {
    log("WARN", identifier, `Failed to check blocking relations: ${err.message}`);
    // Non-fatal — proceed if the check fails (e.g. API error)
  }

  // 3. Resolve project config (issue must belong to a configured project)
  if (!issue.projectName) {
    return failure(identifier, "Issue has no project assigned. Assign it to a Linear project.", startTime, 0);
  }

  let projectConfig;
  try {
    projectConfig = getProjectConfig(issue.projectName);
  } catch (err: any) {
    return failure(identifier, err.message, startTime, 0);
  }

  // 4. Transition to In Progress
  try {
    await transitionIssue(issue.id, issue.teamKey, config.linear.inProgressState);
    await addComment(issue.id, `🤖 Agent starting work (model: ${model}, max-turns: ${maxTurns})`);
    transitionedToInProgress = true;
    log("INFO", identifier, `Transitioned to "${config.linear.inProgressState}"`);
  } catch (err: any) {
    log("WARN", identifier, `Failed to transition issue: ${err.message}`);
  }

  // 5. Create worktree
  let worktreePath: string;
  try {
    worktreePath = createWorktree(projectConfig.repoPath, identifier, projectConfig.defaultBranch, projectConfig.branchPrefix);
  } catch (err: any) {
    await rollbackInProgress(transitionedToInProgress, issue, config, identifier, `Failed to create worktree: ${err.message}`);
    return failure(identifier, `Failed to create worktree: ${err.message}`, startTime, 0);
  }

  const branch = getBranchName(identifier, projectConfig.branchPrefix);
  let attempts = 0;
  let lastError = "";
  let pipelineSucceeded = false;

  // 5.5. Dispatch: select agent type from registry based on issue labels
  const registry = loadRegistry();
  const dispatchResult = dispatch(issue, registry);
  log("INFO", identifier, `Dispatch: ${dispatchResult.agentType} (${dispatchResult.reason})`);

  try {
    // 6. Spawn worker agent (with retry loop)
    for (attempts = 1; attempts <= maxAttempts; attempts++) {
      log("INFO", identifier, `Attempt ${attempts}/${maxAttempts}`);

      let prompt = buildWorkerPrompt(issue, projectConfig);

      // Prepend retry context if not first attempt
      if (attempts > 1 && lastError) {
        prompt = `IMPORTANT: A previous attempt failed with the following errors. Fix these issues:\n\n${lastError}\n\n---\n\n${prompt}`;
      }

      const agentResult = spawnAgent({
        prompt,
        cwd: worktreePath,
        model,
        maxTurns,
        maxBudgetUsd,
        agentType: dispatchResult.agentType,
        timeoutMs: config.defaults.agentTimeoutMs,
        context: identifier,
      });

      // Save agent log
      const logFilename = `${identifier}-attempt${attempts}.json`;
      logToFile(
        logFilename,
        JSON.stringify(
          {
            issue: { identifier, title: issue.title },
            agentType: dispatchResult.agentType,
            output: agentResult.output.slice(0, 50_000),
            stderr: agentResult.stderr.slice(0, 5_000),
            durationMs: agentResult.durationMs,
            success: agentResult.success,
            timestamp: new Date().toISOString(),
          },
          null,
          2
        )
      );

      if (!agentResult.success) {
        lastError = `Agent exited with code ${agentResult.exitCode}. stderr: ${agentResult.stderr.slice(0, 1000)}`;
        log("ERROR", identifier, `Agent failed: ${lastError.slice(0, 200)}`);

        // 6.5. Failure analysis: check if this is a permission issue
        const analysis = analyzeFailure(agentResult.output, agentResult.stderr);
        if (analysis.category === "permission_denied") {
          log("WARN", identifier, `Permission denied — creating proposal for capability escalation`);
          try {
            const proposal = await createProposal({
              issue,
              baseAgentType: dispatchResult.agentType,
              failureAnalysis: analysis,
              config,
            });
            log("INFO", identifier, `Created proposal ${proposal.id} — ticket needs human approval`);
          } catch (err: any) {
            log("WARN", identifier, `Failed to create proposal: ${err.message}`);
          }
          return failure(
            identifier,
            `Permission denied: agent type "${dispatchResult.agentType}" lacks required capabilities. Proposal created for human approval.`,
            startTime,
            attempts
          );
        }

        continue;
      }

      // 7. Validate output
      const validation = validateAgentOutput(
        worktreePath,
        projectConfig.defaultBranch,
        projectConfig,
        identifier
      );

      if (validation.valid) {
        if (validation.warnings.length > 0) {
          log("WARN", identifier, `Validation warnings: ${validation.warnings.join("; ")}`);
        }
        log("OK", identifier, "Validation passed");
        break;
      } else {
        lastError = validation.errors.join("\n");
        log("ERROR", identifier, `Validation failed: ${lastError}`);
        if (attempts >= maxAttempts) {
          await addComment(
            issue.id,
            `🤖 Agent failed after ${maxAttempts} attempt(s).\n\nErrors:\n${lastError}`
          );
          return failure(identifier, `Validation failed after ${maxAttempts} attempts: ${lastError}`, startTime, attempts);
        }
      }
    }

    // 8. Check we actually have commits to push
    if (!hasCommits(worktreePath, projectConfig.defaultBranch)) {
      return failure(identifier, "No commits produced by agent", startTime, attempts);
    }

    // 9. Push branch (runner does this, not the agent)
    try {
      pushBranch(worktreePath, branch, identifier);
    } catch (err: any) {
      return failure(identifier, `Push failed: ${err.message}`, startTime, attempts);
    }

    // 10. Create PR
    let prUrl: string;
    try {
      prUrl = createPR(worktreePath, issue, config.github.prLabels, projectConfig.defaultBranch);
    } catch (err: any) {
      return failure(identifier, `PR creation failed: ${err.message}`, startTime, attempts);
    }

    // 11. Link PR to Linear
    try {
      await addComment(issue.id, `🤖 PR created: ${prUrl}`);
    } catch {
      log("WARN", identifier, "Failed to comment PR link on Linear issue");
    }

    // 12. Spawn review agent
    let verdict: ReviewVerdict | undefined;
    try {
      verdict = await runReview(issue, projectConfig, prUrl, worktreePath, config, identifier);
    } catch (err: any) {
      log("WARN", identifier, `Review failed (non-fatal): ${err.message}`);
    }

    // 13. Act on verdict
    if (verdict) {
      if (verdict.approved) {
        log("OK", identifier, "Review: APPROVED");
        try {
          if (config.github.reviewApprovedLabel) {
            addPRLabel(prUrl, config.github.reviewApprovedLabel);
          }
          await transitionIssue(issue.id, issue.teamKey, config.linear.inReviewState);
          await addComment(issue.id, `🤖 Review passed: ${verdict.summary}`);
        } catch (err: any) {
          log("WARN", identifier, `Failed to label/transition after approval: ${err.message}`);
        }
      } else {
        log("WARN", identifier, `Review: NEEDS FIXES — ${verdict.summary}`);
        try {
          const issueBody = [
            `## Review Feedback for ${issue.identifier}`,
            "",
            verdict.summary,
            "",
            "### Issues",
            ...verdict.issues.map(
              (i) => `- **${i.severity}** (${i.file}): ${i.description}`
            ),
            "",
            `PR: ${prUrl}`,
          ].join("\n");

          const childId = await createChildIssue(
            issue.id,
            issue.teamKey,
            `Fix review feedback: ${issue.identifier}`,
            issueBody,
            [config.linear.agentLabel],
            issue.projectId
          );
          log("INFO", identifier, `Created fix ticket: ${childId}`);
          addPRComment(prUrl, `Review needs fixes. Created follow-up ticket: ${childId}\n\n${verdict.summary}`);
        } catch (err: any) {
          log("WARN", identifier, `Failed to create fix ticket: ${err.message}`);
        }
      }
    }

    pipelineSucceeded = true;

    return {
      issueId: identifier,
      success: true,
      prUrl,
      reviewVerdict: verdict,
      durationMs: Date.now() - startTime,
      attempts,
    };
  } finally {
    // 14. Clean up worktree (delete remote branch only on failure)
    try {
      removeWorktree(projectConfig.repoPath, identifier, !pipelineSucceeded, projectConfig.branchPrefix);
    } catch (err: any) {
      log("WARN", identifier, `Worktree cleanup failed: ${err.message}`);
    }

    // 15. Roll back to Todo if pipeline failed after transitioning to In Progress
    if (!pipelineSucceeded && transitionedToInProgress) {
      await rollbackInProgress(transitionedToInProgress, issue, config, identifier, lastError || "Pipeline failed");
    }
  }
}

async function runReview(
  issue: any,
  projectConfig: any,
  prUrl: string,
  worktreePath: string,
  config: any,
  identifier: string
): Promise<ReviewVerdict> {
  const reviewPrompt = buildReviewPrompt(issue, projectConfig, prUrl);

  const reviewResult = spawnAgent({
    prompt: reviewPrompt,
    cwd: worktreePath,
    model: config.defaults.reviewModel,
    maxTurns: config.defaults.reviewMaxTurns,
    maxBudgetUsd: config.defaults.reviewMaxBudgetUsd,
    agentType: "reviewer",
    timeoutMs: config.defaults.agentTimeoutMs,
    context: `${identifier}-review`,
  });

  // Parse review output as JSON
  return parseReviewVerdict(reviewResult.output, identifier);
}

function parseReviewVerdict(output: string, issueId: string): ReviewVerdict {
  // The output is claude JSON output format — extract the result text
  let text = output;

  // Try to parse as claude --output-format json first
  try {
    const claudeOutput = JSON.parse(output);
    if (claudeOutput.result) {
      text = claudeOutput.result;
    }
  } catch {
    // Not JSON wrapper, use raw
  }

  // Find JSON object in the text
  const jsonMatch = text.match(/\{[\s\S]*"approved"[\s\S]*\}/);
  if (!jsonMatch) {
    log("WARN", issueId, "Could not find JSON verdict in review output");
    return {
      approved: false,
      summary: "Review agent did not produce a structured verdict.",
      issues: [],
      testsPass: false,
      lintPass: false,
      tscPass: false,
    };
  }

  try {
    return JSON.parse(jsonMatch[0]) as ReviewVerdict;
  } catch (err: any) {
    log("WARN", issueId, `Failed to parse review verdict JSON: ${err.message}`);
    return {
      approved: false,
      summary: "Review verdict JSON was malformed.",
      issues: [],
      testsPass: false,
      lintPass: false,
      tscPass: false,
    };
  }
}

async function rollbackInProgress(
  transitioned: boolean,
  issue: any,
  config: any,
  identifier: string,
  error: string
): Promise<void> {
  if (!transitioned || !issue) return;
  try {
    await transitionIssue(issue.id, issue.teamKey, config.linear.todoState);
    await addComment(issue.id, `🤖 Agent failed, moving back to Todo.\n\nError: ${error.slice(0, 500)}`);
    log("INFO", identifier, `Rolled back to "${config.linear.todoState}"`);
  } catch (err: any) {
    log("WARN", identifier, `Failed to roll back issue state: ${err.message}`);
  }
}

function failure(
  issueId: string,
  error: string,
  startTime: number,
  attempts: number
): RunResult {
  log("ERROR", issueId, error);
  return {
    issueId,
    success: false,
    error,
    durationMs: Date.now() - startTime,
    attempts,
  };
}
