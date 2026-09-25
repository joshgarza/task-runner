// Prompt template for implementation agents

import type { LinearIssue, ProjectConfig } from "../types.ts";

export const workerReportSchema = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string" },
  },
  required: ["outcome", "summary"],
  additionalProperties: false,
};

export function parseWorkerReport(output: string): { outcome: "completed" | "blocked"; summary: string } {
  const report = JSON.parse(output);
  if (!report || typeof report !== "object" || Array.isArray(report) ||
      !["completed", "blocked"].includes(report.outcome) ||
      typeof report.summary !== "string" || !report.summary.trim() ||
      Object.keys(report).some(key => !["outcome", "summary"].includes(key))) {
    throw new Error("Worker must return a structured completed or blocked report with a summary");
  }
  return report;
}

export function buildWorkerPrompt(
  issue: LinearIssue,
  teamConfig: ProjectConfig
): string {
  const issueComments = issue.allComments ?? issue.comments;
  const comments =
    issueComments.length > 0
      ? issueComments.map((c, i) => `Comment ${i + 1}:\n${c}`).join("\n\n")
      : "No comments.";

  return `You are implementing a Linear ticket. Follow the instructions precisely.

## Ticket

**${issue.identifier}: ${issue.title}**

Description:
${issue.description ?? "No description provided."}

Comments:
${comments}

Linear URL: ${issue.url}

## Instructions

1. Read the codebase to understand the project structure, conventions, and patterns.
2. Implement the changes described in the ticket above.
3. Follow existing code style and conventions exactly.
4. Write tests if the project has a test suite and the change is testable.
5. Run the test suite to verify your changes: \`${teamConfig.testCommand}\`
6. Run the linter to ensure code quality: \`${teamConfig.lintCommand}\`
${teamConfig.buildCommand ? `7. Run the build to verify compilation: \`${teamConfig.buildCommand}\`` : ""}
7. Commit your changes with a clear commit message referencing ${issue.identifier}.
   Format: \`${issue.identifier}: <description of changes>\`

## Rules

- Eligible sandbox-boundary requests use Codex's native automatic permission reviewer. For a sandbox-blocked Git commit or test command, request narrowly scoped escalation, leaving the sandbox and reviewer policy unchanged.
- Never work around a permission denial or probe secrets. If permission is denied or unavailable, stop and report the blocker; do not seek the same outcome through another command, process, or policy change.
- Do NOT run git push — the runner handles that.
- Do NOT modify CI/CD config, deployment files, or package manager lockfiles unless the ticket specifically asks for it.
- Do NOT add dependencies unless the ticket requires it.
- Keep changes minimal and focused on the ticket requirements.
- If the ticket is ambiguous, implement the most reasonable interpretation.
- If you cannot complete the task, leave recoverable work in place. Do not attempt a denied commit again.

## Final report

Return JSON matching the provided schema: outcome (completed or blocked) and summary.
Use completed only when the entire ticket is implemented, tested, and committed.
Use blocked whenever permission is denied or unavailable, required work cannot be
completed, or scope needs a human decision. Describe that blocker in summary.
A blocked report stops automated retries even when this Codex turn exits normally.`;
}
