import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateAgentOutput } from "./validate.ts";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "task-runner-validation-test-"));
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-b", "main");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  writeFileSync(join(cwd, "child.test.mjs"), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
test('child process', () => assert.equal(execFileSync(process.execPath, ['-e', 'console.log(42)'], {encoding: 'utf8'}).trim(), '42'));
`);
  git("add", "README.md", "child.test.mjs");
  git("commit", "-m", "Baseline");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(cwd, "README.md"), "completed task\n");
  git("add", "README.md");
  git("commit", "-m", "Task");
  return {
    cwd, git,
    config: { repoPath: cwd, defaultBranch: "main", testCommand: "node --test child.test.mjs", lintCommand: "node -e ''" },
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

test("validates committed output with a real child-process test", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  assert.equal((await validateAgentOutput(f.cwd, "main", f.config, "fixture")).valid, true);
});

for (const kind of ["tracked", "untracked", "test-output", "test-commit", "failed-test"]) {
  test(`rejects ${kind} output even when task commits exist`, async (t) => {
    const f = fixture(); t.after(f.cleanup);
    if (kind === "tracked") writeFileSync(join(f.cwd, "README.md"), "uncommitted fix\n");
    if (kind === "untracked") writeFileSync(join(f.cwd, "draft.md"), "unfinished\n");
    if (kind === "test-output") f.config.testCommand = `node -e 'require("node:fs").writeFileSync("generated.txt", "unfinished")'`;
    if (kind === "test-commit") f.config.testCommand = "git commit --allow-empty -m test-mutation";
    if (kind === "failed-test") f.config.testCommand = "node -e 'process.exit(1)'";
    const result = await validateAgentOutput(f.cwd, "main", f.config, "fixture");
    assert.equal(result.valid, false);
    assert.equal(result.retryable, kind !== "test-commit");
    assert.match(result.errors.join("\n"), kind === "test-commit" ? /HEAD changed/ : kind === "failed-test" ? /Tests failed/ : /Uncommitted changes/);
  });
}

test('disk cancellation interrupts synchronous-looking tests and their descendants while preserving output', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const controller = new AbortController();
  f.config.testCommand = `node -e 'require("node:fs").writeFileSync("retained.txt", "partial output"); setInterval(()=>{}, 1000)'`;
  const timer = setTimeout(() => controller.abort(), 300); t.after(() => clearTimeout(timer));
  const start = Date.now();
  const result = await validateAgentOutput(f.cwd, 'main', f.config, 'fixture', controller.signal);
  assert.equal(result.valid, false); assert.equal(result.retryable, false);
  assert.ok(Date.now() - start < 5000); assert.match(result.errors.join(), /cancelled/);
  assert.ok(f.git('status', '--porcelain').includes('retained.txt'));
});
