// Create a new Linear label from CLI arguments

import { createLabel as createLabelMutation } from "../linear/mutations.ts";
import { log } from "../logger.ts";

export interface CreateLabelOptions {
  team?: string;
  color?: string;
  description?: string;
}

export async function createLabel(
  name: string,
  opts: CreateLabelOptions
): Promise<{ name: string; id: string }> {
  const scope = opts.team ? `team ${opts.team}` : "workspace";
  log("INFO", "create-label", `Creating label "${name}" in ${scope}`);

  const result = await createLabelMutation({
    name,
    teamKey: opts.team,
    color: opts.color,
    description: opts.description,
  });

  log("OK", "create-label", `Created label "${result.name}" (${result.id})`);
  return result;
}
