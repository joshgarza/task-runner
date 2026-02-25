// Tests for drain concurrency pool behavior
// Run: node --experimental-strip-types --test src/runner/drain.test.ts

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// We can't easily mock ES module imports, so we test the pool logic directly
// by extracting the same pattern used in drain.ts

interface MockIssue {
  id: string;
  startedAt?: number;
  finishedAt?: number;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (concurrency <= 1) {
    for (const item of items) {
      await fn(item);
    }
    return;
  }

  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.allSettled(workers);
}

describe("runWithConcurrency", () => {
  it("processes all items with concurrency=1 (sequential)", async () => {
    const processed: string[] = [];
    const items = ["a", "b", "c"];

    await runWithConcurrency(items, 1, async (item) => {
      processed.push(item);
    });

    assert.deepEqual(processed, ["a", "b", "c"]);
  });

  it("processes all items with concurrency > item count", async () => {
    const processed: string[] = [];
    const items = ["a", "b"];

    await runWithConcurrency(items, 10, async (item) => {
      processed.push(item);
    });

    assert.equal(processed.length, 2);
    assert.ok(processed.includes("a"));
    assert.ok(processed.includes("b"));
  });

  it("runs tasks in parallel when concurrency > 1", async () => {
    const timeline: { id: string; event: "start" | "end"; time: number }[] = [];
    const items = ["a", "b", "c", "d"];

    await runWithConcurrency(items, 2, async (item) => {
      const start = Date.now();
      timeline.push({ id: item, event: "start", time: start });
      await new Promise((r) => setTimeout(r, 50));
      timeline.push({ id: item, event: "end", time: Date.now() });
    });

    // All 4 items should be processed
    const starts = timeline.filter((e) => e.event === "start");
    const ends = timeline.filter((e) => e.event === "end");
    assert.equal(starts.length, 4);
    assert.equal(ends.length, 4);

    // With concurrency=2, at least 2 items should start before the first one ends
    // Sort by time to check overlap
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

  it("handles errors in individual tasks without stopping others", async () => {
    const processed: string[] = [];
    const items = ["a", "b", "c"];

    await runWithConcurrency(items, 2, async (item) => {
      if (item === "b") throw new Error("fail");
      processed.push(item);
    });

    // "a" and "c" should still be processed even though "b" threw.
    // The worker that hit "b" will stop, but the other worker continues.
    // With concurrency=2: worker1 gets "a", worker2 gets "b" (throws, stops),
    // worker1 continues with "c"
    assert.ok(processed.includes("a"), "a should be processed");
    assert.ok(processed.includes("c"), "c should be processed");
    assert.ok(!processed.includes("b"), "b should not be in processed");
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
    const processed: string[] = [];

    await runWithConcurrency([], 3, async (item: string) => {
      processed.push(item);
    });

    assert.equal(processed.length, 0);
  });
});
