// Shared types for the task-runner pipeline

// --- Configuration ---

export interface ProjectConfig {
  repoPath: string;
  defaultBranch: string;
  testCommand: string;
  lintCommand: string;
  buildCommand?: string;
}

export interface LinearConfig {
  agentLabel: string;
  inProgressState: string;
  inReviewState: string;
  todoState: string;
}

export interface DefaultsConfig {
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  reviewModel: string;
  reviewMaxTurns: number;
  reviewMaxBudgetUsd: number;
  contextModel: string;
  contextMaxTurns: number;
  contextMaxBudgetUsd: number;
  maxAttempts: number;
  agentTimeoutMs: number;
}

export interface GithubConfig {
  prLabels: string[];
  reviewApprovedLabel?: string;
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
  labels: string[];
  comments: string[];
  url: string;
  branchName: string;
}

// --- Review ---

export interface ReviewVerdict {
  approved: boolean;
  summary: string;
  issues: ReviewIssue[];
  testsPass: boolean;
  lintPass: boolean;
  tscPass: boolean;
}

export interface ReviewIssue {
  severity: "critical" | "major" | "minor" | "nit";
  file: string;
  description: string;
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
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxAttempts?: number;
  dryRun?: boolean;
}

export interface DrainOptions {
  label?: string;
  project?: string;
  limit?: number;
  dryRun?: boolean;
}

export interface RunResult {
  issueId: string;
  success: boolean;
  prUrl?: string;
  reviewVerdict?: ReviewVerdict;
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

// --- Logger ---

export type LogLevel = "INFO" | "WARN" | "ERROR" | "OK";
