import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBranchName, getWorktreePath } from "./worktree.ts";

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
