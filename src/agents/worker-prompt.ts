// Prompt template for implementation agents

import type { LinearIssue, ProjectConfig } from "../types.ts";

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
- If you cannot complete the task, leave recoverable work in place and explain the blocker at the top of your output. Do not attempt a denied commit again.`;
}
