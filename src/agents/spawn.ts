// Codex SDK wrapper for agent turns

import os from "node:os";
import { log } from "../logger.ts";
import { loadRegistry, resolveAgentType } from "./registry.ts";
import type { AgentResult, ModelReasoningEffort } from "../types.ts";

type ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

interface CodexThreadOptions {
  model?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: ModelReasoningEffort;
  networkAccessEnabled?: boolean;
  approvalPolicy?: ApprovalMode;
}

interface CodexTurnResult {
  finalResponse: string;
}

interface CodexThreadLike {
  run(input: string, turnOptions?: {
    outputSchema?: unknown;
    signal?: AbortSignal;
  }): Promise<CodexTurnResult>;
}

interface CodexClientLike {
  startThread(options?: CodexThreadOptions): CodexThreadLike;
}

interface CodexModule {
  Codex: new (options?: {
    env?: Record<string, string>;
  }) => CodexClientLike;
}

let codexClientPromise: Promise<CodexClientLike> | null = null;

async function getCodexClient(): Promise<CodexClientLike> {
  if (!codexClientPromise) {
    codexClientPromise = (async () => {
      const module = await import("@openai/codex-sdk");
      const { Codex } = module as CodexModule;
      return new Codex({
        env: {
          HOME: process.env.HOME ?? os.homedir(),
          PATH: process.env.PATH ?? "",
          TERM: process.env.TERM ?? "xterm-256color",
        },
      });
    })();
  }

  return codexClientPromise;
}

export interface SpawnOptions {
  prompt: string;
  cwd: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  maxTurns: number;
  maxBudgetUsd: number;
  toolsFile?: string; // legacy compatibility only
  agentType?: string;
  timeoutMs: number;
  context: string;
  outputSchema?: unknown;
}

function resolveSandboxMode(agentType?: string): SandboxMode {
  if (agentType === "reviewer" || agentType === "context") {
    return "read-only";
  }

  return "workspace-write";
}

/**
 * Codex does not support the previous allowedTools model. Keep the registry
 * lookup for agent existence and compatibility caps while enforcing isolation
 * through sandbox mode.
 */
function resolveSpawnProfile(opts: SpawnOptions): {
  maxTurns: number;
  maxBudgetUsd: number;
  sandboxMode: SandboxMode;
} {
  if (opts.agentType) {
    const registry = loadRegistry();
    const resolved = resolveAgentType(opts.agentType, registry);
    return {
      maxTurns: Math.min(opts.maxTurns, resolved.maxTurns),
      maxBudgetUsd: Math.min(opts.maxBudgetUsd, resolved.maxBudgetUsd),
      sandboxMode: resolveSandboxMode(resolved.name),
    };
  }

  if (opts.toolsFile) {
    return {
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      sandboxMode: "workspace-write",
    };
  }

  throw new Error("SpawnOptions requires either agentType or toolsFile");
}

/**
 * Run an agent turn through the Codex SDK.
 */
export async function spawnAgent(opts: SpawnOptions): Promise<AgentResult> {
  const { maxTurns, maxBudgetUsd, sandboxMode } = resolveSpawnProfile(opts);
  const agentLabel = opts.agentType ? `[${opts.agentType}]` : `[${opts.toolsFile}]`;

  log(
    "INFO",
    opts.context,
    `Spawning codex model=${opts.model} reasoning=${opts.reasoningEffort} sandbox=${sandboxMode} ${agentLabel} ` +
    `(turn-cap=${maxTurns}, budget-cap=$${maxBudgetUsd}; compatibility only)`
  );

  const startTime = Date.now();
  let output = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);

  try {
    const client = await getCodexClient();
    const thread = client.startThread({
      model: opts.model,
      modelReasoningEffort: opts.reasoningEffort,
      sandboxMode,
      workingDirectory: opts.cwd,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      networkAccessEnabled: false,
    });

    const turn = await thread.run(opts.prompt, {
      outputSchema: opts.outputSchema,
      signal: controller.signal,
    });

    output = turn.finalResponse.trim();
    exitCode = 0;
  } catch (err: any) {
    const message = timedOut
      ? `Timed out after ${opts.timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    stderr = message;
    exitCode = timedOut ? 124 : 1;
    log("ERROR", opts.context, `Codex invocation failed: ${message.slice(0, 500)}`);
  } finally {
    clearTimeout(timeout);
  }

  const durationMs = Date.now() - startTime;
  const durationSec = (durationMs / 1000).toFixed(1);
  log("INFO", opts.context, `Agent finished in ${durationSec}s (exit=${exitCode === 0 ? "ok" : "fail"})`);

  return {
    success: exitCode === 0,
    output,
    stderr,
    durationMs,
    exitCode,
  };
}
