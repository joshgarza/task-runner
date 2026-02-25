// Prompt template for implementation agents

import type { LinearIssue, ProjectConfig } from "../types.ts";

export function buildWorkerPrompt(
  issue: LinearIssue,
  teamConfig: ProjectConfig
): string {
  const comments =
    issue.comments.length > 0
      ? issue.comments.map((c, i) => `Comment ${i + 1}:\n${c}`).join("\n\n")
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

- Do NOT run git push — the runner handles that.
- Do NOT modify CI/CD config, deployment files, or package manager lockfiles unless the ticket specifically asks for it.
- Do NOT add dependencies unless the ticket requires it.
- Keep changes minimal and focused on the ticket requirements.
- If the ticket is ambiguous, implement the most reasonable interpretation.
- If you cannot complete the task, commit what you have and explain what's blocking in a comment at the top of your output.`;
}
