import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Codex } from "@openai/codex-sdk";

test("the SDK's bundled CLI supports the subscription model generation", () => {
  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const cliRoot = dirname(sdkRequire.resolve("@openai/codex/package.json"));
  // Resolve from the SDK dependency, never the global codex on PATH.
  // --version does not start a session or access account credentials.
  const output = execFileSync(process.execPath, [join(cliRoot, "bin/codex.js"), "--version"], {
    encoding: "utf8", timeout: 10_000,
  });
  const version = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(output);
  assert.ok(version, output);
  assert.ok(Number(version[1]) > 0 || Number(version[2]) >= 144, output);
  // Construction resolves the SDK's platform binary without starting a turn.
  assert.doesNotThrow(() => new Codex({ env: {} }).startThread({
    model: "gpt-5.6-terra", modelReasoningEffort: "high",
    approvalPolicy: "never", sandboxMode: "read-only", networkAccessEnabled: false,
  }));
});
