// Prompt template for context-gathering agents

import type { LinearIssue } from "../types.ts";

export function buildContextPrompt(issue: LinearIssue): string {
  return `You are analyzing a codebase to gather context for a Linear ticket. Your goal is to identify relevant code, architecture patterns, and suggest acceptance criteria based on actual code structure.

## Ticket

**${issue.identifier}: ${issue.title}**

Description:
${issue.description ?? "No description provided."}

## Instructions

1. Explore the codebase to understand the overall structure and conventions.
2. Identify files and code patterns directly relevant to this ticket.
3. Based on the code structure, suggest concrete acceptance criteria.

## Output Format

You MUST output ONLY a JSON object with this exact schema (no other text before or after):

\`\`\`json
{
  "relevantFiles": ["path/to/file1.ts", "path/to/file2.ts"],
  "codeContext": "Brief description of relevant architecture, patterns, and code that relate to this ticket.",
  "acceptanceCriteria": ["Criterion 1", "Criterion 2"]
}
\`\`\`

Keep codeContext concise (2-4 sentences). List only the most relevant files (max 10). Acceptance criteria should be specific and testable.`;
}
