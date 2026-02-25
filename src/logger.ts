// Structured console + file logging

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { LogLevel } from "./types.ts";

const LOGS_DIR = resolve(import.meta.dirname, "..", "logs");
const WORKER_LOG = resolve(LOGS_DIR, "task-runner.log");

// Ensure logs directory exists
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

export function log(level: LogLevel, context: string | null, message: string): void {
  const ts = new Date().toISOString();
  const prefix = context ? `[${context}]` : "[runner]";
  const line = `${ts} ${level.padEnd(5)} ${prefix} ${message}`;
  console.log(line);
  appendFileSync(WORKER_LOG, line + "\n");
}

export function logToFile(filename: string, data: unknown): void {
  const filepath = resolve(LOGS_DIR, filename);
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  appendFileSync(filepath, content);
}
