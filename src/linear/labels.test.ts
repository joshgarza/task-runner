// Tests for computeLabelDiff pure set-arithmetic
// Run: node --experimental-strip-types --test src/linear/labels.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLabelDiff } from "./labels.ts";

describe("computeLabelDiff", () => {
  const teamLabels = new Map([
    ["agent-ready", "id-agent-ready"],
    ["agent:worker", "id-agent-worker"],
    ["needs-review", "id-needs-review"],
    ["blocked", "id-blocked"],
  ]);

  it("adds a label not already present", () => {
    const result = computeLabelDiff(
      ["id-existing"],
      teamLabels,
      ["agent-ready"],
      []
    );

    assert.deepEqual(result.labelsAdded, ["agent-ready"]);
    assert.deepEqual(result.labelsRemoved, []);
    assert.ok(result.newLabelIds.includes("id-agent-ready"));
    assert.ok(result.newLabelIds.includes("id-existing"));
  });

  it("removes a label that is present", () => {
    const result = computeLabelDiff(
      ["id-agent-ready", "id-existing"],
      teamLabels,
      [],
      ["agent-ready"]
    );

    assert.deepEqual(result.labelsAdded, []);
    assert.deepEqual(result.labelsRemoved, ["agent-ready"]);
    assert.ok(!result.newLabelIds.includes("id-agent-ready"));
    assert.ok(result.newLabelIds.includes("id-existing"));
  });

  it("skips adding a label already present", () => {
    const result = computeLabelDiff(
      ["id-agent-ready", "id-existing"],
      teamLabels,
      ["agent-ready"],
      []
    );

    assert.deepEqual(result.labelsAdded, []);
    assert.deepEqual(result.labelsRemoved, []);
    assert.equal(result.newLabelIds.length, 2);
  });

  it("skips removing a label not present", () => {
    const result = computeLabelDiff(
      ["id-existing"],
      teamLabels,
      [],
      ["agent-ready"]
    );

    assert.deepEqual(result.labelsAdded, []);
    assert.deepEqual(result.labelsRemoved, []);
    assert.deepEqual(result.newLabelIds, ["id-existing"]);
  });

  it("silently skips labels not found in teamLabels", () => {
    const result = computeLabelDiff(
      ["id-existing"],
      teamLabels,
      ["nonexistent-label"],
      ["also-missing"]
    );

    assert.deepEqual(result.labelsAdded, []);
    assert.deepEqual(result.labelsRemoved, []);
    assert.deepEqual(result.newLabelIds, ["id-existing"]);
  });

  it("handles add and remove in the same call", () => {
    const result = computeLabelDiff(
      ["id-agent-ready", "id-existing"],
      teamLabels,
      ["needs-review"],
      ["agent-ready"]
    );

    assert.deepEqual(result.labelsAdded, ["needs-review"]);
    assert.deepEqual(result.labelsRemoved, ["agent-ready"]);
    assert.ok(result.newLabelIds.includes("id-needs-review"));
    assert.ok(result.newLabelIds.includes("id-existing"));
    assert.ok(!result.newLabelIds.includes("id-agent-ready"));
  });

  it("handles multiple adds and removes", () => {
    const result = computeLabelDiff(
      ["id-agent-ready", "id-agent-worker"],
      teamLabels,
      ["needs-review", "blocked"],
      ["agent-ready", "agent:worker"]
    );

    assert.deepEqual(result.labelsAdded, ["needs-review", "blocked"]);
    assert.deepEqual(result.labelsRemoved, ["agent-ready", "agent:worker"]);
    assert.deepEqual(result.newLabelIds.sort(), ["id-blocked", "id-needs-review"]);
  });

  it("handles empty inputs", () => {
    const result = computeLabelDiff([], teamLabels, [], []);

    assert.deepEqual(result.labelsAdded, []);
    assert.deepEqual(result.labelsRemoved, []);
    assert.deepEqual(result.newLabelIds, []);
  });

  it("handles empty teamLabels map", () => {
    const result = computeLabelDiff(
      ["id-existing"],
      new Map(),
      ["agent-ready"],
      ["blocked"]
    );

    assert.deepEqual(result.labelsAdded, []);
    assert.deepEqual(result.labelsRemoved, []);
    assert.deepEqual(result.newLabelIds, ["id-existing"]);
  });

  it("preserves unrelated label IDs", () => {
    const result = computeLabelDiff(
      ["id-unrelated-1", "id-unrelated-2", "id-agent-ready"],
      teamLabels,
      [],
      ["agent-ready"]
    );

    assert.deepEqual(result.labelsRemoved, ["agent-ready"]);
    assert.ok(result.newLabelIds.includes("id-unrelated-1"));
    assert.ok(result.newLabelIds.includes("id-unrelated-2"));
    assert.ok(!result.newLabelIds.includes("id-agent-ready"));
    assert.equal(result.newLabelIds.length, 2);
  });

  it("does not add duplicate IDs when same name appears twice in addNames", () => {
    const result = computeLabelDiff(
      [],
      teamLabels,
      ["agent-ready", "agent-ready"],
      []
    );

    // Only first occurrence triggers the add (second is already in set)
    assert.deepEqual(result.labelsAdded, ["agent-ready"]);
    assert.equal(result.newLabelIds.length, 1);
    assert.deepEqual(result.newLabelIds, ["id-agent-ready"]);
  });
});
