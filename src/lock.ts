// File-based lock with TTL (adapted from research/automation/worker.ts)

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const LOGS_DIR = resolve(import.meta.dirname, "..", "logs");
const LOCK_PATH = resolve(LOGS_DIR, "worker.lock");
const LOCK_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function acquireLock(): boolean {
  if (existsSync(LOCK_PATH)) {
    const lockContent = readFileSync(LOCK_PATH, "utf-8");
    const lockTime = parseInt(lockContent, 10);
    if (Date.now() - lockTime < LOCK_TTL_MS) {
      console.error("Worker already running (lock held). Skipping.");
      return false;
    }
    console.log("Stale lock found, removing.");
    unlinkSync(LOCK_PATH);
  }
  writeFileSync(LOCK_PATH, Date.now().toString());
  return true;
}

export function releaseLock(): void {
  if (existsSync(LOCK_PATH)) {
    unlinkSync(LOCK_PATH);
  }
}
