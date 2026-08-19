import type { ModelReasoningEffort } from "../types.ts";

const REASONING_EFFORTS: ModelReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function parseReasoningEffort(value: string): ModelReasoningEffort {
  if (REASONING_EFFORTS.includes(value as ModelReasoningEffort)) {
    return value as ModelReasoningEffort;
  }

  throw new Error(
    `Invalid reasoning effort: ${value}. Must be one of: ${REASONING_EFFORTS.join(", ")}`
  );
}

export function parsePriority(value: string): number {
  const priority = parseInt(value, 10);
  if (isNaN(priority) || priority < 0 || priority > 4) {
    throw new Error(`Invalid priority: ${value}. Must be 0-4.`);
  }
  return priority;
}
