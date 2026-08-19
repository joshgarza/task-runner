// Prompt template for ticket-refinement exploration agents

import type { LinearIssue } from "../types.ts";

export const REFINE_AGENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    executionRoute: { type: "string", enum: ["local", "cloud", "ops"] },
    descriptionAddendum: { type: "string" },
    dependencies: {
      type: "array",
      items: { type: "string" },
    },
    relevantFiles: {
      type: "array",
      items: { type: "string" },
      maxItems: 10,
    },
  },
  required: ["executionRoute", "descriptionAddendum", "dependencies", "relevantFiles"],
  additionalProperties: false,
} as const;

export function buildRefinePrompt(
  issue: LinearIssue,
  availableExecutionRoutes: string[],
  siblingIdentifiers: string[]
): string {
  const siblingSection =
    siblingIdentifiers.length > 0
      ? `\n## Sibling Tickets (same project)\n\n${siblingIdentifiers.map((id) => `- ${id}`).join("\n")}\n`
      : "";

  return `You are analyzing a codebase to refine a Linear ticket. Your goal is to add codebase context, recommend the right execution route, and identify dependency relationships.

## Ticket

**${issue.identifier}: ${issue.title}**

Description:
${issue.description ?? "No description provided."}
${siblingSection}
## Instructions

1. Explore the codebase to understand the overall structure and conventions.
2. Identify files and code patterns directly relevant to this ticket.
3. Determine which execution route is appropriate for this ticket.
4. Check if this ticket depends on any of the sibling tickets listed above (i.e. a sibling must be completed first for this ticket to proceed). Only list true blocking dependencies, not loosely related work.

## Execution Routes

${availableExecutionRoutes.map((route) => `- ${route}`).join("\n")}

## Output Format

You MUST output ONLY a JSON object with this exact schema (no other text before or after):

\`\`\`json
{
  "executionRoute": "local",
  "descriptionAddendum": "Brief codebase context: key files, patterns, and implementation notes relevant to this ticket.",
  "dependencies": ["JOS-100"],
  "relevantFiles": ["path/to/file1.ts", "path/to/file2.ts"]
}
\`\`\`

Rules:
- Use \`local\` for normal unattended work in the local worktree.
- Use \`cloud\` when Codex cloud is the better unattended environment.
- Use \`ops\` for work involving deployment, infrastructure mutation, production data, credentials, or other actions that require human approval.
- \`descriptionAddendum\` should be 2-4 sentences of codebase context that will help the implementing agent.
- \`dependencies\` must only contain identifiers from the sibling tickets list. Use an empty array if there are no dependencies.
- \`relevantFiles\` should list the most relevant files (max 10).`;
}
