// Request a native Codex review on an existing GitHub pull request.

import { addPRComment } from "../git/branch.ts";
import { log } from "../logger.ts";

export const CODEX_REVIEW_MENTION = "@codex review";

export interface NativeReviewRequestResult {
  requested: boolean;
  attempts: number;
  error?: string;
}

export interface NativeReviewRequestDependencies {
  addPRComment: typeof addPRComment;
  delay: (ms: number) => Promise<void>;
  log: typeof log;
}

const defaultDependencies: NativeReviewRequestDependencies = {
  addPRComment,
  delay: (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
  log,
};

export async function requestCodexReview(
  prUrl: string,
  context = "review",
  deps: NativeReviewRequestDependencies = defaultDependencies
): Promise<NativeReviewRequestResult> {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(prUrl)) {
    throw new Error(`Invalid PR URL: ${prUrl}`);
  }

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      deps.addPRComment(prUrl, CODEX_REVIEW_MENTION);
      deps.log("OK", context, `Requested native Codex review: ${prUrl}`);
      return { requested: true, attempts: attempt };
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(
        "WARN",
        context,
        `Codex review request attempt ${attempt}/${maxAttempts} failed: ${message}`
      );
      if (attempt < maxAttempts) {
        await deps.delay(1000);
      } else {
        return { requested: false, attempts: attempt, error: message };
      }
    }
  }

  return { requested: false, attempts: maxAttempts, error: "Review request failed" };
}
