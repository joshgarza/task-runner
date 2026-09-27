// Tests for the shared runWithConcurrency worker pool
// Run: node --experimental-strip-types --test src/runner/drain.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runWithConcurrency } from "../concurrency.ts";
import { formatSuccessfulRun, isLocalStaleIssue, processDrainIssue, prioritizeIssues } from "./drain.ts";

describe("runWithConcurrency", () => {
  it("processes all items with concurrency=1 (sequential)", async () => {
    const processed: string[] = [];
    const items = ["a", "b", "c"];

    await runWithConcurrency(items, 1, async (item) => {
      processed.push(item);
      return item;
    });

    assert.deepEqual(processed, ["a", "b", "c"]);
  });

  it("returns results in input order regardless of concurrency", async () => {
    const items = [3, 1, 2]; // delays in ms * 10

    const results = await runWithConcurrency(items, 3, async (delay) => {
      await new Promise((r) => setTimeout(r, delay * 10));
      return `done-${delay}`;
    });

    // Results must match input order, not completion order
    assert.deepEqual(results, ["done-3", "done-1", "done-2"]);
  });

  it("processes all items with concurrency > item count", async () => {
    const items = ["a", "b"];

    const results = await runWithConcurrency(items, 10, async (item) => {
      return item.toUpperCase();
    });

    assert.equal(results.length, 2);
    assert.deepEqual(results, ["A", "B"]);
  });

  it("runs tasks in parallel when concurrency > 1", async () => {
    const timeline: { id: string; event: "start" | "end"; time: number }[] = [];
    const items = ["a", "b", "c", "d"];

    await runWithConcurrency(items, 2, async (item) => {
      const start = Date.now();
      timeline.push({ id: item, event: "start", time: start });
      await new Promise((r) => setTimeout(r, 50));
      timeline.push({ id: item, event: "end", time: Date.now() });
      return item;
    });

    // All 4 items should be processed
    const starts = timeline.filter((e) => e.event === "start");
    const ends = timeline.filter((e) => e.event === "end");
    assert.equal(starts.length, 4);
    assert.equal(ends.length, 4);

    // With concurrency=2, at least 2 items should start before the first one ends
    const sortedStarts = starts.sort((a, b) => a.time - b.time);
    const firstEnd = ends.sort((a, b) => a.time - b.time)[0];

    const startsBeforeFirstEnd = sortedStarts.filter(
      (s) => s.time <= firstEnd.time
    );
    assert.ok(
      startsBeforeFirstEnd.length >= 2,
      `Expected >= 2 starts before first end, got ${startsBeforeFirstEnd.length}`
    );
  });

  it("a throwing fn kills only that worker — other workers continue", async () => {
    const processed: string[] = [];
    const items = ["a", "b", "c"];

    // Note: in production, drain's processIssue catches internally and never
    // throws. This test documents the raw pool behavior: a throwing fn stops
    // only the worker that hit the error, not the entire pool.
    const results = await runWithConcurrency(items, 2, async (item) => {
      if (item === "b") throw new Error("fail");
      processed.push(item);
      return item;
    });

    // "a" and "c" should still be processed even though "b" threw.
    assert.ok(processed.includes("a"), "a should be processed");
    assert.ok(processed.includes("c"), "c should be processed");
    assert.ok(!processed.includes("b"), "b should not be in processed");

    // The result slot for "b" is undefined because the worker died before assigning
    assert.equal(results[0], "a");
    assert.equal(results[1], undefined);
    assert.equal(results[2], "c");
  });

  it("respects concurrency limit", async () => {
    let running = 0;
    let maxRunning = 0;
    const items = ["a", "b", "c", "d", "e", "f"];

    await runWithConcurrency(items, 3, async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return null;
    });

    assert.ok(
      maxRunning <= 3,
      `Max concurrent should be <= 3, was ${maxRunning}`
    );
    assert.ok(
      maxRunning >= 2,
      `Max concurrent should be >= 2 with 6 items and concurrency=3, was ${maxRunning}`
    );
  });

  it("handles empty item list", async () => {
    const results = await runWithConcurrency([], 3, async (item: string) => {
      return item;
    });

    assert.equal(results.length, 0);
  });
});

describe("drain route reporting", () => {
  it("passes the active custom queue label into the issue pipeline", async () => {
    let invocations = 0;
    const result = await processDrainIssue({ identifier: "JOS-294", title: "Fixture" }, "custom-ready", async (identifier, options) => {
      invocations++;
      assert.equal(identifier, "JOS-294");
      assert.deepEqual(options, { queueLabel: "custom-ready" });
      return { issueId: identifier, success: false, error: "fixture", durationMs: 0, attempts: 1 };
    });
    assert.equal(invocations, 1);
    assert.equal(result.success, false);
  });
  it("reports cloud delegation without claiming a PR was created", () => {
    assert.equal(
      formatSuccessfulRun({
        issueId: "JOS-1",
        success: true,
        executionRoute: "cloud",
        durationMs: 1,
        attempts: 0,
      }),
      "Cloud delegation complete"
    );
  });

  it("reports the PR for successful local work", () => {
    assert.equal(
      formatSuccessfulRun({
        issueId: "JOS-1",
        success: true,
        executionRoute: "local",
        prUrl: "https://github.com/joshgarza/task-runner/pull/45",
        durationMs: 1,
        attempts: 1,
      }),
      "Pipeline complete: PR https://github.com/joshgarza/task-runner/pull/45"
    );
  });

  it("excludes delegated cloud work from local stale warnings", () => {
    assert.equal(isLocalStaleIssue({ labels: ["agent-ready", "execution:cloud"] }), false);
    assert.equal(isLocalStaleIssue({ labels: ["agent-ready", "execution:local"] }), true);
  });
});

describe('scheduled lifecycle evaluation', () => {
  it('checks global lifecycle before and after a completely empty drain', async () => {
    const { drain } = await import('./drain.ts');
    const { emptyState, lifecycleConfig } = await import('../lifecycle/model.ts');
    const events: string[] = [];
    const config = { projects: {}, lifecycle: lifecycleConfig(), defaults: { drainConcurrency: 1, maxDrainFailures: 2 },
      linear: { agentLabel: 'default', agentFailedLabel: 'failed', inProgressState: 'In Progress', inReviewState: 'In Review', todoState: 'Todo' } } as any;
    const results = await drain({ label: 'custom-queue', dryRun: false }, {
      loadConfig: () => config,
      checkLifecycle: async c => { assert.equal(c, config); events.push('check'); return emptyState(); },
      acquireLock: () => { events.push('lock'); return true; },
      releaseLock: () => { events.push('release'); },
    });
    assert.deepEqual(results, []); assert.deepEqual(events, ['check', 'lock', 'release', 'check']);
  });
});

describe('lifecycle priority ordering', () => {
  const queue = () => ['JOS-1', 'JOS-2', 'JOS-3', 'JOS-4'].map(identifier => ({ id: identifier, identifier, title: identifier })) as any;
  it('keeps authorized priorities when dependency metadata is unavailable', async () => {
    const issues = queue();
    await prioritizeIssues(issues, { 'JOS-3': { priority: 1 }, 'JOS-1': { priority: 0 } }, async id => {
      if (id === 'JOS-2') throw new Error('Linear unavailable');
      return 10;
    });
    assert.deepEqual(issues.map((i: any) => i.identifier), ['JOS-3', 'JOS-1', 'JOS-2', 'JOS-4']);
  });
  it('uses dependencies and then original order within an authorized priority', async () => {
    const issues = queue();
    await prioritizeIssues(issues, { 'JOS-3': { priority: 1 } }, async id => id === 'JOS-4' ? 10 : 0);
    assert.deepEqual(issues.map((i: any) => i.identifier), ['JOS-3', 'JOS-4', 'JOS-1', 'JOS-2']);
  });
});
