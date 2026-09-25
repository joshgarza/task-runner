import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Codex } from "@openai/codex-sdk";
import { codexClientOptions, runLocalCodex } from "./spawn.ts";

// Exercise the real SDK's CLI serialization, without starting Codex or loading
// account configuration. Only the external executable is replaced.
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "task-runner-sdk-test-"));
  const executable = join(cwd, "codex-fixture.mjs");
  writeFileSync(executable, `#!/usr/bin/env node
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (input === 'fail') {
  console.error('Permission review unavailable');
  process.exit(7);
}
if (input === 'timeout') {
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({type: 'thread.started', thread_id: 'fixture'}));
  console.log(JSON.stringify({type: 'item.completed', item: {
    id: 'result', type: 'agent_message', text: JSON.stringify(process.argv.slice(2))
  }}));
  console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 0, output_tokens: 0}}));
}
`, { mode: 0o700 });
  return {
    cwd,
    client: async (profile: "write" | "read") => new Codex({
      ...codexClientOptions(profile), codexPathOverride: executable,
    }),
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

for (const profile of ["write", "read"] as const) {
  test(`${profile} profile sends explicit sandbox, network and native reviewer settings to the CLI`, async () => {
    const f = fixture();
    try {
      assert.deepEqual(Object.keys(codexClientOptions(profile).env!).sort(), ["HOME", "PATH", "TERM"]);
      const result = await runLocalCodex({
        prompt: "ok", cwd: f.cwd, model: "gpt-5.6-terra", reasoningEffort: "high",
        profile, timeoutMs: 10_000, context: "sdk-test",
      }, f.client);
      assert.equal(result.success, true, result.stderr);
      const args: string[] = JSON.parse(result.output);
      assert.equal(args[0], "exec");
      assert.ok(args.includes(`approvals_reviewer="${profile === "write" ? "auto_review" : "user"}"`));
      assert.ok(args.includes(`approval_policy="${profile === "write" ? "on-request" : "never"}"`));
      assert.equal(args[args.indexOf("--sandbox") + 1], profile === "write" ? "workspace-write" : "read-only");
      assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
      assert.equal(args[args.indexOf("--cd") + 1], f.cwd);
      assert.ok(args.includes('model_reasoning_effort="high"'));
      assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
    } finally { f.cleanup(); }
  });
}

for (const prompt of ["fail", "timeout"]) {
  test(`native runtime ${prompt} fails closed without a permission fallback`, async () => {
    const f = fixture();
    try {
      let invocations = 0;
      const result = await runLocalCodex({
        prompt, cwd: f.cwd, model: "gpt-5.6-terra", reasoningEffort: "high",
        profile: "write", timeoutMs: prompt === "timeout" ? 250 : 10_000, context: "sdk-test",
      }, async (profile) => { invocations++; return f.client(profile); });
      assert.equal(invocations, 1);
      assert.equal(result.success, false);
      assert.equal(result.exitCode, prompt === "timeout" ? 124 : 1);
      assert.match(result.stderr, prompt === "timeout" ? /Timed out/ : /Permission review unavailable/);
    } finally { f.cleanup(); }
  });
}
