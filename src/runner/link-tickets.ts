// Create a blocking relation between two Linear issues

import { fetchIssue } from "../linear/queries.ts";
import { createRelation } from "../linear/mutations.ts";
import { log } from "../logger.ts";

const VALID_TYPES = ["blocks", "duplicate", "related"] as const;

export async function linkTickets(
  identifierA: string,
  identifierB: string,
  type: string = "blocks"
): Promise<void> {
  if (!VALID_TYPES.includes(type as any)) {
    throw new Error(`Invalid relation type: ${type}. Must be one of: ${VALID_TYPES.join(", ")}`);
  }

  log("INFO", "link-tickets", `Fetching ${identifierA} and ${identifierB}`);

  const [issueA, issueB] = await Promise.all([
    fetchIssue(identifierA),
    fetchIssue(identifierB),
  ]);

  await createRelation(issueA.id, issueB.id, type);

  log("OK", "link-tickets", `Linked: ${issueA.identifier} ${type} ${issueB.identifier}`);
}
