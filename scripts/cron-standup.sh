#!/usr/bin/env bash
# cron-standup.sh — Runs task-runner standup on a cron schedule.
# Intended to be called once daily (e.g. 9 AM) via crontab.

set -euo pipefail

# ── Paths ───────────────────────────────────────────────────────────
TASK_RUNNER_DIR="/home/josh/coding/claude/task-runner/main"
LOG_FILE="$TASK_RUNNER_DIR/logs/standup-cron.log"

# ── Environment ─────────────────────────────────────────────────────
# cron starts with a minimal PATH; add the tools we need.
export PATH="/home/josh/.nvm/versions/node/v24.12.0/bin:/home/josh/.local/bin:/usr/bin:/usr/local/bin:$PATH"

# Source secrets (LINEAR_API_KEY, etc.)
if [ -f "$TASK_RUNNER_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$TASK_RUNNER_DIR/.env"
  set +a
fi

# ── Ensure log directory exists ─────────────────────────────────────
mkdir -p "$(dirname "$LOG_FILE")"

# ── Run ─────────────────────────────────────────────────────────────
cd "$TASK_RUNNER_DIR"

{
  echo "=== standup started at $(date -Iseconds) ==="
  rc=0
  node --experimental-strip-types src/cli.ts standup 2>&1 || rc=$?
  echo "=== standup finished at $(date -Iseconds) exit=$rc ==="
  echo ""
} >> "$LOG_FILE" 2>&1
exit $rc
