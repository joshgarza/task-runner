// Tests for shell-safe git execution helpers
// Run: node --experimental-strip-types --test src/git/exec.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateBranchName, execGit } from "./exec.ts";

describe("validateBranchName", () => {
  it("accepts simple branch names", () => {
    assert.doesNotThrow(() => validateBranchName("main"));
    assert.doesNotThrow(() => validateBranchName("develop"));
  });

  it("accepts branch names with slashes", () => {
    assert.doesNotThrow(() => validateBranchName("feature/login"));
    assert.doesNotThrow(() => validateBranchName("task-runner/jos-141"));
  });

  it("accepts branch names with dots, hyphens, underscores", () => {
    assert.doesNotThrow(() => validateBranchName("release-1.0"));
    assert.doesNotThrow(() => validateBranchName("my_branch"));
    assert.doesNotThrow(() => validateBranchName("v2.0.0-rc.1"));
  });

  it("rejects branch names with semicolons (command injection)", () => {
    assert.throws(
      () => validateBranchName("main;rm -rf /"),
      /Invalid branch name/
    );
  });

  it("rejects branch names with ampersands", () => {
    assert.throws(
      () => validateBranchName("main&echo pwned"),
      /Invalid branch name/
    );
  });

  it("rejects branch names with pipes", () => {
    assert.throws(
      () => validateBranchName("main|cat /etc/passwd"),
      /Invalid branch name/
    );
  });

  it("rejects branch names with backticks", () => {
    assert.throws(
      () => validateBranchName("main`whoami`"),
      /Invalid branch name/
    );
  });

  it("rejects branch names with dollar signs", () => {
    assert.throws(
      () => validateBranchName("main$(whoami)"),
      /Invalid branch name/
    );
  });

  it("rejects branch names with spaces", () => {
    assert.throws(
      () => validateBranchName("main branch"),
      /Invalid branch name/
    );
  });

  it("rejects empty branch names", () => {
    assert.throws(
      () => validateBranchName(""),
      /Invalid branch name/
    );
  });
});

describe("execGit", () => {
  it("executes a simple git command", () => {
    // git --version should always work
    const result = execGit(["--version"]);
    assert.ok(result.startsWith("git version"));
  });

  it("throws on invalid git command", () => {
    assert.throws(
      () => execGit(["not-a-real-command"]),
      /git/
    );
  });

  it("passes arguments safely without shell interpolation", () => {
    // This would be dangerous with execSync + string interpolation
    // but execFileSync treats it as a literal argument
    assert.throws(
      () => execGit(["log", "origin/main;echo pwned..HEAD", "--oneline"]),
      // Should fail because it's treated as a literal ref name, not executed
      /./
    );
  });
});
