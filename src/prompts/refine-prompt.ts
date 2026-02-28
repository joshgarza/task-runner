// Prompt template for ticket-refinement exploration agents

import type { LinearIssue } from "../types.ts";

export function buildRefinePrompt(
  issue: LinearIssue,
  availableAgentTypes: string[],
  siblingIdentifiers: string[]
): string {
  const siblingSection =
    siblingIdentifiers.length > 0
      ? `\n## Sibling Tickets (same project)\n\n${siblingIdentifiers.map((id) => `- ${id}`).join("\n")}\n`
      : "";

  return `You are analyzing a codebase to refine a Linear ticket. Your goal is to add codebase context, recommend the right agent type, and identify dependency relationships.

## Ticket

**${issue.identifier}: ${issue.title}**

Description:
${issue.description ?? "No description provided."}
${siblingSection}
## Instructions

1. Explore the codebase to understand the overall structure and conventions.
2. Identify files and code patterns directly relevant to this ticket.
3. Determine which agent type is best suited to implement this ticket.
4. Check if this ticket depends on any of the sibling tickets listed above (i.e. a sibling must be completed first for this ticket to proceed). Only list true blocking dependencies, not loosely related work.

## Available Agent Types

${availableAgentTypes.map((t) => `- ${t}`).join("\n")}

## Output Format

You MUST output ONLY a JSON object with this exact schema (no other text before or after):

\`\`\`json
{
  "agentType": "worker",
  "descriptionAddendum": "Brief codebase context: key files, patterns, and implementation notes relevant to this ticket.",
  "dependencies": ["JOS-100"],
  "relevantFiles": ["path/to/file1.ts", "path/to/file2.ts"]
}
\`\`\`

Rules:
- \`agentType\` must be one of the available agent types listed above.
- \`descriptionAddendum\` should be 2-4 sentences of codebase context that will help the implementing agent.
- \`dependencies\` must only contain identifiers from the sibling tickets list. Use an empty array if there are no dependencies.
- \`relevantFiles\` should list the most relevant files (max 10).`;
}
