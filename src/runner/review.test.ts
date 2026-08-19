import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_REVIEW_MENTION,
  normalizeGitHubPullRequestUrl,
  requestCodexReview,
} from "./review.ts";

describe("requestCodexReview", () => {
  it("requests a standard GitHub Codex review", async () => {
    const comments: { url: string; body: string }[] = [];
    const result = await requestCodexReview(
      "https://github.com/joshgarza/task-runner/pull/45",
      "JOS-200",
      {
        addPRComment: (url, body) => comments.push({ url, body }),
        delay: async () => {},
        log: () => {},
      }
    );

    assert.deepEqual(result, { requested: true, attempts: 1 });
    assert.deepEqual(comments, [{
      url: "https://github.com/joshgarza/task-runner/pull/45",
      body: CODEX_REVIEW_MENTION,
    }]);
  });

  it("retries one failed GitHub comment", async () => {
    let attempts = 0;
    const result = await requestCodexReview(
      "https://github.com/joshgarza/task-runner/pull/45",
      "JOS-200",
      {
        addPRComment: () => {
          attempts++;
          if (attempts === 1) throw new Error("temporary GitHub error");
        },
        delay: async () => {},
        log: () => {},
      }
    );

    assert.deepEqual(result, { requested: true, attempts: 2 });
  });

  it("normalizes browser-form pull request URLs before commenting", async () => {
    const urls: string[] = [];

    for (const prUrl of [
      "https://github.com/joshgarza/task-runner/pull/45/",
      "https://github.com/joshgarza/task-runner/pull/45/files",
      "https://github.com/joshgarza/task-runner/pull/45/commits?after=abc#diff-file",
    ]) {
      await requestCodexReview(prUrl, "JOS-200", {
        addPRComment: (url) => urls.push(url),
        delay: async () => {},
        log: () => {},
      });
    }

    assert.deepEqual(urls, [
      "https://github.com/joshgarza/task-runner/pull/45",
      "https://github.com/joshgarza/task-runner/pull/45",
      "https://github.com/joshgarza/task-runner/pull/45",
    ]);
  });

  it("returns a failure result after both attempts fail", async () => {
    const result = await requestCodexReview(
      "https://github.com/joshgarza/task-runner/pull/45",
      "JOS-200",
      {
        addPRComment: () => { throw new Error("GitHub unavailable"); },
        delay: async () => {},
        log: () => {},
      }
    );

    assert.deepEqual(result, {
      requested: false,
      attempts: 2,
      error: "GitHub unavailable",
    });
  });

  it("rejects non-GitHub pull request URLs", async () => {
    await assert.rejects(
      requestCodexReview("https://example.com/pull/1"),
      /Invalid PR URL/
    );
  });

  it("rejects GitHub URLs that are not pull requests", () => {
    assert.throws(
      () => normalizeGitHubPullRequestUrl("https://github.com/joshgarza/task-runner/issues/45"),
      /Invalid PR URL/
    );
  });
});
