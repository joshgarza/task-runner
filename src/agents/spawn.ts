// Codex SDK wrapper for agent turns

import os from "node:os";
import type { Codex, CodexOptions } from "@openai/codex-sdk";
import { log } from "../logger.ts";
import type { AgentResult, ModelReasoningEffort } from "../types.ts";

type Profile = "write" | "read";
const clients = new Map<Profile, Promise<Codex>>();

export function codexClientOptions(profile: Profile): CodexOptions {
  return {
    // Do not pass Linear/API credentials or the runner's environment wholesale.
    env: {
      HOME: process.env.HOME ?? os.homedir(),
      PATH: process.env.PATH ?? "",
      TERM: process.env.TERM ?? "xterm-256color",
    },
    config: { approvals_reviewer: profile === "write" ? "auto_review" : "user" },
  };
}

async function getCodexClient(profile: Profile): Promise<Codex> {
  if (!clients.has(profile)) {
    clients.set(profile, import("@openai/codex-sdk").then(({ Codex }) =>
      new Codex(codexClientOptions(profile))
    ));
  }
  return clients.get(profile)!;
}

export interface LocalCodexOptions {
  prompt: string;
  cwd: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  profile: Profile;
  timeoutMs: number;
  context: string;
  outputSchema?: unknown;
}

/**
 * Run an agent turn through the Codex SDK.
 */
export async function runLocalCodex(
  opts: LocalCodexOptions,
  createClient: typeof getCodexClient = getCodexClient
): Promise<AgentResult> {
  const sandboxMode = opts.profile === "write" ? "workspace-write" : "read-only";
  const approvalPolicy = opts.profile === "write" ? "on-request" : "never";

  log(
    "INFO",
    opts.context,
    `Running local Codex model=${opts.model} reasoning=${opts.reasoningEffort} sandbox=${sandboxMode} approvals=${approvalPolicy} reviewer=${opts.profile === "write" ? "auto_review" : "user"} network=false`
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
    const client = await createClient(opts.profile);
    const thread = client.startThread({
      model: opts.model,
      modelReasoningEffort: opts.reasoningEffort,
      sandboxMode,
      workingDirectory: opts.cwd,
      skipGitRepoCheck: true,
      approvalPolicy,
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
  log("INFO", opts.context, `Local Codex finished in ${durationSec}s (exit=${exitCode === 0 ? "ok" : "fail"})`);

  return {
    success: exitCode === 0,
    output,
    stderr,
    durationMs,
    exitCode,
  };
}
