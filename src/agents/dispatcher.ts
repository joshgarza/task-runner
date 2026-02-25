// Label-based agent type dispatcher — pure mechanical lookup, no LLM

import { log } from "../logger.ts";
import type { AgentRegistry } from "./registry.ts";
import type { LinearIssue, DispatchResult } from "../types.ts";

const AGENT_LABEL_PREFIX = "agent:";
const DEFAULT_FALLBACK = "worker"; // backward compat: unlabeled tickets get full worker access

/**
 * Select an agent type for an issue based on its "agent:<type>" label.
 *
 * 1. Look for an "agent:<type>" label on the issue
 * 2. If found AND type exists in registry → return that type
 * 3. If found but type NOT in registry → log warning, fall back
 * 4. If no "agent:*" label → fall back to default
 */
export function dispatch(
  issue: LinearIssue,
  registry: AgentRegistry
): DispatchResult {
  const agentLabel = issue.labels.find((l) => l.startsWith(AGENT_LABEL_PREFIX));

  if (!agentLabel) {
    return {
      agentType: DEFAULT_FALLBACK,
      reason: `No agent:* label found, falling back to "${DEFAULT_FALLBACK}"`,
    };
  }

  const requestedType = agentLabel.slice(AGENT_LABEL_PREFIX.length);

  if (requestedType in registry) {
    return {
      agentType: requestedType,
      reason: `Matched label "${agentLabel}"`,
    };
  }

  log(
    "WARN",
    issue.identifier,
    `Label "${agentLabel}" references unknown agent type "${requestedType}". Falling back to "${DEFAULT_FALLBACK}".`
  );

  return {
    agentType: DEFAULT_FALLBACK,
    reason: `Unknown agent type "${requestedType}" from label "${agentLabel}", falling back to "${DEFAULT_FALLBACK}"`,
  };
}
