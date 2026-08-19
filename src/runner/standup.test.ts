import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { standup } from "./standup.ts";

describe("standup activity query", () => {
  it("reports query failures distinctly from an empty activity result", async (t) => {
    t.mock.method(console, "log", () => {});

    await assert.rejects(
      standup({ days: 3, project: "task-runner" }, async () => {
        throw new Error("invalid updatedAt filter");
      }),
      /Failed to query Linear activity: invalid updatedAt filter/
    );
  });

  it("retains the no-activity result for a successful empty query", async (t) => {
    const output: string[] = [];
    t.mock.method(console, "log", (...args: unknown[]) => {
      output.push(args.join(" "));
    });

    await standup({ days: 3 }, async () => []);

    assert.ok(output.some((line) => line.includes("No activity in the last 3 day(s).")));
  });
});
