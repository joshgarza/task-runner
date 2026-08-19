import type { Command } from "commander";
import { registerRunCommand } from "./run.ts";
import { registerDrainCommand } from "./drain.ts";
import { registerReviewCommand } from "./review.ts";
import { registerStandupCommand } from "./standup.ts";
import { registerAddTicketCommand } from "./add-ticket.ts";
import { registerEditTicketCommand } from "./edit-ticket.ts";
import { registerLinkTicketsCommand } from "./link-tickets.ts";
import { registerCreateLabelCommand } from "./create-label.ts";
import { registerListTicketsCommand } from "./list-tickets.ts";
import { registerOrganizeTicketsCommand } from "./organize-tickets.ts";
import { registerPrHealthCommand } from "./pr-health.ts";
import { registerRefineTicketsCommand } from "./refine-tickets.ts";

type CommandRegistrar = (program: Command) => void;

const commandRegistrars: CommandRegistrar[] = [
  registerRunCommand,
  registerDrainCommand,
  registerReviewCommand,
  registerStandupCommand,
  registerAddTicketCommand,
  registerEditTicketCommand,
  registerLinkTicketsCommand,
  registerCreateLabelCommand,
  registerListTicketsCommand,
  registerOrganizeTicketsCommand,
  registerPrHealthCommand,
  registerRefineTicketsCommand,
];

export function registerCommands(program: Command): void {
  for (const registerCommand of commandRegistrars) {
    registerCommand(program);
  }
}
