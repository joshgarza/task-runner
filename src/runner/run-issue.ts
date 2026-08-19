// Full pipeline: fetch, route, implement, validate, create PR, request review.

import { loadConfig, getProjectConfig } from "../config.ts";
import { log, logToFile } from "../logger.ts";
import { fetchIssue, fetchBlockingRelations } from "../linear/queries.ts";
import { transitionIssue, addComment, updateIssue } from "../linear/mutations.ts";
import { createWorktree, removeWorktree } from "../git/worktree.ts";
import { getBranchName } from "../git/worktree.ts";
import { hasCommits, pushBranch, createPR } from "../git/branch.ts";
import { getGitHubRepository } from "../git/remote.ts";
import * as comments from "../linear/comments.ts";
import { runLocalCodex } from "../agents/spawn.ts";
import { buildWorkerPrompt } from "../agents/worker-prompt.ts";
import { requestCodexReview } from "./review.ts";
import {
  getDrainFailurePolicy,
  getDrainFailureStatus,
  quarantineDrainFailure,
} from "./drain-failures.ts";
import { validateAgentOutput } from "../validation/validate.ts";
import {
  buildCloudDelegationComment,
  isHumanGatedRoute,
  resolveExecutionRoute,
} from "../execution-route.ts";
import type { ExecutionRoute } from "../execution-route.ts";
import type {
  LinearIssue,
  ProjectConfig,
  RunOptions,
  RunResult,
  TaskRunnerConfig,
} from "../types.ts";

export async function runIssue(
  identifier: string,
  options: RunOptions = {}
): Promise<RunResult> {
  const startTime = Date.now();
  const config = loadConfig();

  const model = options.model ?? config.defaults.model;
  const reasoningEffort = options.reasoningEffort ?? config.defaults.reasoningEffort;
  const maxAttempts = options.maxAttempts ?? config.defaults.maxAttempts;

  let transitionedToInProgress = false;

  log("INFO", identifier, `Starting pipeline (model: ${model}, reasoning: ${reasoningEffort}, attempts: ${maxAttempts})`);

  // 1. Fetch issue from Linear
  let issue;
  try {
    issue = await fetchIssue(identifier);
    log("INFO", identifier, `Fetched: "${issue.title}" (state: ${issue.stateName}, project: ${issue.projectName ?? "none"})`);
  } catch (err: any) {
    return failure(identifier, `Failed to fetch issue: ${err.message}`, startTime, 0);
  }

  let executionRoute: ExecutionRoute;
  try {
    const resolution = resolveExecutionRoute(issue.labels);
    executionRoute = resolution.route;
    log("INFO", identifier, `Execution route: ${executionRoute} (${resolution.reason})`);
  } catch (err: any) {
    return failure(identifier, `Invalid execution routing: ${err.message}`, startTime, 0);
  }

  const drainFailurePolicy = getDrainFailurePolicy(config);
  const drainFailureStatus = getDrainFailureStatus(issue, drainFailurePolicy);

  if (options.dryRun) {
    if (drainFailureStatus.hasAgentFailedLabel && drainFailureStatus.applies) {
      log("INFO", identifier, `[dry-run] Would stop because the issue has the "${config.linear.agentFailedLabel}" label`);
    } else if (drainFailureStatus.shouldQuarantine) {
      log("INFO", identifier, `[dry-run] Would remove from the agent queue after ${drainFailureStatus.failureCount} failed run(s)`);
    }
    log("INFO", identifier, `Dry run — stopping after fetch and route resolution (${executionRoute})`);
    return {
      issueId: identifier,
      success: true,
      executionRoute,
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

  // 2.3. Reject tickets requiring human approval or human-gated ops.
  if (issue.labels.includes(config.linear.needsApprovalLabel) || isHumanGatedRoute(executionRoute)) {
    const reason = isHumanGatedRoute(executionRoute)
      ? `Execution route "${executionRoute}" is human-gated and cannot run unattended`
      : `Issue has "${config.linear.needsApprovalLabel}" label — requires human approval before Codex can proceed`;
    return failure(
      identifier,
      reason,
      startTime,
      0
    );
  }

  // Permanently failed local queue items require human triage before another
  // unattended run. Direct runs retain this guard in case drain state changed
  // between its initial fetch and execution.
  if (drainFailureStatus.hasAgentFailedLabel && drainFailureStatus.isLocal) {
    return failure(
      identifier,
      `Issue has "${config.linear.agentFailedLabel}" label. Remove it and re-add "${config.linear.agentLabel}" after human triage.`,
      startTime,
      0
    );
  }

  if (drainFailureStatus.shouldQuarantine) {
    try {
      await quarantineDrainFailure(issue, drainFailurePolicy);
    } catch (err: any) {
      return failure(
        identifier,
        `Failed to remove permanently failing issue from the agent queue: ${err.message}`,
        startTime,
        0
      );
    }

    return failure(
      identifier,
      `Agent failed ${drainFailureStatus.failureCount} times. Removed from the agent queue for human triage.`,
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
    return failure(
      identifier,
      `Failed to verify blocking relations: ${err.message}`,
      startTime,
      0
    );
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

  if (executionRoute === "cloud") {
    return delegateCloudIssue(issue, projectConfig, config, startTime);
  }

  // 4. Transition local work to In Progress
  try {
    await transitionIssue(issue.id, issue.teamKey, config.linear.inProgressState);
    await addComment(issue.id, comments.startWork({
      identifier: issue.identifier,
      title: issue.title,
      executionRoute,
      model,
      reasoningEffort,
      maxAttempts,
    }));
    transitionedToInProgress = true;
    log("INFO", identifier, `Transitioned to "${config.linear.inProgressState}"`);
  } catch (err: any) {
    log("WARN", identifier, `Failed to transition issue: ${err.message}`);
  }

  // 6. Create worktree
  let worktreePath: string;
  try {
    worktreePath = createWorktree(projectConfig.repoPath, identifier, projectConfig.defaultBranch, projectConfig.branchPrefix);
  } catch (err: any) {
    await rollbackInProgress(transitionedToInProgress, issue, config, identifier, `Failed to create worktree: ${err.message}`, 0);
    return failure(identifier, `Failed to create worktree: ${err.message}`, startTime, 0);
  }

  const branch = getBranchName(identifier, projectConfig.branchPrefix);
  let attempts = 0;
  let lastError = "";
  let pipelineSucceeded = false;

  try {
    // 7. Spawn worker agent (with retry loop)
    for (attempts = 1; attempts <= maxAttempts; attempts++) {
      log("INFO", identifier, `Attempt ${attempts}/${maxAttempts}`);

      let prompt = buildWorkerPrompt(issue, projectConfig);

      // Prepend retry context if not first attempt
      if (attempts > 1 && lastError) {
        prompt = `IMPORTANT: A previous attempt failed with the following errors. Fix these issues:\n\n${lastError}\n\n---\n\n${prompt}`;
      }

      const agentResult = await runLocalCodex({
        prompt,
        cwd: worktreePath,
        model,
        reasoningEffort,
        profile: "write",
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
            executionRoute,
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
            comments.agentFailed({ attempts, maxAttempts, errors: lastError })
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

    // 11. Link PR to Linear (retry + fallback to ensure PR URL is always persisted)
    await postPRLink(issue.id, issue.teamKey, prUrl, issue.description, identifier);

    // 12. Request native GitHub Codex review. GitHub owns review feedback;
    // TaskRunner only records the request and reconciles final PR state.
    const reviewRequest = await requestCodexReview(prUrl, identifier);
    const inReviewTransition = reviewRequest.requested
      ? await transitionToInReview(
          issue.id,
          issue.teamKey,
          config.linear.inReviewState,
          identifier
        )
      : null;
    try {
      await addComment(issue.id, comments.nativeReviewRequested({
        prUrl,
        requested: reviewRequest.requested,
        error: reviewRequest.error,
      }));
    } catch (err: any) {
      log("WARN", identifier, `Failed to record native review request in Linear: ${err.message}`);
    }

    // The implementation and remote PR succeeded, so preserve the branch even
    // if Linear state reconciliation exhausted its retries.
    pipelineSucceeded = true;

    if (!reviewRequest.requested) {
      const error = `PR created, but failed to request native Codex review after ${reviewRequest.attempts} attempts: ${reviewRequest.error}`;
      log("ERROR", identifier, error);
      return {
        issueId: identifier,
        success: false,
        executionRoute,
        prUrl,
        reviewRequested: false,
        error,
        durationMs: Date.now() - startTime,
        attempts,
      };
    }

    if (!inReviewTransition.transitioned) {
      const error = `PR created, but failed to transition issue to ${config.linear.inReviewState} after ${inReviewTransition.attempts} attempts: ${inReviewTransition.error}`;
      log("ERROR", identifier, error);
      return {
        issueId: identifier,
        success: false,
        executionRoute,
        prUrl,
        reviewRequested: reviewRequest.requested,
        error,
        durationMs: Date.now() - startTime,
        attempts,
      };
    }

    return {
      issueId: identifier,
      success: true,
      executionRoute,
      prUrl,
      reviewRequested: reviewRequest.requested,
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
      await rollbackInProgress(transitionedToInProgress, issue, config, identifier, lastError || "Pipeline failed", attempts);
    }
  }
}

async function delegateCloudIssue(
  issue: LinearIssue,
  projectConfig: ProjectConfig,
  config: TaskRunnerConfig,
  startTime: number
): Promise<RunResult> {
  try {
    await transitionIssue(issue.id, issue.teamKey, config.linear.inProgressState);
  } catch (err: any) {
    return failure(
      issue.identifier,
      `Failed to transition cloud work to ${config.linear.inProgressState}: ${err.message}`,
      startTime,
      0
    );
  }

  const repository = getGitHubRepository(projectConfig.repoPath);
  const delegationComment = buildCloudDelegationComment(repository);

  try {
    await addComment(issue.id, delegationComment);
  } catch (err: any) {
    await rollbackInProgress(
      true,
      issue,
      config,
      issue.identifier,
      `Failed to delegate cloud work: ${err.message}`,
      0
    );
    return failure(
      issue.identifier,
      `Failed to delegate cloud work: ${err.message}`,
      startTime,
      0
    );
  }

  log("OK", issue.identifier, `Delegated to Codex cloud${repository ? ` for ${repository}` : ""}`);
  return {
    issueId: issue.identifier,
    success: true,
    executionRoute: "cloud",
    durationMs: Date.now() - startTime,
    attempts: 0,
  };
}

async function rollbackInProgress(
  transitioned: boolean,
  issue: any,
  config: any,
  identifier: string,
  error: string,
  attempts: number
): Promise<void> {
  if (!transitioned || !issue) return;
  try {
    // Record the countable failure before making the issue drain-eligible
    // again. If the comment cannot be written, leave the issue In Progress so
    // a later drain cannot retry it without a recorded failure.
    await addComment(issue.id, comments.rollback({ error, attempts }));
    await transitionIssue(issue.id, issue.teamKey, config.linear.todoState);
    log("INFO", identifier, `Rolled back to "${config.linear.todoState}"`);
  } catch (err: any) {
    log("WARN", identifier, `Failed to roll back issue state: ${err.message}`);
  }
}

/**
 * Post the PR URL to a Linear issue via comment, with retry and fallback.
 * Tries addComment twice (with a 1s delay between attempts). If both fail,
 * falls back to appending the PR URL to the issue description via updateIssue.
 * Never throws — the pipeline must not fail because of a comment failure.
 */
export async function postPRLink(
  issueId: string,
  teamKey: string,
  prUrl: string,
  existingDescription: string | null,
  context: string,
  deps: PostPRLinkDependencies = defaultPostPRLinkDependencies
): Promise<void> {
  const maxRetries = 2;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await deps.addComment(issueId, `🤖 PR created: ${prUrl}`);
      return; // success
    } catch (err: any) {
      deps.log("WARN", context, `addComment attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await deps.delay(1000);
      }
    }
  }

  // Fallback: append PR URL to issue description
  try {
    const desc = existingDescription ?? "";
    await deps.updateIssue(issueId, teamKey, {
      description: desc + `\n\nPR: ${prUrl}`,
    });
    deps.log("INFO", context, "Persisted PR URL via issue description fallback");
  } catch (err: any) {
    deps.log("WARN", context, `Failed to persist PR URL via description fallback: ${err.message}`);
  }
}

export interface PostPRLinkDependencies {
  addComment: typeof addComment;
  updateIssue: typeof updateIssue;
  log: typeof log;
  delay: (ms: number) => Promise<void>;
}

const defaultPostPRLinkDependencies: PostPRLinkDependencies = {
  addComment,
  updateIssue,
  log,
  delay: (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
};

export interface InReviewTransitionResult {
  transitioned: boolean;
  attempts: number;
  error?: string;
}

export interface InReviewTransitionDependencies {
  transitionIssue: typeof transitionIssue;
  delay: (ms: number) => Promise<void>;
  log: typeof log;
}

const defaultInReviewTransitionDependencies: InReviewTransitionDependencies = {
  transitionIssue,
  delay: (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
  log,
};

export async function transitionToInReview(
  issueId: string,
  teamKey: string,
  stateName: string,
  context: string,
  deps: InReviewTransitionDependencies = defaultInReviewTransitionDependencies
): Promise<InReviewTransitionResult> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await deps.transitionIssue(issueId, teamKey, stateName);
      return { transitioned: true, attempts: attempt };
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(
        "WARN",
        context,
        `Transition to ${stateName} attempt ${attempt}/${maxAttempts} failed: ${message}`
      );
      if (attempt < maxAttempts) {
        await deps.delay(1000);
      } else {
        return { transitioned: false, attempts: attempt, error: message };
      }
    }
  }

  return { transitioned: false, attempts: maxAttempts, error: "Transition failed" };
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
