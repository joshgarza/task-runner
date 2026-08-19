import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGitHubRepositoryUrl } from "./remote.ts";

describe("parseGitHubRepositoryUrl", () => {
  it("parses HTTPS remotes", () => {
    assert.equal(
      parseGitHubRepositoryUrl("https://github.com/joshgarza/task-runner.git"),
      "joshgarza/task-runner"
    );
  });

  it("parses SCP-style SSH remotes", () => {
    assert.equal(
      parseGitHubRepositoryUrl("git@github.com:joshgarza/task-runner.git"),
      "joshgarza/task-runner"
    );
  });

  it("parses ssh URLs", () => {
    assert.equal(
      parseGitHubRepositoryUrl("ssh://git@github.com/joshgarza/task-runner.git"),
      "joshgarza/task-runner"
    );
  });

  it("rejects non-GitHub remotes", () => {
    assert.equal(parseGitHubRepositoryUrl("https://gitlab.com/example/repo.git"), null);
  });
});
