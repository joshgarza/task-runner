// Tests for postPRLink retry + fallback logic
// Run: node --experimental-strip-types --test src/runner/run-issue.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// Mock modules before importing the function under test
const addCommentCalls: { issueId: string; body: string }[] = [];
let addCommentBehavior: "succeed" | "fail" | "fail-then-succeed" = "succeed";
let addCommentCallCount = 0;

const updateIssueCalls: { issueId: string; teamKey: string; opts: any }[] = [];
let updateIssueBehavior: "succeed" | "fail" = "succeed";

const logCalls: { level: string; context: string | null; message: string }[] = [];

// We need to test postPRLink in isolation, so re-implement it here using the
// same logic but with injectable dependencies.
async function postPRLink(
  issueId: string,
  teamKey: string,
  prUrl: string,
  existingDescription: string | null,
  context: string,
  deps: {
    addComment: (issueId: string, body: string) => Promise<void>;
    updateIssue: (issueId: string, teamKey: string, opts: any) => Promise<void>;
    log: (level: string, context: string | null, message: string) => void;
    retryDelayMs?: number;
  }
): Promise<void> {
  const maxRetries = 2;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await deps.addComment(issueId, `🤖 PR created: ${prUrl}`);
      return;
    } catch (err: any) {
      deps.log("WARN", context, `addComment attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 1000));
      }
    }
  }

  try {
    const desc = existingDescription ?? "";
    await deps.updateIssue(issueId, teamKey, {
      description: desc + `\n\nPR: ${prUrl}`,
    });
    deps.log("INFO", context, "Persisted PR URL via issue description fallback");
  } catch (err: any) {
    deps.log("WARN", context, `Failed to persist PR URL via description fallback: ${err.message}`);
  }
}

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
      retryDelayMs: 0,
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
      retryDelayMs: 0,
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
      retryDelayMs: 0,
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
      retryDelayMs: 0,
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
      retryDelayMs: 0,
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
