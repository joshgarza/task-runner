// Tests for postPRLink retry + fallback logic
// Run: node --experimental-strip-types --test src/runner/run-issue.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { postPRLink, transitionToInReview, runIssue } from "./run-issue.ts";
import type { RunIssueDependencies } from "./run-issue.ts";
import type { TaskRunnerConfig, LinearIssue } from "../types.ts";

// Mock modules before importing the function under test
const addCommentCalls: { issueId: string; body: string }[] = [];
let addCommentBehavior: "succeed" | "fail" | "fail-then-succeed" = "succeed";
let addCommentCallCount = 0;

const updateIssueCalls: { issueId: string; teamKey: string; opts: any }[] = [];
let updateIssueBehavior: "succeed" | "fail" = "succeed";

const logCalls: { level: string; context: string | null; message: string }[] = [];

describe("postPRLink", () => {
  let addCommentFn: (issueId: string, body: string) => Promise<void>;
  let updateIssueFn: (issueId: string, teamKey: string, opts: any) => Promise<void>;
  let logFn: (level: string, context: string | null, message: string) => void;

  beforeEach(() => {
    addCommentCalls.length = 0;
    updateIssueCalls.length = 0;
    logCalls.length = 0;
    addCommentCallCount = 0;
    addCommentBehavior = "succeed";
    updateIssueBehavior = "succeed";

    addCommentFn = async (issueId, body) => {
      addCommentCallCount++;
      addCommentCalls.push({ issueId, body });
      if (addCommentBehavior === "fail") {
        throw new Error("Linear API 500");
      }
      if (addCommentBehavior === "fail-then-succeed" && addCommentCallCount === 1) {
        throw new Error("Linear API rate limit");
      }
    };

    updateIssueFn = async (issueId, teamKey, opts) => {
      updateIssueCalls.push({ issueId, teamKey, opts });
      if (updateIssueBehavior === "fail") {
        throw new Error("Linear API 500");
      }
    };

    logFn = (level, context, message) => {
      logCalls.push({ level, context, message });
    };
  });

  it("posts comment on first attempt when addComment succeeds", async () => {
    addCommentBehavior = "succeed";

    await postPRLink("issue-1", "JOS", "https://github.com/pr/1", "desc", "JOS-1", {
      addComment: addCommentFn,
      updateIssue: updateIssueFn,
      log: logFn,
      delay: async () => {},
    });

    assert.equal(addCommentCalls.length, 1);
    assert.equal(updateIssueCalls.length, 0);
    assert.equal(addCommentCalls[0].body, "🤖 PR created: https://github.com/pr/1");
  });

  it("retries addComment and succeeds on second attempt", async () => {
    addCommentBehavior = "fail-then-succeed";

    await postPRLink("issue-1", "JOS", "https://github.com/pr/1", "desc", "JOS-1", {
      addComment: addCommentFn,
      updateIssue: updateIssueFn,
      log: logFn,
      delay: async () => {},
    });

    assert.equal(addCommentCalls.length, 2, "should have tried addComment twice");
    assert.equal(updateIssueCalls.length, 0, "should not fall back to updateIssue");
    const warnLogs = logCalls.filter((l) => l.level === "WARN");
    assert.equal(warnLogs.length, 1, "should log one warning for the first failed attempt");
  });

  it("falls back to updateIssue when all addComment retries fail", async () => {
    addCommentBehavior = "fail";

    await postPRLink("issue-1", "JOS", "https://github.com/pr/1", "existing desc", "JOS-1", {
      addComment: addCommentFn,
      updateIssue: updateIssueFn,
      log: logFn,
      delay: async () => {},
    });

    assert.equal(addCommentCalls.length, 2, "should have retried addComment");
    assert.equal(updateIssueCalls.length, 1, "should fall back to updateIssue");
    assert.equal(updateIssueCalls[0].opts.description, "existing desc\n\nPR: https://github.com/pr/1");

    const infoLogs = logCalls.filter((l) => l.level === "INFO");
    assert.ok(
      infoLogs.some((l) => l.message.includes("description fallback")),
      "should log fallback success"
    );
  });

  it("handles null description in fallback", async () => {
    addCommentBehavior = "fail";

    await postPRLink("issue-1", "JOS", "https://github.com/pr/1", null, "JOS-1", {
      addComment: addCommentFn,
      updateIssue: updateIssueFn,
      log: logFn,
      delay: async () => {},
    });

    assert.equal(updateIssueCalls.length, 1);
    assert.equal(updateIssueCalls[0].opts.description, "\n\nPR: https://github.com/pr/1");
  });

  it("does not throw when both addComment and updateIssue fail", async () => {
    addCommentBehavior = "fail";
    updateIssueBehavior = "fail";

    // Should not throw
    await postPRLink("issue-1", "JOS", "https://github.com/pr/1", "desc", "JOS-1", {
      addComment: addCommentFn,
      updateIssue: updateIssueFn,
      log: logFn,
      delay: async () => {},
    });

    assert.equal(addCommentCalls.length, 2);
    assert.equal(updateIssueCalls.length, 1);
    const warnLogs = logCalls.filter((l) => l.level === "WARN");
    assert.ok(
      warnLogs.some((l) => l.message.includes("Failed to persist PR URL via description fallback")),
      "should log the final fallback failure"
    );
  });
});

describe("transitionToInReview", () => {
  it("retries a transient Linear transition failure", async () => {
    let attempts = 0;
    const result = await transitionToInReview(
      "issue-1",
      "JOS",
      "In Review",
      "JOS-1",
      {
        transitionIssue: async () => {
          attempts++;
          if (attempts === 1) throw new Error("Linear unavailable");
        },
        delay: async () => {},
        log: () => {},
      }
    );

    assert.deepEqual(result, { transitioned: true, attempts: 2 });
  });

  it("returns failure after both Linear transition attempts fail", async () => {
    const result = await transitionToInReview(
      "issue-1",
      "JOS",
      "In Review",
      "JOS-1",
      {
        transitionIssue: async () => { throw new Error("Linear unavailable"); },
        delay: async () => {},
        log: () => {},
      }
    );

    assert.deepEqual(result, {
      transitioned: false,
      attempts: 2,
      error: "Linear unavailable",
    });
  });
});

describe("local publication and recovery boundary", () => {
  const config: TaskRunnerConfig = {
    projects: {}, github: { prLabels: [] },
    defaults: {
      model: "gpt-5.6-terra", reasoningEffort: "high", contextModel: "gpt-5.6-terra",
      contextReasoningEffort: "medium", maxAttempts: 2, maxDrainFailures: 3,
      agentTimeoutMs: 1000, drainConcurrency: 1,
    },
    linear: {
      agentLabel: "agent-ready", agentFailedLabel: "agent-failed", trustedCommentAuthorIds: [],
      needsApprovalLabel: "needs-human-approval", inProgressState: "In Progress",
      inReviewState: "In Review", todoState: "Todo", doneState: "Done",
    },
  };
  const issue: LinearIssue = {
    id: "fixture", identifier: "JOS-294", title: "Native review fixture", description: "Complete fixture",
    teamKey: "JOS", teamName: "Josh", stateName: "Todo", stateId: "todo",
    projectName: "fixture", projectId: "fixture", labels: ["agent-ready"],
    comments: [], url: "https://linear.app/example/issue/JOS-294", branchName: "unused",
  };
  function setup(overrides: Partial<RunIssueDependencies> = {}) {
    const calls: string[] = [];
    const deps: RunIssueDependencies = {
      loadConfig: () => config,
      getProjectConfig: () => ({ repoPath: "/fixture", defaultBranch: "main", testCommand: "npm test", lintCommand: "npm run lint" }),
      fetchIssue: async () => issue,
      fetchBlockingRelations: async () => [],
      transitionIssue: async () => { calls.push("transition"); },
      addComment: async (_id, body) => { calls.push(body); },
      createWorktree: () => { calls.push("create-worktree"); return "/fixture/.task-runner-worktrees/JOS-294"; },
      removeWorktree: (_path, _id, deleteRemote) => { assert.equal(deleteRemote, false); calls.push("cleanup"); },
      hasCommits: () => true,
      pushBranch: () => { calls.push("push"); },
      createPR: () => { calls.push("pr"); return "https://github.com/example/repo/pull/1"; },
      runLocalCodex: async (options) => {
        assert.deepEqual(options.outputSchema, {
          type: "object", properties: { outcome: { type: "string", enum: ["completed", "blocked"] }, summary: { type: "string" } },
          required: ["outcome", "summary"], additionalProperties: false,
        });
        return { success: true, output: JSON.stringify({ outcome: "completed", summary: "Implemented, tested and committed" }), stderr: "", durationMs: 1, exitCode: 0 };
      },
      validateAgentOutput: () => { calls.push("validate"); return { valid: true, errors: [], warnings: [] }; },
      requestCodexReview: async () => { calls.push("review"); return { requested: true, attempts: 1 }; },
      postPRLink: async () => { calls.push("link"); },
      transitionToInReview: async () => { calls.push("in-review"); return { transitioned: true, attempts: 1 }; },
      rollbackInProgress: async () => { calls.push("rollback"); },
      delegateCloudIssue: async () => { throw new Error("Unexpected cloud delegation"); },
      quarantineDrainFailure: async () => { throw new Error("Unexpected quarantine"); },
      logToFile: () => {},
      ...overrides,
    };
    return { calls, deps };
  }

  it("validates before push, preserves the PR, requests review and cleans only successful local work", async () => {
    const { calls, deps } = setup();
    const result = await runIssue("JOS-294", {}, deps);
    assert.equal(result.success, true);
    assert.ok(calls.indexOf("validate") < calls.indexOf("push"));
    assert.deepEqual(calls.filter(x => ["push", "pr", "link", "review", "in-review", "cleanup"].includes(x)),
      ["push", "pr", "link", "review", "in-review", "cleanup"]);
    assert.ok(!calls.includes("rollback"));
  });

  for (const failure of ["runtime", "validation", "push", "pr", "exception"]) {
    it(`retains output after ${failure} failure and does not publish unvalidated commits`, async () => {
      const { calls, deps } = setup();
      if (failure === "runtime") deps.runLocalCodex = async () => ({ success: false, output: "", stderr: "approval unavailable", durationMs: 1, exitCode: 1 });
      if (failure === "validation") deps.validateAgentOutput = () => ({ valid: false, errors: ["Tests failed"], warnings: [] });
      if (failure === "push") deps.pushBranch = () => { throw new Error("push failed"); };
      if (failure === "pr") deps.createPR = () => { throw new Error("PR failed"); };
      if (failure === "exception") deps.runLocalCodex = async () => { throw new Error("unexpected worker error"); };
      if (failure === "exception") await assert.rejects(runIssue("JOS-294", {}, deps), /unexpected worker error/);
      else {
        const result = await runIssue("JOS-294", {}, deps);
        assert.equal(result.success, false);
        assert.ok(result.attempts <= 2);
        if (failure === "runtime") assert.equal(result.attempts, 1, "must not reset native approval context after a failed turn");
      }
      assert.ok(calls.some(x => x.startsWith("Retained worktree: /fixture/.task-runner-worktrees/JOS-294")));
      assert.ok(calls.includes("rollback"));
      assert.ok(!calls.includes("cleanup"));
      assert.ok(!calls.includes("review"));
      if (["runtime", "validation", "exception"].includes(failure)) assert.ok(!calls.includes("push"));
    });
  }

  it("can retry validation failure and publish only after the later attempt validates", async () => {
    let validations = 0;
    const { calls, deps } = setup({ validateAgentOutput: () => ({
      valid: ++validations === 2, errors: validations === 1 ? ["Tests failed"] : [], warnings: [],
    }) });
    const result = await runIssue("JOS-294", {}, deps);
    assert.equal(result.success, true);
    assert.equal(result.attempts, 2);
    assert.equal(validations, 2);
    assert.equal(calls.filter(x => x === "push").length, 1);
  });

  it("never publishes when the last attempt fails after an earlier validation failure", async () => {
    let attempts = 0;
    const { calls, deps } = setup({
      runLocalCodex: async () => ({ success: ++attempts === 1, output: JSON.stringify({ outcome: "completed", summary: "Task done" }), stderr: "interrupted", durationMs: 1, exitCode: attempts === 1 ? 0 : 1 }),
      validateAgentOutput: () => ({ valid: false, errors: ["Tests failed"], warnings: [] }),
    });
    assert.equal((await runIssue("JOS-294", {}, deps)).success, false);
    assert.equal(attempts, 2);
    assert.ok(!calls.includes("push"));
    assert.ok(!calls.includes("cleanup"));
  });

  for (const output of [JSON.stringify({ outcome: "blocked", summary: "Native permission review denied the commit" }), "Not JSON", JSON.stringify({ outcome: "completed" })]) {
    it(`stops on a blocked or invalid normal-exit report: ${output}`, async () => {
      let attempts = 0;
      const { calls, deps } = setup({ runLocalCodex: async () => {
        attempts++;
        return { success: true, output, stderr: "", durationMs: 1, exitCode: 0 };
      } });
      const result = await runIssue("JOS-294", {}, deps);
      assert.equal(result.success, false);
      assert.equal(attempts, 1);
      assert.ok(!calls.includes("validate"));
      assert.ok(!calls.includes("push"));
      assert.ok(!calls.includes("cleanup"));
    });
  }

  it("does not retry or publish when validation changed the worker HEAD", async () => {
    let validations = 0;
    const { calls, deps } = setup({ validateAgentOutput: () => {
      validations++;
      return { valid: false, retryable: false, errors: ["HEAD changed during validation"], warnings: [] };
    } });
    const result = await runIssue("JOS-294", {}, deps);
    assert.equal(result.success, false);
    assert.equal(result.attempts, 1);
    assert.equal(validations, 1);
    assert.ok(!calls.includes("push"));
    assert.ok(!calls.includes("cleanup"));
  });

  for (const labels of [["execution:ops"], ["needs-human-approval"], ["execution:unknown"], ["execution:local", "execution:cloud"]]) {
    it(`rejects gated routing before creating a worktree: ${labels.join(", ")}`, async () => {
      const { calls, deps } = setup({ fetchIssue: async () => ({ ...issue, labels }) });
      assert.equal((await runIssue("JOS-294", {}, deps)).success, false);
      assert.ok(!calls.includes("create-worktree"));
    });
  }

  it("does not create a worktree when active blockers remain", async () => {
    const { calls, deps } = setup({ fetchBlockingRelations: async () => [{
      identifier: "JOS-1", title: "Decision", done: false, stateName: "Todo",
    }] });
    assert.equal((await runIssue("JOS-294", {}, deps)).success, false);
    assert.ok(!calls.includes("create-worktree"));
  });
});
