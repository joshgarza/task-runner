// Shared types for the task-runner pipeline

import type { ExecutionRoute } from "./execution-route.ts";

// --- Configuration ---

export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ProjectConfig {
  repoPath: string;
  defaultBranch: string;
  testCommand: string;
  lintCommand: string;
  buildCommand?: string;
  team?: string;
  branchPrefix?: string;
}

export interface LinearConfig {
  agentLabel: string;
  needsApprovalLabel: string;
  inProgressState: string;
  inReviewState: string;
  todoState: string;
  doneState: string;
}

export interface DefaultsConfig {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  contextModel: string;
  contextReasoningEffort: ModelReasoningEffort;
  maxAttempts: number;
  agentTimeoutMs: number;
  drainConcurrency: number;
}

export interface GithubConfig {
  prLabels: string[];
}

export interface TaskRunnerConfig {
  projects: Record<string, ProjectConfig>;
  linear: LinearConfig;
  defaults: DefaultsConfig;
  github: GithubConfig;
}

// --- Linear ---

export interface LinearIssue {
  id: string;
  identifier: string; // e.g. "ENG-123"
  title: string;
  description: string | null;
  teamKey: string;
  teamName: string;
  stateName: string;
  stateId: string;
  projectName: string | null;
  projectId: string | null;
  labels: string[];
  comments: string[];
  url: string;
  branchName: string;
}

// --- Validation ---

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// --- Run ---

export interface RunOptions {
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  maxAttempts?: number;
  dryRun?: boolean;
}

export interface DrainOptions {
  label?: string;
  project?: string;
  limit?: number;
  concurrency?: number;
  dryRun?: boolean;
}

export interface RunResult {
  issueId: string;
  success: boolean;
  executionRoute?: ExecutionRoute;
  prUrl?: string;
  reviewRequested?: boolean;
  error?: string;
  durationMs: number;
  attempts: number;
}

// --- Agent ---

export interface AgentResult {
  success: boolean;
  output: string;
  stderr: string;
  durationMs: number;
  exitCode: number | null;
}

// --- Organize Tickets ---

export interface OrganizeTicketsOptions {
  team: string;
  project?: string;
  states?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  context?: boolean;
  dryRun?: boolean;
}

export interface OrganizeTicketResult {
  identifier: string;
  title: string;
  action: "labeled" | "blocked" | "skipped";
  labelsAdded: string[];
  labelsRemoved: string[];
  stateChange?: string;
  blockedBy?: string[];
  contextGathered?: boolean;
  reason: string;
}

// --- Context Gathering ---

export interface ContextResult {
  relevantFiles: string[];
  codeContext: string;
  acceptanceCriteria: string[];
}

// --- Refine Tickets ---

export interface RefineTicketsOptions {
  team: string;
  project?: string;
  dryRun?: boolean;
}

export interface RefineTicketResult {
  identifier: string;
  title: string;
  action: "refined" | "skipped" | "failed";
  executionRoute?: ExecutionRoute;
  dependenciesAdded?: string[];
  reason: string;
}

export interface RefineAgentOutput {
  executionRoute: ExecutionRoute;
  descriptionAddendum: string;
  dependencies: string[];
  relevantFiles: string[];
}

// --- Logger ---

export type LogLevel = "INFO" | "WARN" | "ERROR" | "OK";
