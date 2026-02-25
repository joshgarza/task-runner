// LinearClient singleton from LINEAR_API_KEY

import { LinearClient } from "@linear/sdk";
import { getLinearApiKey } from "../config.ts";

let client: LinearClient | null = null;

export function getLinearClient(): LinearClient {
  if (!client) {
    client = new LinearClient({ apiKey: getLinearApiKey() });
  }
  return client;
}
