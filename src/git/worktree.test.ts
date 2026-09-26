import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, getBranchName, getWorktreePath } from "./worktree.ts";

describe("worktree naming", () => {
  it("keeps the task-runner branch prefix by default", () => {
    assert.equal(getBranchName("JOS-123"), "task-runner/jos-123");
  });

  it("uses a configured project branch prefix", () => {
    assert.equal(getBranchName("JOS-123", "feature"), "feature/jos-123");
  });

  it("normalizes issue identifiers to lowercase", () => {
    assert.equal(getBranchName("ABC-42", "automation"), "automation/abc-42");
  });

  it("keeps issue worktrees isolated under the runner directory", () => {
    assert.equal(
      getWorktreePath("/workspace/repo", "JOS-123"),
      "/workspace/repo/.task-runner-worktrees/JOS-123"
    );
  });
});

it("refuses to overwrite retained output in a bare-repo worktree layout", (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "task-runner-recovery-test-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bare = join(temporary, "repo.git");
  const main = join(temporary, "main");
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (...args: string[]) => execFileSync("git", args, {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "--bare", bare);
  git("-C", bare, "worktree", "add", "-b", "main", main);
  git("-C", main, "commit", "--allow-empty", "-m", "Initial");
  const retained = getWorktreePath(main, "JOS-294");
  git("-C", main, "worktree", "add", "-b", "task-runner/jos-294", retained, "main");
  writeFileSync(join(retained, "committed.txt"), "committed output\n");
  git("-C", retained, "add", "committed.txt");
  git("-C", retained, "commit", "-m", "Partial work");
  const head = git("-C", retained, "rev-parse", "HEAD");
  writeFileSync(join(retained, "committed.txt"), "unfinished edit\n");
  writeFileSync(join(retained, "draft.md"), "untracked draft\n");
  mkdirSync(join(retained, "nested"));
  writeFileSync(join(retained, "nested", "draft.md"), "nested draft\n");
  // There is deliberately no origin. The collision must stop before fetch,
  // cleanup, branch recreation, or reading any retained file contents.
  assert.throws(() => createWorktree(main, "JOS-294", "main"), /will not overwrite retained output/);
  assert.equal(git("-C", retained, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(retained, "committed.txt"), "utf8"), "unfinished edit\n");
  assert.equal(readFileSync(join(retained, "draft.md"), "utf8"), "untracked draft\n");
  assert.equal(readFileSync(join(retained, "nested", "draft.md"), "utf8"), "nested draft\n");
});
