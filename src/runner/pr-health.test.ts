import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPrUrls, selectNewestPr } from "./pr-health.ts";

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
        "PR created: https://github.com/joshgarza/task-runner/pull/41",
        "retry: https://github.com/joshgarza/task-runner/pull/42",
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
        ["PR created: https://github.com/joshgarza/task-runner/pull/44"],
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
