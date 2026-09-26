import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { standup } from "./standup.ts";
import { emptyState, lifecycleConfig } from "../lifecycle/model.ts";
import type { TaskRunnerConfig } from "../types.ts";
const fixtureLifecycle = () => ({
  config: { lifecycle: lifecycleConfig(), linear: { agentLabel: "agent-ready" } } as TaskRunnerConfig,
  state: emptyState(),
});

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

    await standup({ days: 3 }, async () => [], fixtureLifecycle);

    assert.ok(output.some((line) => line.includes("No activity in the last 3 day(s).")));
  });
});

it("reports lifecycle holds even with no recent Linear activity", async (t) => {
  const output: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { output.push(args.join(" ")); });
  const fixture = fixtureLifecycle();
  fixture.state.disk = { held: true, reasons: ["Windows backing volume below stop threshold"] };
  await standup({ days: 1 }, async () => [], () => fixture);
  assert.ok(output.some(line => line.includes("Windows backing volume below stop threshold")));
  assert.ok(output.some(line => line.includes("No activity")));
});
