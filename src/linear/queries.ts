// Fetch issues, states, comments, labels from Linear

import { getLinearClient } from "./client.ts";
import { collectAllNodes } from "./labels.ts";
import { loadConfig } from "../config.ts";
import type { LinearIssue } from "../types.ts";

let taskRunnerCommentAuthorId: Promise<string> | undefined;

type CommentRecord = {
  body: string;
  authorId?: string;
};

type CommentPage = {
  issue: {
    comments: {
      nodes: Array<{ body: string; user?: { id: string } | null }>;
      pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    };
  };
};

const ISSUE_COMMENTS_QUERY = `
  query TaskRunnerIssueComments($id: String!, $after: String) {
    issue(id: $id) {
      comments(first: 250, after: $after) {
        nodes {
          body
          user { id }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

function getTaskRunnerCommentAuthorId(): Promise<string> {
  if (!taskRunnerCommentAuthorId) {
    const lookup = Promise.resolve(getLinearClient().viewer).then(
      (viewer) => viewer.id
    );
    taskRunnerCommentAuthorId = lookup.catch((error) => {
      taskRunnerCommentAuthorId = undefined;
      throw error;
    });
  }
  return taskRunnerCommentAuthorId;
}

export async function selectCommentBodiesByAuthor(
  allComments: CommentRecord[],
  authorIds: ReadonlySet<string>
): Promise<string[]> {
  return allComments
    .filter((comment) => comment.authorId !== undefined && authorIds.has(comment.authorId))
    .map((comment) => comment.body);
}

async function getTaskRunnerCommentBodies(allComments: CommentRecord[]): Promise<string[]> {
  const currentAuthorId = await getTaskRunnerCommentAuthorId();
  const authorIds = new Set([
    currentAuthorId,
    ...loadConfig().linear.trustedCommentAuthorIds,
  ]);
  return selectCommentBodiesByAuthor(
    allComments,
    authorIds
  );
}

async function fetchIssueCommentRecords(issueId: string): Promise<CommentRecord[]> {
  const client = getLinearClient();
  const comments: CommentRecord[] = [];
  let after: string | undefined;

  do {
    const data = await client.client.request<
      CommentPage,
      { id: string; after?: string }
    >(ISSUE_COMMENTS_QUERY, { id: issueId, after });
    const page = data.issue.comments;
    comments.push(...page.nodes.map((comment) => ({
      body: comment.body,
      authorId: comment.user?.id,
    })));

    if (!page.pageInfo.hasNextPage) break;
    if (!page.pageInfo.endCursor) {
      throw new Error(`Linear comment pagination returned no cursor for ${issueId}`);
    }
    after = page.pageInfo.endCursor;
  } while (true);

  return comments;
}

/**
 * Build a LinearIssue from a raw Linear SDK issue object
 */
async function toLinearIssue(issue: any): Promise<LinearIssue> {
  const state = await issue.state;
  const team = await issue.team;
  const project = await issue.project;
  const labelsConn = await issue.labels({ first: 250 });
  const allLabels = await collectAllNodes(labelsConn);
  const allComments = await fetchIssueCommentRecords(issue.id);
  const allCommentBodies = allComments.map((comment) => comment.body);
  const trustedCommentBodies = await getTaskRunnerCommentBodies(allComments);

  if (!team) {
    throw new Error(`Issue ${issue.identifier} has no team`);
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    teamKey: team.key,
    teamName: team.name,
    stateName: state?.name ?? "Unknown",
    stateId: state?.id ?? "",
    projectName: project?.name ?? null,
    projectId: project?.id ?? null,
    labels: allLabels.map((l: any) => l.name),
    comments: trustedCommentBodies,
    allComments: allCommentBodies,
    url: issue.url,
    branchName: issue.branchName,
  };
}

/**
 * Fetch a single issue by identifier (e.g. "JOS-123")
 */
export async function fetchIssue(identifier: string): Promise<LinearIssue> {
  const client = getLinearClient();

  // Parse identifier (e.g. "JOS-47") into team key and number
  const match = identifier.match(/^([A-Z]+)-(\d+)$/);
  if (!match) {
    throw new Error(`Invalid issue identifier format: ${identifier}. Expected format: TEAM-123`);
  }
  const [, teamKey, number] = match;

  const issues = await client.issues({
    filter: {
      team: { key: { eq: teamKey } },
      number: { eq: parseInt(number, 10) },
    },
    first: 1,
  });

  const issue = issues.nodes[0];
  if (!issue) {
    throw new Error(`Issue not found: ${identifier}`);
  }

  return toLinearIssue(issue);
}

export async function fetchTaskRunnerCommentBodies(issueId: string): Promise<string[]> {
  const allComments = await fetchIssueCommentRecords(issueId);
  return getTaskRunnerCommentBodies(allComments);
}

/**
 * Fetch all issues with a given label, filtered by state and optionally by project name
 */
export async function fetchAgentReadyIssues(
  labelName: string,
  stateNames: string | string[],
  projectName?: string,
  excludedLabelName?: string,
  maxResults?: number
): Promise<LinearIssue[]> {
  if (maxResults !== undefined && maxResults <= 0) return [];

  const client = getLinearClient();

  const filter = buildAgentReadyIssueFilter(
    labelName,
    stateNames,
    projectName,
    excludedLabelName
  );

  const issues = await client.issues({
    filter,
    first: Math.min(maxResults ?? 50, 50),
  });
  const allIssues = await collectAllNodes(issues, maxResults);

  const results: LinearIssue[] = [];
  for (const issue of allIssues) {
    results.push(await toLinearIssue(issue));
  }

  return results;
}

export function buildAgentReadyIssueFilter(
  labelName: string,
  stateNames: string | string[],
  projectName?: string,
  excludedLabelName?: string
): any {
  // Build filter — support single state or multiple states
  const stateFilter = Array.isArray(stateNames)
    ? { name: { in: stateNames } }
    : { name: { eq: stateNames } };

  const filter: any = {
    state: stateFilter,
  };

  if (excludedLabelName) {
    filter.and = [
      { labels: { some: { name: { eq: labelName } } } },
      { labels: { every: { name: { neq: excludedLabelName } } } },
    ];
  } else {
    filter.labels = { name: { eq: labelName } };
  }

  if (projectName) {
    filter.project = { name: { eq: projectName } };
  }

  return filter;
}

/**
 * Fetch issues with a given label that are stuck in a specific state (e.g. "In Progress")
 */
export async function fetchStaleIssues(
  labelName: string,
  stateName: string,
  projectName?: string
): Promise<LinearIssue[]> {
  const client = getLinearClient();

  const filter: any = {
    labels: { name: { eq: labelName } },
    state: { name: { eq: stateName } },
  };

  if (projectName) {
    filter.project = { name: { eq: projectName } };
  }

  const issues = await client.issues({
    filter,
    first: 50,
  });

  const results: LinearIssue[] = [];
  for (const issue of issues.nodes) {
    results.push(await toLinearIssue(issue));
  }

  return results;
}

/**
 * Fetch all issues for a team in specific states, optionally filtered by project
 */
export async function fetchIssuesByTeamAndStates(
  teamKey: string,
  stateNames: string[],
  projectName?: string
): Promise<LinearIssue[]> {
  const client = getLinearClient();

  const filter: any = {
    team: { key: { eq: teamKey } },
    state: { name: { in: stateNames } },
  };

  if (projectName) {
    filter.project = { name: { eq: projectName } };
  }

  const issues = await client.issues({
    filter,
    first: 100,
  });

  const results: LinearIssue[] = [];
  for (const issue of issues.nodes) {
    results.push(await toLinearIssue(issue));
  }

  return results;
}

/**
 * Fetch blocking relations for an issue.
 * Returns issues that block this one, with their completion status.
 */
export async function fetchBlockingRelations(issueId: string): Promise<{
  identifier: string;
  title: string;
  stateName: string;
  done: boolean;
}[]> {
  const client = getLinearClient();
  const issue = await client.issue(issueId);

  const blockers: { identifier: string; title: string; stateName: string; done: boolean }[] = [];
  const seen = new Set<string>();

  // Direct relations: type "blocked_by" means relatedIssue blocks this issue
  const relations = await issue.relations({ first: 250 });
  for (const rel of relations.nodes) {
    if (rel.type === "blocked_by") {
      const related = await rel.relatedIssue;
      if (related && !seen.has(related.id)) {
        seen.add(related.id);
        const state = await related.state;
        blockers.push({
          identifier: related.identifier,
          title: related.title,
          stateName: state?.name ?? "Unknown",
          done: state?.type === "completed" || state?.type === "canceled",
        });
      }
    }
  }

  // Inverse relations: type "blocks" means the source issue blocks this one
  if (typeof issue.inverseRelations === "function") {
    const inverseRelations = await issue.inverseRelations({ first: 250 });
    for (const rel of inverseRelations.nodes) {
      if (rel.type === "blocks") {
        const source = await rel.issue;
        if (source && !seen.has(source.id)) {
          seen.add(source.id);
          const state = await source.state;
          blockers.push({
            identifier: source.identifier,
            title: source.title,
            stateName: state?.name ?? "Unknown",
            done: state?.type === "completed" || state?.type === "canceled",
          });
        }
      }
    }
  }

  return blockers;
}

/**
 * Fetch issues with flexible filtering by team, states, project, and labels.
 * Skips comment fetching unless includeComments is true (for performance).
 */
export async function fetchFilteredIssues(opts: {
  teamKey: string;
  stateNames?: string[];
  projectName?: string;
  labelNames?: string[];
  includeComments?: boolean;
}): Promise<LinearIssue[]> {
  const client = getLinearClient();

  const filter: any = {
    team: { key: { eq: opts.teamKey } },
  };

  if (opts.stateNames && opts.stateNames.length > 0) {
    filter.state = { name: { in: opts.stateNames } };
  }

  if (opts.projectName) {
    filter.project = { name: { eq: opts.projectName } };
  }

  if (opts.labelNames && opts.labelNames.length > 0) {
    filter.labels = { name: { in: opts.labelNames } };
  }

  const issuesConn = await client.issues({
    filter,
    first: 250,
  });
  const allIssueNodes = await collectAllNodes(issuesConn);

  const results: LinearIssue[] = [];
  for (const issue of allIssueNodes) {
    if (opts.includeComments) {
      results.push(await toLinearIssue(issue));
    } else {
      const team = await issue.team;
      if (!team) continue;
      const state = await issue.state;
      const project = await issue.project;
      const labelsConn = await issue.labels({ first: 250 });
      const allLabels = await collectAllNodes(labelsConn);

      results.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? null,
        teamKey: team.key,
        teamName: team.name,
        stateName: state?.name ?? "Unknown",
        stateId: state?.id ?? "",
        projectName: project?.name ?? null,
        projectId: project?.id ?? null,
        labels: allLabels.map((l: any) => l.name),
        comments: [],
        url: issue.url,
        branchName: issue.branchName,
      });
    }
  }

  return results;
}

/**
 * Count how many non-done issues a given issue blocks (forward block count).
 * This is the inverse of fetchBlockingRelations — it finds who *I* block.
 *
 * - Direct relations with type "blocks" → relatedIssue is blocked by this issue
 * - Inverse relations with type "blocked_by" → source issue is blocked by this issue
 * - Only counts issues where state.type is NOT "completed" or "canceled"
 */
export async function fetchForwardBlockCount(issueId: string): Promise<number> {
  const client = getLinearClient();
  const issue = await client.issue(issueId);

  const seen = new Set<string>();
  let count = 0;

  // Direct relations: type "blocks" means relatedIssue is blocked by this issue
  const relations = await issue.relations({ first: 250 });
  for (const rel of relations.nodes) {
    if (rel.type === "blocks") {
      const related = await rel.relatedIssue;
      if (related && !seen.has(related.id)) {
        seen.add(related.id);
        const state = await related.state;
        if (state?.type !== "completed" && state?.type !== "canceled") {
          count++;
        }
      }
    }
  }

  // Inverse relations: type "blocked_by" means the source issue is blocked by this issue
  if (typeof issue.inverseRelations === "function") {
    const inverseRelations = await issue.inverseRelations({ first: 250 });
    for (const rel of inverseRelations.nodes) {
      if (rel.type === "blocked_by") {
        const source = await rel.issue;
        if (source && !seen.has(source.id)) {
          seen.add(source.id);
          const state = await source.state;
          if (state?.type !== "completed" && state?.type !== "canceled") {
            count++;
          }
        }
      }
    }
  }

  return count;
}

/**
 * Fetch recent activity for standup digest
 */
interface RecentActivityFilter {
  updatedAt: { gte: string };
  project?: { name: { eq: string } };
}

export function buildRecentActivityFilter(
  days: number,
  projectName?: string,
  now: number = Date.now()
): RecentActivityFilter {
  const since = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const filter: RecentActivityFilter = {
    updatedAt: { gte: since },
  };

  if (projectName) {
    filter.project = { name: { eq: projectName } };
  }

  return filter;
}

export async function fetchRecentActivity(
  days: number,
  projectName?: string
): Promise<LinearIssue[]> {
  const client = getLinearClient();
  const filter = buildRecentActivityFilter(days, projectName);

  const issues = await client.issues({
    filter,
    first: 100,
  });

  const results: LinearIssue[] = [];
  for (const issue of issues.nodes) {
    const team = await issue.team;
    if (!team) continue;

    const state = await issue.state;
    const project = await issue.project;
    const labelsConn = await issue.labels({ first: 250 });
    const allLabels = await collectAllNodes(labelsConn);

    results.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      teamKey: team.key,
      teamName: team.name,
      stateName: state?.name ?? "Unknown",
      stateId: state?.id ?? "",
      projectName: project?.name ?? null,
      projectId: project?.id ?? null,
      labels: allLabels.map((l: any) => l.name),
      comments: [],
      url: issue.url,
      branchName: issue.branchName,
    });
  }

  return results;
}
