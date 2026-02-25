// Pattern-match agent output/stderr for permission errors and other failure categories

import type { FailureAnalysis } from "../types.ts";

interface PatternRule {
  pattern: RegExp;
  category: FailureAnalysis["category"];
  extractCapability: (match: RegExpMatchArray) => string | null;
}

const PATTERNS: PatternRule[] = [
  // Claude Code permission denial patterns
  {
    pattern: /tool "([^"]+)" is not allowed/gi,
    category: "permission_denied",
    extractCapability: (m) => m[1],
  },
  {
    pattern: /not in the list of allowed tools/gi,
    category: "permission_denied",
    extractCapability: () => null,
  },
  {
    pattern: /Bash\(([^)]+)\)\s*(?:is\s+)?not allowed/gi,
    category: "permission_denied",
    extractCapability: (m) => `Bash(${m[1]})`,
  },
  {
    pattern: /tool\s+"Bash"\s+is not allowed/gi,
    category: "permission_denied",
    extractCapability: () => "Bash",
  },
  {
    pattern: /permission[_\s]denied|access[_\s]denied|not\s+permitted/gi,
    category: "permission_denied",
    extractCapability: () => null,
  },
  // Budget / timeout patterns
  {
    pattern: /max budget exceeded|budget[_\s]exhausted|spending limit/gi,
    category: "budget_exhausted",
    extractCapability: () => null,
  },
  {
    pattern: /timed out|SIGTERM|ETIMEDOUT|timeout/gi,
    category: "timeout",
    extractCapability: () => null,
  },
];

/**
 * Analyze agent failure output to categorize the error and extract
 * missing capabilities for permission-denied cases.
 */
export function analyzeFailure(
  stdout: string,
  stderr: string
): FailureAnalysis {
  const combined = `${stdout}\n${stderr}`;
  const missingCapabilities: string[] = [];
  const seen = new Set<string>();

  // Check patterns in priority order
  for (const rule of PATTERNS) {
    // Reset regex lastIndex for global patterns
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = rule.pattern.exec(combined)) !== null) {
      if (rule.category === "permission_denied") {
        const capability = rule.extractCapability(match);
        if (capability && !seen.has(capability)) {
          seen.add(capability);
          missingCapabilities.push(capability);
        }
        // Continue searching for more permission denials
      } else {
        // For non-permission categories, return immediately
        return {
          category: rule.category,
          missingCapabilities: [],
          suggestedTools: [],
          confidence: 0.8,
        };
      }
    }
  }

  // If we found permission denials, return that category
  if (missingCapabilities.length > 0) {
    return {
      category: "permission_denied",
      missingCapabilities,
      suggestedTools: missingCapabilities.map(normalizeTool),
      confidence: 0.9,
    };
  }

  // If we matched generic permission patterns but couldn't extract specifics
  if (/permission|not allowed|denied/i.test(combined)) {
    return {
      category: "permission_denied",
      missingCapabilities: [],
      suggestedTools: [],
      confidence: 0.5,
    };
  }

  // Default: implementation error
  return {
    category: "implementation_error",
    missingCapabilities: [],
    suggestedTools: [],
    confidence: 0.3,
  };
}

/**
 * Normalize a capability name to a tool specification.
 * e.g., "npm test" → "Bash(npm test:*)"
 */
function normalizeTool(capability: string): string {
  // Already in Bash(...) format
  if (capability.startsWith("Bash(")) return capability;
  // Already a known tool name
  if (["Read", "Write", "Edit", "Grep", "Glob"].includes(capability)) return capability;
  // Assume it's a bash command
  return `Bash(${capability}:*)`;
}
