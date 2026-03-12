// Standalone PR review (no full pipeline)

import { loadConfig } from "../config.ts";
import { log } from "../logger.ts";
import { spawnAgent } from "../agents/spawn.ts";
import { REVIEW_VERDICT_SCHEMA } from "../agents/review-prompt.ts";
import type { ReviewVerdict, ProjectConfig } from "../types.ts";

/**
 * Review an existing PR standalone.
 * Clones/checks out the PR locally and runs the review agent.
 */
export async function reviewPR(prUrl: string): Promise<ReviewVerdict> {
  const config = loadConfig();

  log("INFO", "review", `Reviewing PR: ${prUrl}`);

  // Extract repo info from PR URL
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid PR URL: ${prUrl}`);
  }
  const [, owner, repo, prNumber] = match;

  // Find project config by matching repo path
  let projectConfig: ProjectConfig | undefined;
  for (const [, pc] of Object.entries(config.projects)) {
    if (pc.repoPath.includes(repo)) {
      projectConfig = pc;
      break;
    }
  }

  if (!projectConfig) {
    throw new Error(
      `No project config found for repo "${repo}". Configure it in task-runner.config.json.`
    );
  }

  // Build review prompt
  const prompt = `You are reviewing a pull request. Be thorough but fair.

## PR Details

PR URL: ${prUrl}
Repository: ${owner}/${repo}
PR Number: ${prNumber}

## Review Process

1. Run \`gh pr diff ${prUrl}\` to see the diff.
2. Run \`gh pr view ${prUrl}\` for PR details.
3. Read any modified files for full context.
4. Run tests: \`${projectConfig.testCommand}\`
5. Run linter: \`${projectConfig.lintCommand}\`
${projectConfig.buildCommand ? `6. Run build: \`${projectConfig.buildCommand}\`` : ""}

## Output Format

Output ONLY a JSON object:

{
  "approved": true | false,
  "summary": "One-paragraph summary.",
  "issues": [
    { "severity": "critical|major|minor|nit", "file": "path", "description": "..." }
  ],
  "testsPass": true | false,
  "lintPass": true | false,
  "tscPass": true | false
}

Approve if: tests pass, lint passes, no critical issues, at most 2 major issues.`;

  const result = await spawnAgent({
    prompt,
    cwd: projectConfig.repoPath,
    model: config.defaults.reviewModel,
    reasoningEffort: config.defaults.reviewReasoningEffort,
    maxTurns: config.defaults.reviewMaxTurns,
    maxBudgetUsd: config.defaults.reviewMaxBudgetUsd,
    agentType: "reviewer",
    timeoutMs: config.defaults.agentTimeoutMs,
    context: `review-${prNumber}`,
    outputSchema: REVIEW_VERDICT_SCHEMA,
  });

  try {
    const verdict = JSON.parse(result.output) as ReviewVerdict;
    log("INFO", "review", `Verdict: ${verdict.approved ? "APPROVED" : "NEEDS FIXES"}`);
    console.log(JSON.stringify(verdict, null, 2));
    return verdict;
  } catch (err: any) {
    log("WARN", "review", `Failed to parse review verdict: ${err.message}`);
    return {
      approved: false,
      summary: "Failed to parse review verdict.",
      issues: [],
      testsPass: false,
      lintPass: false,
      tscPass: false,
    };
  }
}
