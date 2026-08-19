import { Command } from "commander";
import { registerCommands } from "./commands/index.ts";

export function createProgram(): Command {
  const program = new Command()
    .name("task-runner")
    .description("Linear-powered routing for local and cloud Codex execution")
    .version("0.1.0");

  registerCommands(program);
  return program;
}
