// Tests for postPRLink retry + fallback logic
// Run: node --experimental-strip-types --test src/runner/run-issue.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { postPRLink, transitionToInReview } from "./run-issue.ts";

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
