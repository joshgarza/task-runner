import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_FAILURE_PATTERN,
  countAgentFailures,
  getDrainFailureStatus,
  quarantineDrainFailure,
} from "./drain-failures.ts";
import { buildAgentReadyIssueFilter } from "../linear/queries.ts";
import * as comments from "../linear/comments.ts";

const policy = {
  agentLabel: "agent-ready",
  agentFailedLabel: "agent-failed",
  maxDrainFailures: 2,
};

describe("drain failure detection", () => {
  it("counts only comments beginning with the stable failure sentinel", () => {
    const issueComments = [
      "🤖 Agent failed, rolled back to Todo\n\nFirst",
      "## Agent Failed\n\nValidation details",
      "Prefix 🤖 Agent failed later in the comment",
      "🤖 Agent failed after another run",
    ];

    assert.equal(countAgentFailures(issueComments), 2);
    assert.equal(AGENT_FAILURE_PATTERN.source, "^🤖 Agent failed");
  });

  it("quarantines only local agent-ready work at the configured threshold", () => {
    const commentsAtThreshold = [
      "🤖 Agent failed, rolled back to Todo",
      "🤖 Agent failed, rolled back to Todo",
    ];

    assert.equal(
      getDrainFailureStatus(
        { labels: ["agent-ready", "execution:local"], comments: commentsAtThreshold },
        policy
      ).shouldQuarantine,
      true
    );
    assert.equal(
      getDrainFailureStatus(
        { labels: ["agent-ready", "execution:cloud"], comments: commentsAtThreshold },
        policy
      ).applies,
      false
    );
    assert.equal(
      getDrainFailureStatus(
        { labels: ["execution:local"], comments: commentsAtThreshold },
        policy
      ).applies,
      false
    );
  });

  it("honors a custom failure limit", () => {
    const threeFailurePolicy = { ...policy, maxDrainFailures: 3 };
    const issue = {
      labels: ["agent-ready", "execution:local"],
      comments: [
        "🤖 Agent failed, rolled back to Todo",
        "🤖 Agent failed, rolled back to Todo",
      ],
    };

    assert.equal(getDrainFailureStatus(issue, threeFailurePolicy).shouldQuarantine, false);
    issue.comments.push("🤖 Agent failed, rolled back to Todo");
    assert.equal(getDrainFailureStatus(issue, threeFailurePolicy).shouldQuarantine, true);
  });

  it("treats a quarantine marker as human acknowledgement when re-queued", () => {
    const priorFailures = [
      "🤖 Agent failed, rolled back to Todo",
      "🤖 Agent failed, rolled back to Todo",
      comments.agentFailureQuarantined({
        failureCount: 2,
        totalFailureCount: 2,
        agentLabel: policy.agentLabel,
        agentFailedLabel: policy.agentFailedLabel,
      }),
    ];

    const requeued = getDrainFailureStatus(
      { labels: ["agent-ready", "execution:local"], comments: priorFailures },
      policy
    );
    assert.equal(requeued.acknowledgedFailureCount, 2);
    assert.equal(requeued.failureCount, 0);
    assert.equal(requeued.shouldQuarantine, false);

    const failedAgain = getDrainFailureStatus(
      {
        labels: ["agent-ready", "execution:local"],
        comments: [...priorFailures, "🤖 Agent failed, rolled back to Todo"],
      },
      policy
    );
    assert.equal(failedAgain.failureCount, 1);
    assert.equal(failedAgain.shouldQuarantine, false);
  });

  it("adds the quarantine label, removes agent-ready, and posts instructions", async () => {
    const labelCalls: any[] = [];
    const commentCalls: any[] = [];
    const issue = {
      id: "issue-1",
      teamKey: "JOS",
      labels: ["agent-ready", "execution:local"],
      comments: [
        "🤖 Agent failed, rolled back to Todo",
        "🤖 Agent failed, rolled back to Todo",
      ],
    };

    await quarantineDrainFailure(issue, policy, false, {
      resolveTeamLabels: async () => new Map([
        ["agent-ready", "ready-id"],
        ["agent-failed", "failed-id"],
      ]),
      applyLabelChanges: async (...args: any[]) => {
        labelCalls.push(args);
        return { labelsAdded: ["agent-failed"], labelsRemoved: ["agent-ready"] };
      },
      addComment: async (...args: any[]) => {
        commentCalls.push(args);
      },
    });

    assert.equal(labelCalls.length, 1);
    assert.deepEqual(labelCalls[0].slice(2), [
      ["agent-failed"],
      ["agent-ready"],
      false,
    ]);
    assert.equal(commentCalls.length, 1);
    assert.match(commentCalls[0][1], /Agent failed 2 times, removing from queue/);
    assert.match(commentCalls[0][1], /remove `agent-failed` and re-add `agent-ready`/);
    assert.doesNotMatch(commentCalls[0][1], AGENT_FAILURE_PATTERN);
  });

  it("does not mutate Linear during a dry run", async () => {
    let called = false;
    const issue = {
      id: "issue-1",
      teamKey: "JOS",
      labels: ["agent-ready", "execution:local"],
      comments: [
        "🤖 Agent failed, rolled back to Todo",
        "🤖 Agent failed, rolled back to Todo",
      ],
    };

    const status = await quarantineDrainFailure(issue, policy, true, {
      resolveTeamLabels: async () => {
        called = true;
        return new Map();
      },
      applyLabelChanges: async () => {
        called = true;
        return { labelsAdded: [], labelsRemoved: [] };
      },
      addComment: async () => {
        called = true;
      },
    });

    assert.equal(status.shouldQuarantine, true);
    assert.equal(called, false);
  });
});

describe("drain failure comments and query", () => {
  it("emits one countable sentinel for a rolled-back pipeline failure", () => {
    assert.match(comments.rollback({ error: "failed", attempts: 2 }), AGENT_FAILURE_PATTERN);
    assert.doesNotMatch(
      comments.agentFailed({ attempts: 2, maxAttempts: 2, errors: "failed" }),
      AGENT_FAILURE_PATTERN
    );
  });

  it("excludes the configured failure label from the agent-ready query", () => {
    assert.deepEqual(
      buildAgentReadyIssueFilter(
        "agent-ready",
        ["Todo", "Backlog"],
        "task-runner",
        "agent-failed"
      ),
      {
        state: { name: { in: ["Todo", "Backlog"] } },
        and: [
          { labels: { some: { name: { eq: "agent-ready" } } } },
          { labels: { every: { name: { neq: "agent-failed" } } } },
        ],
        project: { name: { eq: "task-runner" } },
      }
    );
  });
});
