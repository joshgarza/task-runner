import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCloudDelegationComment,
  isHumanGatedRoute,
  resolveExecutionRoute,
} from "./execution-route.ts";

describe("resolveExecutionRoute", () => {
  it("defaults unlabeled tickets to local Codex", () => {
    assert.deepEqual(resolveExecutionRoute(["agent-ready"]), {
      route: "local",
      label: null,
      reason: "No execution label, defaulting to local Codex",
    });
  });

  it("routes explicitly labeled local work", () => {
    assert.equal(resolveExecutionRoute(["execution:local"]).route, "local");
  });

  it("routes cloud work through the native integration", () => {
    assert.equal(resolveExecutionRoute(["agent-ready", "execution:cloud"]).route, "cloud");
  });

  it("marks ops work as human gated", () => {
    const resolution = resolveExecutionRoute(["execution:ops"]);
    assert.equal(resolution.route, "ops");
    assert.equal(isHumanGatedRoute(resolution.route), true);
  });

  it("fails closed for unknown routes", () => {
    assert.throws(
      () => resolveExecutionRoute(["execution:remote"]),
      /Unknown execution route/
    );
  });

  it("fails closed for conflicting route labels", () => {
    assert.throws(
      () => resolveExecutionRoute(["execution:local", "execution:cloud"]),
      /conflicting execution labels/
    );
  });
});

describe("buildCloudDelegationComment", () => {
  it("mentions Codex and pins the target repository", () => {
    const comment = buildCloudDelegationComment("joshgarza/task-runner");
    assert.match(comment, /^@Codex implement this issue in joshgarza\/task-runner\./);
    assert.match(comment, /pull request link back to this issue/);
  });

  it("lets Linear choose the configured repository when no GitHub remote is available", () => {
    assert.match(
      buildCloudDelegationComment(null),
      /repository selected for this Linear issue/
    );
  });
});
