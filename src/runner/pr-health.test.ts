import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPrUrls, selectNewestPr, prHealth } from "./pr-health.ts";
import { emptyState } from "../lifecycle/model.ts";

describe("extractPrUrls", () => {
  it("extracts the PR link format written by the runner", () => {
    assert.deepEqual(
      extractPrUrls(["🤖 PR created: https://github.com/joshgarza/task-runner/pull/43"]),
      ["https://github.com/joshgarza/task-runner/pull/43"]
    );
  });

  it("preserves comment order so reconciliation can use the newest PR", () => {
    assert.deepEqual(
      extractPrUrls([
        "🤖 PR created: https://github.com/joshgarza/task-runner/pull/41",
        "🤖 PR created: https://github.com/joshgarza/task-runner/pull/42",
      ]),
      [
        "https://github.com/joshgarza/task-runner/pull/41",
        "https://github.com/joshgarza/task-runner/pull/42",
      ]
    );
  });

  it("extracts a PR URL persisted through the description fallback", () => {
    assert.deepEqual(
      extractPrUrls([], "Implementation details\n\nPR: https://github.com/joshgarza/task-runner/pull/43"),
      ["https://github.com/joshgarza/task-runner/pull/43"]
    );
  });

  it("returns description and comment URLs for metadata comparison", () => {
    assert.deepEqual(
      extractPrUrls(
        ["🤖 PR created: https://github.com/joshgarza/task-runner/pull/44"],
        "PR: https://github.com/joshgarza/task-runner/pull/43"
      ),
      [
        "https://github.com/joshgarza/task-runner/pull/43",
        "https://github.com/joshgarza/task-runner/pull/44",
      ]
    );
  });

  it("ignores comments without a GitHub pull request URL", () => {
    assert.deepEqual(extractPrUrls(["Agent starting work", "Validation passed"]), []);
  });

  it("ignores unrelated PR URLs in ticket context", () => {
    assert.deepEqual(
      extractPrUrls(
        [
          "🤖 PR created: https://github.com/joshgarza/task-runner/pull/43",
          "Compare with https://github.com/private/example/pull/99 before implementing",
        ],
        "Prior art: https://github.com/other/example/pull/100"
      ),
      ["https://github.com/joshgarza/task-runner/pull/43"]
    );
  });
});

describe('cloud PR reconciliation outside the local registry', () => {
  for (const state of ['MERGED', 'CLOSED']) {
    it(`reconciles ${state} cloud work while excluding unrelated and unadopted local PRs`, async () => {
      const url = 'https://github.com/fixture/repo/pull/42';
      const marker = `🤖 PR created: ${url}`;
      const issue = { id: 'one', identifier: 'JOS-1', title: 'Cloud task', labels: ['execution:cloud'],
        teamKey: 'JOS', comments: [marker], description: null, stateName: 'In Progress' };
      const transitions: string[] = [];
      const snapshots: string[] = [];
      const registry = emptyState();
      registry.tickets['JOS-4'] = { identifier: 'JOS-4', pr: { url } } as any;
      const result = await prHealth({ team: 'JOS' }, {
        loadConfig: () => ({ linear: { agentLabel: 'agent-ready', inReviewState: 'In Review', inProgressState: 'In Progress', doneState: 'Done', todoState: 'Todo' } }) as any,
        checkLifecycle: async () => registry,
        registryFor: () => ({ read: () => registry }) as any,
        fetchFilteredIssues: async () => [
          issue,
          { ...issue, id: 'two', identifier: 'JOS-2', labels: [], comments: [marker] },
          { ...issue, id: 'three', identifier: 'JOS-3', comments: [`Compare ${url}`], description: `Prior art: ${url}` },
          // Registered local work must still pass lifecycle completion verification.
          ...(state === 'MERGED' ? [{ ...issue, id: 'four', identifier: 'JOS-4', labels: [] }] : []),
        ] as any,
        resolveTeamLabels: async () => new Map(),
        getPrSnapshot: prUrl => { snapshots.push(prUrl); return { url: prUrl, state, createdAt: '2026-09-26T00:00:00Z' }; },
        hasCommentWithPrefix: async () => false,
        removeAgentLabel: async () => false,
        transitionIssue: async (id, _team, next) => { transitions.push(`${id}:${next}`); },
        addComment: async () => {},
      });
      assert.equal(result.length, 1);
      assert.equal(result[0].identifier, 'JOS-1');
      assert.deepEqual(transitions, [`one:${state === 'MERGED' ? 'Done' : 'Todo'}`]);
      assert.equal(snapshots.length, state === 'MERGED' ? 2 : 1);
      assert.equal(registry.tickets['JOS-1'], undefined);
    });
  }
});

describe("selectNewestPr", () => {
  it("selects by GitHub creation time instead of Linear storage order", () => {
    const newest = selectNewestPr([
      {
        url: "https://github.com/joshgarza/task-runner/pull/44",
        state: "MERGED",
        createdAt: "2026-08-19T05:00:00Z",
      },
      {
        url: "https://github.com/joshgarza/task-runner/pull/45",
        state: "OPEN",
        createdAt: "2026-08-19T06:00:00Z",
      },
    ]);

    assert.equal(newest?.url, "https://github.com/joshgarza/task-runner/pull/45");
    assert.equal(newest?.state, "OPEN");
  });

  it("returns null when no PR metadata is available", () => {
    assert.equal(selectNewestPr([]), null);
  });
});
