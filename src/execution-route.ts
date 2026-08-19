export const EXECUTION_LABEL_PREFIX = "execution:";
export const EXECUTION_ROUTES = ["local", "cloud", "ops"] as const;

export type ExecutionRoute = typeof EXECUTION_ROUTES[number];

export interface ExecutionRouteResolution {
  route: ExecutionRoute;
  label: string | null;
  reason: string;
}

export function resolveExecutionRoute(
  labels: string[]
): ExecutionRouteResolution {
  const routeLabels = labels.filter((label) => label.startsWith(EXECUTION_LABEL_PREFIX));

  if (routeLabels.length === 0) {
    return {
      route: "local",
      label: null,
      reason: "No execution label, defaulting to local Codex",
    };
  }

  if (routeLabels.length > 1) {
    throw new Error(`Issue has conflicting execution labels: ${routeLabels.join(", ")}`);
  }

  const label = routeLabels[0];
  const route = label.slice(EXECUTION_LABEL_PREFIX.length);
  if (!EXECUTION_ROUTES.includes(route as ExecutionRoute)) {
    throw new Error(
      `Unknown execution route "${route}". Expected one of: ${EXECUTION_ROUTES.join(", ")}`
    );
  }

  return {
    route: route as ExecutionRoute,
    label,
    reason: `Matched label "${label}"`,
  };
}

export function isHumanGatedRoute(route: ExecutionRoute): boolean {
  return route === "ops";
}

export function buildCloudDelegationComment(repository: string | null): string {
  const repositoryInstruction = repository
    ? ` in ${repository}`
    : " in the repository selected for this Linear issue";

  return [
    `@Codex implement this issue${repositoryInstruction}.`,
    "",
    "Follow the ticket requirements and repository instructions. Keep the change focused, run the configured validation, and post the completed cloud chat or pull request link back to this issue.",
  ].join("\n");
}
