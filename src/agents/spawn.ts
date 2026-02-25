// spawnSync wrapper for `claude -p` invocations

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../logger.ts";
import { loadRegistry, resolveAgentType } from "./registry.ts";
import type { AgentResult } from "../types.ts";

const AGENTS_DIR = import.meta.dirname;

export function loadToolWhitelist(filename: string): string[] {
  const filepath = resolve(AGENTS_DIR, filename);
  const config = JSON.parse(readFileSync(filepath, "utf-8"));
  return config.tools;
}

export interface SpawnOptions {
  prompt: string;
  cwd: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  toolsFile?: string;   // legacy: load tools from JSON file
  agentType?: string;    // new: resolve tools from agent registry
  timeoutMs: number;
  context: string; // for logging
}

/**
 * Resolve the tool whitelist and caps from either agentType or toolsFile.
 * agentType takes precedence. Enforces budget/turns caps from registry.
 */
function resolveSpawnTools(opts: SpawnOptions): {
  tools: string[];
  maxTurns: number;
  maxBudgetUsd: number;
} {
  if (opts.agentType) {
    const registry = loadRegistry();
    const resolved = resolveAgentType(opts.agentType, registry);
    return {
      tools: resolved.tools,
      maxTurns: Math.min(opts.maxTurns, resolved.maxTurns),
      maxBudgetUsd: Math.min(opts.maxBudgetUsd, resolved.maxBudgetUsd),
    };
  }

  if (opts.toolsFile) {
    return {
      tools: loadToolWhitelist(opts.toolsFile),
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
    };
  }

  throw new Error("SpawnOptions requires either agentType or toolsFile");
}

/**
 * Spawn a Claude agent via `claude -p` with piped prompt.
 * Returns structured result with output, stderr, timing.
 */
export function spawnAgent(opts: SpawnOptions): AgentResult {
  const { tools, maxTurns, maxBudgetUsd } = resolveSpawnTools(opts);

  const claudeArgs = [
    "-p",
    "--model", opts.model,
    "--max-turns", maxTurns.toString(),
    "--max-budget-usd", maxBudgetUsd.toString(),
    "--permission-mode", "bypassPermissions",
    "--output-format", "json",
    "--allowedTools", ...tools,
  ];

  const agentLabel = opts.agentType ? `[${opts.agentType}]` : `[${opts.toolsFile}]`;
  log("INFO", opts.context, `Spawning claude ${opts.model} ${agentLabel} (max-turns: ${maxTurns}, budget: $${maxBudgetUsd})`);

  const startTime = Date.now();
  let output = "";
  let stderr = "";
  let exitCode: number | null = null;

  try {
    const { CLAUDECODE, ...cleanEnv } = process.env;
    const result = spawnSync("claude", claudeArgs, {
      cwd: opts.cwd,
      input: opts.prompt,
      timeout: opts.timeoutMs,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: cleanEnv,
    });

    if (result.error) {
      throw result.error;
    }

    output = result.stdout || "";
    stderr = result.stderr || "";
    exitCode = result.status;

    if (result.status !== 0) {
      log("ERROR", opts.context, `Claude exited with code ${result.status}`);
      if (stderr) {
        log("ERROR", opts.context, `stderr: ${stderr.slice(0, 500)}`);
      }
    }
  } catch (err: any) {
    output = err.message || "Unknown error";
    log("ERROR", opts.context, `Claude invocation failed: ${err.message?.slice(0, 500)}`);
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
