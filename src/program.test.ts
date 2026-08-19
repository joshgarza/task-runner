import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProgram } from "./program.ts";

const EXPECTED_OPTIONS: Record<string, string[]> = {
  run: ["--model", "--reasoning-effort", "--max-attempts", "--dry-run"],
  drain: ["--label", "--project", "--limit", "--concurrency", "--dry-run"],
  review: [],
  standup: ["--days", "--project"],
  "add-ticket": ["--team", "--description", "--labels", "--priority", "--project", "--state"],
  "edit-ticket": [
    "--title",
    "--description",
    "--priority",
    "--labels",
    "--add-labels",
    "--remove-labels",
    "--status",
    "--assignee",
    "--comment",
  ],
  "link-tickets": ["--type"],
  "create-label": ["--team", "--color", "--description"],
  "list-tickets": ["--team", "--status", "--project", "--labels", "--comments"],
  "organize-tickets": [
    "--team",
    "--project",
    "--states",
    "--add-label",
    "--remove-label",
    "--context",
    "--dry-run",
  ],
  "pr-health": ["--team", "--project", "--dry-run"],
  "refine-tickets": ["--team", "--project", "--dry-run"],
};

describe("TaskRunner CLI program", () => {
  it("registers every existing command exactly once", () => {
    const program = createProgram();
    const commandNames = program.commands.map((command) => command.name());

    assert.deepEqual(commandNames, Object.keys(EXPECTED_OPTIONS));
    assert.equal(new Set(commandNames).size, commandNames.length);
  });

  it("preserves each command's option surface", () => {
    const program = createProgram();

    for (const command of program.commands) {
      assert.deepEqual(
        command.options.map((option) => option.long),
        EXPECTED_OPTIONS[command.name()],
        command.name()
      );
    }
  });
});
