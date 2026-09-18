// Load project configuration. Credentials must already be in the environment.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelReasoningEffort, TaskRunnerConfig } from "./types.ts";

const CONFIG_FILENAME = "task-runner.config.json";
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  opus: "gpt-5.4",
};
const VALID_REASONING_EFFORTS = new Set<ModelReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function resolveModel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  if (!trimmed) return fallback;

  return LEGACY_MODEL_ALIASES[trimmed] ?? trimmed;
}

function resolveReasoningEffort(
  value: unknown,
  fallback: ModelReasoningEffort
): ModelReasoningEffort {
  return typeof value === "string" && VALID_REASONING_EFFORTS.has(value as ModelReasoningEffort)
    ? value as ModelReasoningEffort
    : fallback;
}

let cachedConfig: TaskRunnerConfig | null = null;

function findConfigPath(): string {
  // Check current directory, then home directory
  const candidates = [
    resolve(process.cwd(), CONFIG_FILENAME),
    resolve(import.meta.dirname, "..", CONFIG_FILENAME),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Config file not found. Create ${CONFIG_FILENAME} in project root or run directory.`
  );
}

export function loadConfig(): TaskRunnerConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = findConfigPath();
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  const defaultModel = resolveModel(raw.defaults?.model, "gpt-5.4");
  const defaultReasoningEffort = resolveReasoningEffort(raw.defaults?.reasoningEffort, "high");

  // Merge with defaults
  const config: TaskRunnerConfig = {
    projects: raw.projects ?? {},
    linear: {
      agentLabel: raw.linear?.agentLabel ?? "agent-ready",
      agentFailedLabel: raw.linear?.agentFailedLabel ?? "agent-failed",
      trustedCommentAuthorIds: raw.linear?.trustedCommentAuthorIds ?? [],
      needsApprovalLabel: raw.linear?.needsApprovalLabel ?? "needs-human-approval",
      inProgressState: raw.linear?.inProgressState ?? "In Progress",
      inReviewState: raw.linear?.inReviewState ?? "In Review",
      todoState: raw.linear?.todoState ?? "Todo",
      doneState: raw.linear?.doneState ?? "Done",
    },
    defaults: {
      model: defaultModel,
      reasoningEffort: defaultReasoningEffort,
      contextModel: resolveModel(raw.defaults?.contextModel, defaultModel),
      contextReasoningEffort: resolveReasoningEffort(
        raw.defaults?.contextReasoningEffort,
        "medium"
      ),
      maxAttempts: raw.defaults?.maxAttempts ?? 2,
      maxDrainFailures: raw.defaults?.maxDrainFailures ?? 2,
      agentTimeoutMs: raw.defaults?.agentTimeoutMs ?? 900_000,
      drainConcurrency: raw.defaults?.drainConcurrency ?? 1,
    },
    github: {
      prLabels: raw.github?.prLabels ?? ["agent-generated"],
    },
  };

  cachedConfig = config;
  return config;
}

export function getLinearApiKey(): string {
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    throw new Error(
      "LINEAR_API_KEY environment variable is not set. Ask the operator to verify " +
      "it is exported to this process. TaskRunner does not load secret files."
    );
  }
  return key;
}

export function getProjectConfig(projectName: string): TaskRunnerConfig["projects"][string] {
  const config = loadConfig();
  const project = config.projects[projectName];
  if (!project) {
    throw new Error(
      `No project config for "${projectName}". Available projects: ${Object.keys(config.projects).join(", ")}`
    );
  }
  return project;
}

/**
 * Auto-detect project (and optionally team) from the current working directory.
 * Matches cwd against configured repoPath values. Also matches worktree
 * subdirectories since .task-runner-worktrees/ lives under repoPath.
 *
 * Returns null if cwd doesn't match any configured project.
 */
export function detectProjectFromCwd(): { project: string; team?: string } | null {
  const config = loadConfig();
  const cwd = resolve(process.cwd());

  let bestMatch: { project: string; team?: string; pathLen: number } | null = null;

  for (const [name, projectConfig] of Object.entries(config.projects)) {
    const repoPath = resolve(projectConfig.repoPath);

    // Check if cwd is the repoPath or a subdirectory of it
    if (cwd === repoPath || cwd.startsWith(repoPath + "/")) {
      if (!bestMatch || repoPath.length > bestMatch.pathLen) {
        bestMatch = { project: name, team: projectConfig.team, pathLen: repoPath.length };
      }
    }
  }

  if (!bestMatch) return null;
  return { project: bestMatch.project, team: bestMatch.team };
}
