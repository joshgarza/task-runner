// Load task-runner.config.json + .env file

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { TaskRunnerConfig } from "./types.ts";

const CONFIG_FILENAME = "task-runner.config.json";
const ENV_FILENAME = ".env";

// Load .env file into process.env (once, at import time)
function loadDotEnv(): void {
  const candidates = [
    resolve(import.meta.dirname, "..", ENV_FILENAME),
    resolve(process.cwd(), ENV_FILENAME),
  ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;

    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Don't override existing env vars
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
    return; // Only load the first .env found
  }
}

loadDotEnv();

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

  // Merge with defaults
  const config: TaskRunnerConfig = {
    projects: raw.projects ?? {},
    linear: {
      agentLabel: raw.linear?.agentLabel ?? "agent-ready",
      inProgressState: raw.linear?.inProgressState ?? "In Progress",
      inReviewState: raw.linear?.inReviewState ?? "In Review",
      todoState: raw.linear?.todoState ?? "Todo",
    },
    defaults: {
      model: raw.defaults?.model ?? "opus",
      maxTurns: raw.defaults?.maxTurns ?? 50,
      maxBudgetUsd: raw.defaults?.maxBudgetUsd ?? 10.0,
      reviewModel: raw.defaults?.reviewModel ?? "opus",
      reviewMaxTurns: raw.defaults?.reviewMaxTurns ?? 15,
      reviewMaxBudgetUsd: raw.defaults?.reviewMaxBudgetUsd ?? 2.0,
      maxAttempts: raw.defaults?.maxAttempts ?? 2,
      agentTimeoutMs: raw.defaults?.agentTimeoutMs ?? 900_000,
    },
    github: {
      prLabels: raw.github?.prLabels ?? ["agent-generated"],
      reviewApprovedLabel:
        raw.github?.reviewApprovedLabel ?? "ready-for-human-review",
    },
  };

  cachedConfig = config;
  return config;
}

export function getLinearApiKey(): string {
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    throw new Error("LINEAR_API_KEY environment variable is not set");
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
