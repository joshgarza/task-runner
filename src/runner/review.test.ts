import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CODEX_REVIEW_MENTION, requestCodexReview } from "./review.ts";

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
});
