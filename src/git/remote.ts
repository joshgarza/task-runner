import { execGit } from "./exec.ts";
import { resolveGitDir } from "./worktree.ts";

export function parseGitHubRepositoryUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const match = trimmed.match(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/
  );
  return match?.[1] ?? null;
}

export function getGitHubRepository(repoPath: string): string | null {
  try {
    const gitDir = resolveGitDir(repoPath);
    const remoteUrl = execGit(["remote", "get-url", "origin"], {
      cwd: gitDir,
      timeout: 10_000,
    });
    return parseGitHubRepositoryUrl(remoteUrl);
  } catch {
    return null;
  }
}
