import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_FAILURE_PATTERN,
  LEGACY_AGENT_FAILURE_PATTERN,
  countAgentFailures,
  getDrainFailureStatus,
  quarantineDrainFailure,
  reconcileDrainFailureMarker,
} from "./drain-failures.ts";
import { buildAgentReadyIssueFilter } from "../linear/queries.ts";
import * as comments from "../linear/comments.ts";

const policy = {
  agentLabel: "agent-ready",
  agentFailedLabel: "agent-failed",
  maxDrainFailures: 2,
};

describe("drain failure detection", () => {
  it("counts current and legacy local failure sentinels", () => {
    const issueComments = [
      "🤖 Agent failed, rolled back to Todo\n\nFirst",
      "## Agent Failed\n\nValidation details",
      "Prefix 🤖 Agent failed later in the comment",
      "🤖 Agent failed after another run",
      "## Agent Failed, Rolled Back to Todo\n\n### Error\n\n```\nlocal failure\n```",
      "## Agent Failed, Rolled Back to Todo\n\n### Error\n\n```\nFailed to delegate cloud work: unavailable\n```",
    ];

    assert.equal(countAgentFailures(issueComments), 3);
    assert.equal(AGENT_FAILURE_PATTERN.source, "^🤖 Agent failed");
    assert.equal(
      LEGACY_AGENT_FAILURE_PATTERN.source,
      "^## Agent Failed, Rolled Back to Todo"
    );
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

  it("applies the failure policy to a custom drain queue label", () => {
    const customPolicy = { ...policy, agentLabel: "priority-queue" };
    const status = getDrainFailureStatus(
      {
        labels: ["priority-queue", "execution:local"],
        comments: [
          "🤖 Agent failed, rolled back to Todo",
          "🤖 Agent failed, rolled back to Todo",
        ],
      },
      customPolicy
    );

    assert.equal(status.shouldQuarantine, true);
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

  it("bounds acknowledgement markers to the trusted failure count", () => {
    const status = getDrainFailureStatus(
      {
        labels: ["agent-ready", "execution:local"],
        comments: [
          "🤖 Agent failed, rolled back to Todo",
          "<!-- agent-failures-quarantined:999999 -->",
        ],
      },
      policy
    );

    assert.equal(status.totalFailureCount, 1);
    assert.equal(status.acknowledgedFailureCount, 1);
    assert.equal(status.failureCount, 0);
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
      createLabel: async () => ({ name: "agent-failed", id: "failed-id" }),
      fetchTaskRunnerCommentBodies: async () => [],
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
      createLabel: async () => {
        called = true;
        return { name: "agent-failed", id: "failed-id" };
      },
      fetchTaskRunnerCommentBodies: async () => {
        called = true;
        return [];
      },
    });

    assert.equal(status.shouldQuarantine, true);
    assert.equal(called, false);
  });

  it("recognizes a quarantined local issue without the queue label", () => {
    const status = getDrainFailureStatus(
      { labels: ["agent-failed", "execution:local"], comments: [] },
      policy
    );

    assert.equal(status.isLocal, true);
    assert.equal(status.applies, false);
    assert.equal(status.hasAgentFailedLabel, true);
  });

  it("creates the configured quarantine label when it is missing", async () => {
    const created: any[] = [];
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
      resolveTeamLabels: async () => new Map([["agent-ready", "ready-id"]]),
      applyLabelChanges: async () => ({
        labelsAdded: ["agent-failed"],
        labelsRemoved: ["agent-ready"],
      }),
      addComment: async () => {},
      createLabel: async (opts: any) => {
        created.push(opts);
        return { name: opts.name, id: "failed-id" };
      },
      fetchTaskRunnerCommentBodies: async () => [],
    });

    assert.deepEqual(created, [{
      name: "agent-failed",
      teamKey: "JOS",
      description: "Requires human triage before returning to the agent queue",
    }]);
  });

  it("restores queue labels when the quarantine marker cannot be posted", async () => {
    const labelCalls: any[] = [];
    let commentAttempts = 0;
    const issue = {
      id: "issue-1",
      teamKey: "JOS",
      labels: ["agent-ready", "execution:local"],
      comments: [
        "🤖 Agent failed, rolled back to Todo",
        "🤖 Agent failed, rolled back to Todo",
      ],
    };

    await assert.rejects(
      quarantineDrainFailure(issue, policy, false, {
        resolveTeamLabels: async () => new Map([
          ["agent-ready", "ready-id"],
          ["agent-failed", "failed-id"],
        ]),
        applyLabelChanges: async (...args: any[]) => {
          labelCalls.push(args);
          return { labelsAdded: [], labelsRemoved: [] };
        },
        addComment: async () => {
          commentAttempts += 1;
          throw new Error("comment unavailable");
        },
        createLabel: async () => ({ name: "agent-failed", id: "failed-id" }),
        fetchTaskRunnerCommentBodies: async () => [],
      }),
      /comment unavailable/
    );

    assert.equal(commentAttempts, 2);
    assert.deepEqual(labelCalls[1].slice(2), [
      ["agent-ready"],
      ["agent-failed"],
      false,
    ]);
  });

  it("keeps quarantine labels when a failed comment response actually persisted", async () => {
    const labelCalls: any[] = [];
    const issue = {
      id: "issue-1",
      teamKey: "JOS",
      labels: ["agent-ready", "execution:local"],
      comments: [
        "🤖 Agent failed, rolled back to Todo",
        "🤖 Agent failed, rolled back to Todo",
      ],
    };
    const persistedComment = comments.agentFailureQuarantined({
      failureCount: 2,
      totalFailureCount: 2,
      agentLabel: policy.agentLabel,
      agentFailedLabel: policy.agentFailedLabel,
    });

    await quarantineDrainFailure(issue, policy, false, {
      resolveTeamLabels: async () => new Map([
        ["agent-ready", "ready-id"],
        ["agent-failed", "failed-id"],
      ]),
      applyLabelChanges: async (...args: any[]) => {
        labelCalls.push(args);
        return { labelsAdded: [], labelsRemoved: [] };
      },
      addComment: async () => {
        throw new Error("response lost");
      },
      createLabel: async () => ({ name: "agent-failed", id: "failed-id" }),
      fetchTaskRunnerCommentBodies: async () => [persistedComment],
    });

    assert.equal(labelCalls.length, 1);
  });

  it("reconciles a missing marker on a fail-closed quarantined issue", async () => {
    const posted: string[] = [];
    const issue = {
      id: "issue-1",
      labels: ["agent-failed", "execution:local"],
      comments: [
        "🤖 Agent failed, rolled back to Todo",
        "🤖 Agent failed, rolled back to Todo",
      ],
    };

    const status = await reconcileDrainFailureMarker(issue, policy, false, {
      addComment: async (_issueId, body) => {
        posted.push(body);
      },
    });

    assert.equal(status?.failureCount, 2);
    assert.equal(posted.length, 1);
    assert.match(posted[0], /agent-failures-quarantined:2/);

    const alreadyReconciled = await reconcileDrainFailureMarker(
      { ...issue, comments: [...issue.comments, posted[0]] },
      policy,
      false,
      { addComment: async () => assert.fail("must not post twice") }
    );
    assert.equal(alreadyReconciled, null);
  });
});

describe("drain failure comments and query", () => {
  it("emits one countable sentinel for a rolled-back pipeline failure", () => {
    assert.match(comments.rollback({ error: "failed", attempts: 2 }), AGENT_FAILURE_PATTERN);
    assert.doesNotMatch(
      comments.agentFailed({ attempts: 2, maxAttempts: 2, errors: "failed" }),
      AGENT_FAILURE_PATTERN
    );
    assert.doesNotMatch(
      comments.rollback({
        error: "Failed to delegate cloud work: unavailable",
        attempts: 0,
        countAsAgentFailure: false,
      }),
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
