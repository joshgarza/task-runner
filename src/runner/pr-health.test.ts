import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPrUrls } from "./pr-health.ts";

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

  it("ignores comments without a GitHub pull request URL", () => {
    assert.deepEqual(extractPrUrls(["Agent starting work", "Validation passed"]), []);
  });
});
