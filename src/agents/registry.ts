// Agent registry: load, validate, and resolve agent type definitions

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../logger.ts";
import type { AgentTypeDefinition, ResolvedAgentType } from "../types.ts";

const REGISTRY_PATH = resolve(import.meta.dirname, "agent-registry.json");

// Patterns that are never allowed — blanket bash, network, destructive
const FORBIDDEN_PATTERNS = [
  "Bash(*)",
  "Bash(sudo:*)",
  "Bash(git push:*)",
  "Bash(rm -rf:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
];

export type AgentRegistry = Record<string, AgentTypeDefinition>;

/**
 * Load the agent registry from disk.
 * Validates safety constraints on every load.
 */
export function loadRegistry(): AgentRegistry {
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  validateRegistry(raw);
  return raw;
}

/**
 * Validate that no agent type uses forbidden tool patterns.
 * Throws on violation — fail-closed.
 */
function validateRegistry(registry: AgentRegistry): void {
  for (const [name, def] of Object.entries(registry)) {
    for (const tool of def.tools) {
      if (FORBIDDEN_PATTERNS.includes(tool)) {
        throw new Error(
          `Agent type "${name}" has forbidden tool: ${tool}. ` +
          `Forbidden patterns: ${FORBIDDEN_PATTERNS.join(", ")}`
        );
      }
    }

    // Validate extends references an existing type
    if (def.extends && !(def.extends in registry)) {
      throw new Error(
        `Agent type "${name}" extends "${def.extends}" which does not exist in the registry.`
      );
    }

    // Prevent circular/multi-level inheritance
    if (def.extends) {
      const parent = registry[def.extends];
      if (parent.extends) {
        throw new Error(
          `Agent type "${name}" extends "${def.extends}" which itself extends "${parent.extends}". ` +
          `Only single-level inheritance is allowed.`
        );
      }
    }
  }
}

/**
 * Resolve an agent type by name: merge parent tools if `extends` is set,
 * deduplicate, and return the final tool list + caps.
 */
export function resolveAgentType(
  name: string,
  registry: AgentRegistry
): ResolvedAgentType {
  const def = registry[name];
  if (!def) {
    throw new Error(
      `Agent type "${name}" not found in registry. Available: ${Object.keys(registry).join(", ")}`
    );
  }

  let tools: string[];
  if (def.extends) {
    const parent = registry[def.extends];
    // Parent tools first, then child-specific tools, deduplicated
    tools = [...new Set([...parent.tools, ...def.tools])];
  } else {
    tools = [...def.tools];
  }

  return {
    name,
    description: def.description,
    tools,
    maxBudgetUsd: def.maxBudgetUsd,
    maxTurns: def.maxTurns,
    audit: def.audit,
  };
}

/**
 * List all agent types in the registry with their resolved tool counts.
 */
export function listAgentTypes(registry: AgentRegistry): ResolvedAgentType[] {
  return Object.keys(registry).map((name) => resolveAgentType(name, registry));
}

/**
 * Add a new agent type to the registry and persist to disk.
 * Validates the new type before writing.
 */
export function addAgentType(
  name: string,
  definition: AgentTypeDefinition
): void {
  const registry = loadRegistry();

  if (name in registry) {
    throw new Error(`Agent type "${name}" already exists in the registry.`);
  }

  // Validate the new type in context of the full registry
  const updated = { ...registry, [name]: definition };
  validateRegistry(updated);

  writeFileSync(REGISTRY_PATH, JSON.stringify(updated, null, 2) + "\n");
  log("INFO", "registry", `Added agent type "${name}" to registry`);
}
