import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("hub creation starts from main and never tries to copy secrets by default", (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "task-runner-hub-test-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const hub = join(temporary, "runner");
  const bare = `${hub}.git`;
  const bin = join(temporary, "bin");
  mkdirSync(hub);
  mkdirSync(bin);
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (...args: string[]) => execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--bare", bare);
  git("-C", bare, "worktree", "add", "-b", "main", join(hub, "main"));
  git("-C", join(hub, "main"), "commit", "--allow-empty", "-m", "Initial");
  git("-C", bare, "symbolic-ref", "HEAD", "refs/heads/missing");
  // Instrument copies and replace dependency installation with a local no-op.
  // No real or dummy secret file is created or opened.
  writeFileSync(join(bin, "cp"), "#!/bin/sh\necho 'Unexpected copy' >&2\nexit 99\n");
  writeFileSync(join(bin, "npm"), "#!/bin/sh\n[ \"$1\" = ci ]\n");
  for (const command of ["cp", "npm"]) chmodSync(join(bin, command), 0o755);
  const helper = join(hub, "create-worktree.sh");
  copyFileSync(new URL("../../scripts/hub/create-worktree.sh", import.meta.url), helper);
  const result = spawnSync("bash", [helper, "audit", "feat/audit"], {
    env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git("-C", join(hub, "audit"), "symbolic-ref", "--short", "HEAD"), "feat/audit");
  assert.equal(git("-C", bare, "rev-parse", "feat/audit"), git("-C", bare, "rev-parse", "main"));
  const invalid = spawnSync("bash", [helper, "../outside"], { env, encoding: "utf8" });
  assert.equal(invalid.status, 1);
});
