import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRetainedLabelIds } from "./refine-tickets.ts";

const labels = [
  { id: "ready", name: "agent-ready" },
  { id: "legacy", name: "agent:worker" },
  { id: "route", name: "execution:local" },
  { id: "priority", name: "priority:high" },
];

describe("getRetainedLabelIds", () => {
  it("removes legacy and prior execution labels for every route", () => {
    assert.deepEqual(
      getRetainedLabelIds(labels, "local", "agent-ready"),
      ["ready", "priority"]
    );
  });

  it("also removes the configured ready label for human-gated ops", () => {
    assert.deepEqual(
      getRetainedLabelIds(labels, "ops", "agent-ready"),
      ["priority"]
    );
  });
});
