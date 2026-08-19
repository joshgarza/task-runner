import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRecentActivityFilter } from "./queries.ts";

describe("buildRecentActivityFilter", () => {
  it("uses an ISO timestamp and preserves the optional project filter", () => {
    const now = Date.parse("2026-08-19T18:30:00.000Z");

    assert.deepEqual(buildRecentActivityFilter(2, "task-runner", now), {
      updatedAt: { gte: "2026-08-17T18:30:00.000Z" },
      project: { name: { eq: "task-runner" } },
    });
  });
});
