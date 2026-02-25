// spawnSync wrapper for `claude -p` invocations

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../logger.ts";
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
  toolsFile: string;
  timeoutMs: number;
  context: string; // for logging
}

/**
 * Spawn a Claude agent via `claude -p` with piped prompt.
 * Returns structured result with output, stderr, timing.
 */
export function spawnAgent(opts: SpawnOptions): AgentResult {
  const tools = loadToolWhitelist(opts.toolsFile);

  const claudeArgs = [
    "-p",
    "--model", opts.model,
    "--max-turns", opts.maxTurns.toString(),
    "--max-budget-usd", opts.maxBudgetUsd.toString(),
    "--permission-mode", "bypassPermissions",
    "--output-format", "json",
    "--allowedTools", ...tools,
  ];

  log("INFO", opts.context, `Spawning claude ${opts.model} (max-turns: ${opts.maxTurns}, budget: $${opts.maxBudgetUsd})`);

  const startTime = Date.now();
  let output = "";
  let stderr = "";
  let exitCode: number | null = null;

  try {
    const result = spawnSync("claude", claudeArgs, {
      cwd: opts.cwd,
      input: opts.prompt,
      timeout: opts.timeoutMs,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB
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
